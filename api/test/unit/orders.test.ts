import { describe, expect, it } from 'vitest';
import { requestHash, totalCents } from '../../src/orders';

describe('requestHash', () => {
  const base = { currency: 'EUR', items: [{ sku: 'A', quantity: 2, unit_price_cents: 150 }] };

  it('ignores JSON key order', () => {
    const reordered = JSON.parse('{"items":[{"unit_price_cents":150,"quantity":2,"sku":"A"}],"currency":"EUR"}');
    expect(requestHash(reordered)).toBe(requestHash(base));
  });

  it('changes when any field changes', () => {
    const h = requestHash(base);
    expect(requestHash({ ...base, currency: 'USD' })).not.toBe(h);
    expect(requestHash({ ...base, items: [{ sku: 'A', quantity: 3, unit_price_cents: 150 }] })).not.toBe(h);
  });
});

describe('totalCents', () => {
  it('sums quantity times unit price', () => {
    expect(totalCents([
      { sku: 'A', quantity: 2, unit_price_cents: 150 },
      { sku: 'B', quantity: 1, unit_price_cents: 99 },
    ])).toBe(399);
  });
});
