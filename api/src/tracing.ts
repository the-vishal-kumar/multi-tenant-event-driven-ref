// Loaded with `node --require` before anything else so the http and pg
// instrumentations can patch those modules. Exports spans over OTLP/HTTP to
// OTEL_EXPORTER_OTLP_ENDPOINT (Jaeger in docker compose). If the variable is
// unset, tracing is off and the API context propagation still works as a no-op.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

let sdk: NodeSDK | undefined;

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'orders-api',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => req.url === '/healthz',
      }),
      new PgInstrumentation({ requireParentSpan: true }),
    ],
  });
  sdk.start();
}

/**
 * Flushes buffered spans. server.ts calls this as the last step of its
 * shutdown, after the HTTP server and the relay have stopped, so the spans of
 * the final requests and publishes are exported before the process exits.
 * (`--require` and `import` resolve to the same module instance.)
 */
export async function shutdownTracing(): Promise<void> {
  await sdk?.shutdown().catch(() => undefined);
}
