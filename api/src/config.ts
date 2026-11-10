// All configuration comes from the environment. Required values fail fast at
// startup rather than at first use.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export interface Config {
  port: number;
  apiDatabaseUrl: string;
  relayDatabaseUrl: string;
  jwtSecret: string;
  queueUrl: string;
  sqsEndpoint: string | undefined;
  relayEnabled: boolean;
  relayIntervalMs: number;
  relayBatchSize: number;
}

export function loadConfig(): Config {
  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  return {
    port: int('PORT', 3000),
    apiDatabaseUrl: required('DATABASE_URL_API'),
    relayDatabaseUrl: required('DATABASE_URL_RELAY'),
    jwtSecret,
    queueUrl: required('QUEUE_URL'),
    sqsEndpoint: process.env.SQS_ENDPOINT || undefined,
    relayEnabled: process.env.RELAY_ENABLED !== 'false',
    relayIntervalMs: int('RELAY_INTERVAL_MS', 200),
    relayBatchSize: Math.min(int('RELAY_BATCH_SIZE', 50), 500),
  };
}
