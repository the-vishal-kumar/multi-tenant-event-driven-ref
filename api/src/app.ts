import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { AuthError, type Principal, type Verifier } from './auth';
import { UnknownTenantError, type OrderInput, type OrdersRepo } from './orders';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Printable ASCII, no spaces; long enough for a UUID or a client-chosen key.
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

const orderBody = {
  type: 'object',
  additionalProperties: false,
  required: ['currency', 'items'],
  properties: {
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sku', 'quantity', 'unit_price_cents'],
        properties: {
          sku: { type: 'string', minLength: 1, maxLength: 64 },
          quantity: { type: 'integer', minimum: 1, maximum: 1000 },
          unit_price_cents: { type: 'integer', minimum: 0, maximum: 10_000_000 },
        },
      },
    },
  },
} as const;

export interface AppDeps {
  orders: OrdersRepo;
  verify: Verifier;
  logger?: boolean;
}

export function buildApp({ orders, verify, logger = false }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger,
    bodyLimit: 64 * 1024,
    // Reject, never silently fix up, a request that doesn't match the schema.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  });

  app.decorateRequest('principal', undefined as unknown as Principal);

  app.get('/healthz', { logLevel: 'silent' }, async () => ({ ok: true }));

  app.register(async (v1) => {
    v1.addHook('onRequest', async (req, reply) => {
      try {
        req.principal = await verify(req.headers.authorization);
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized' });
        }
        throw err;
      }
    });

    v1.post<{ Body: OrderInput }>('/orders', { schema: { body: orderBody } }, async (req, reply) => {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
        return reply.code(400).send({ error: 'idempotency_key_required' });
      }
      try {
        const result = await orders.create(req.principal.tenantId, key, req.body);
        switch (result.kind) {
          case 'created':
            return reply.code(201).header('location', `/v1/orders/${result.order.id}`).send(result.order);
          case 'replayed':
            return reply.code(200).header('idempotent-replayed', 'true').send(result.order);
          case 'key_reused':
            return reply.code(422).send({ error: 'idempotency_key_reused' });
        }
      } catch (err) {
        if (err instanceof UnknownTenantError) return reply.code(403).send({ error: 'unknown_tenant' });
        throw err;
      }
    });

    v1.get<{ Params: { id: string } }>('/orders/:id', async (req, reply) => {
      if (!UUID.test(req.params.id)) return notFound(reply);
      const order = await orders.get(req.principal.tenantId, req.params.id);
      return order ? order : notFound(reply);
    });

    v1.get<{ Querystring: { limit?: string } }>('/orders', async (req) => {
      const n = Number(req.query.limit ?? 20);
      const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 20;
      return { orders: await orders.list(req.principal.tenantId, limit) };
    });
  }, { prefix: '/v1' });

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    if (err.validation) return reply.code(400).send({ error: 'invalid_request', detail: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code ?? 'bad_request' });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal' });
  });

  return app;
}

type FastifyError = Error & { validation?: unknown; statusCode?: number; code?: string };

function notFound(reply: FastifyReply) {
  // Another tenant's order and a non-existent order look identical.
  return reply.code(404).send({ error: 'not_found' });
}
