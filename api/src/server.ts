import { buildApp } from './app';
import { hmacVerifier } from './auth';
import { loadConfig } from './config';
import { createPool } from './db';
import { pgOrdersRepo } from './orders';
import { sqsQueue } from './queue';
import { Relay } from './relay';
import { shutdownTracing } from './tracing';

// ECS sends SIGKILL 30 s after SIGTERM by default; finish well before that.
const SHUTDOWN_TIMEOUT_MS = 20_000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const apiPool = createPool(cfg.apiDatabaseUrl, 20);
  const app = buildApp({ orders: pgOrdersRepo(apiPool), verify: hmacVerifier(cfg.jwtSecret), logger: true });

  const stop = new AbortController();
  let relayDone: Promise<void> = Promise.resolve();
  let relayPool: ReturnType<typeof createPool> | undefined;
  if (cfg.relayEnabled) {
    relayPool = createPool(cfg.relayDatabaseUrl, 2);
    const relay = new Relay(relayPool, sqsQueue(cfg.queueUrl, cfg.sqsEndpoint), cfg.relayBatchSize);
    relayDone = relay.run(stop.signal, cfg.relayIntervalMs, (err) => app.log.error({ err }, 'relay batch failed'));
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    // If something hangs (a stuck SQS call, a slow client), exit non-zero
    // rather than wait for SIGKILL.
    setTimeout(() => {
      app.log.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    try {
      stop.abort(); // the relay finishes its current batch, then returns
      await app.close(); // stop accepting connections, finish in-flight requests
      await relayDone;
      await Promise.all([apiPool.end(), relayPool?.end()]);
      await shutdownTracing();
      app.log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: cfg.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
