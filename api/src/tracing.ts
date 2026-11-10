// Loaded with `node --require` before anything else so the http and pg
// instrumentations can patch those modules. Exports spans over OTLP/HTTP to
// OTEL_EXPORTER_OTLP_ENDPOINT (Jaeger in docker compose). If the variable is
// unset, tracing is off and the API context propagation still works as a no-op.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
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
  const stop = () => {
    sdk.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
