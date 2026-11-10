// k6 load test against the local compose stack. Run with loadtest/run.sh,
// which mints tokens and records results; see loadtest/results/.
//
// Mix per iteration: 70% new order, 10% retry of this VU's last request
// (same Idempotency-Key and body: the replay path), 20% read of this VU's
// last order. Open model (constant arrival rate), so a slow API shows up as
// latency and dropped iterations, not as a quietly lower request rate.
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

const BASE = __ENV.API_URL || 'http://api:3000';
const TOKENS = (__ENV.TOKENS || '').split(',').filter(Boolean);
const RATE = Number(__ENV.RATE || 100);
const DURATION = __ENV.DURATION || '60s';
const RUN = __ENV.RUN_ID || 'run';

export const options = {
  scenarios: {
    orders: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(20, RATE / 2),
      maxVUs: RATE * 2,
    },
  },
  thresholds: {
    // Recorded, not tuned to pass: results/ shows whether they held.
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:create}': ['p(95)<250'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

let last = null; // this VU's last order: { token, key, body, id }

function order(i) {
  return JSON.stringify({
    currency: 'EUR',
    items: [
      { sku: `SKU-${i % 50}`, quantity: 1 + (i % 3), unit_price_cents: 499 },
      { sku: 'GIFT-WRAP', quantity: 1, unit_price_cents: 150 },
    ],
  });
}

function post(token, key, body, name) {
  return http.post(`${BASE}/v1/orders`, body, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
    tags: { name },
  });
}

export function setup() {
  if (TOKENS.length === 0) throw new Error('TOKENS env var is required (loadtest/run.sh sets it)');
}

export default function () {
  const i = exec.scenario.iterationInTest;
  const r = Math.random();

  if (last && r < 0.1) {
    const res = post(last.token, last.key, last.body, 'replay');
    check(res, { 'replay 200 + same id': (x) => x.status === 200 && x.json('id') === last.id });
    return;
  }
  if (last && r < 0.3) {
    const res = http.get(`${BASE}/v1/orders/${last.id}`, {
      headers: { authorization: `Bearer ${last.token}` },
      tags: { name: 'read' },
    });
    check(res, { 'read 200': (x) => x.status === 200 });
    return;
  }

  const token = TOKENS[i % TOKENS.length];
  const key = `${RUN}-${i}`;
  const body = order(i);
  const res = post(token, key, body, 'create');
  if (check(res, { 'create 201': (x) => x.status === 201 })) {
    last = { token, key, body, id: res.json('id') };
  }
}
