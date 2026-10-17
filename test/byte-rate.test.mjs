import assert from 'node:assert/strict';
import test from 'node:test';
import { ByteRateWindow } from '../src/byte-rate.mjs';

test('byte rates are unknown while warming, measured in Kbit/s, and decay after traffic stops', () => {
  const rate = new ByteRateWindow();
  assert.equal(rate.snapshot(1000), null);
  rate.add(125000, 1000);
  assert.equal(rate.snapshot(1100), null);
  assert.equal(rate.snapshot(2000), 1000);
  assert.equal(rate.snapshot(6000), 0);
});

test('an observed output interval with no bytes is zero, not a fabricated input rate', () => {
  const input = new ByteRateWindow(), output = new ByteRateWindow();
  input.add(250000, 1000); output.begin(1000);
  assert.equal(input.snapshot(2000), 2000);
  assert.equal(output.snapshot(2000), 0);
});

test('byte window stays bounded through frequent packets and long-lived streams', () => {
  const rate = new ByteRateWindow();
  for (let at = 0; at < 120000; at++) rate.add(125, at);
  assert.ok(rate.buckets.length <= 21);
  assert.equal(rate.snapshot(120000), 1000);
  rate.reset(); assert.equal(rate.snapshot(120001), null); assert.equal(rate.buckets.length, 0);
});

test('reset, input churn, invalid counts and backwards clocks do not leak the previous rate', () => {
  const rate = new ByteRateWindow();
  rate.add(1000000, 1000); assert.equal(rate.snapshot(2000), 8000);
  rate.reset(); rate.add(125000, 3000); assert.equal(rate.snapshot(4000), 1000);
  rate.add(-1, 5000); rate.add(Infinity, 5000); assert.equal(rate.snapshot(4000), 1000);
  assert.equal(rate.snapshot(3500), null);
  rate.add(250000, 3500); assert.equal(rate.snapshot(4500), 2000);
  assert.throws(() => new ByteRateWindow({ windowMs: 0 }), /Invalid/);
});
