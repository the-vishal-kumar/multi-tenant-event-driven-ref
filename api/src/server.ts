import { buildApp } from './app';
import { hmacVerifier } from './auth';
import { loadConfig } from './config';
import { createPool } from './db';
import { pgOrdersRepo } from './orders';
import { sqsQueue } from './queue';
import { Relay } from './relay';

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

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    stop.abort();
    await app.close();
    await relayDone;
    await Promise.all([apiPool.end(), relayPool?.end()]);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: cfg.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
