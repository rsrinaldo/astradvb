import assert from 'node:assert/strict';
import test from 'node:test';
import { RingLogger } from '../src/logger.mjs';

test('records the channel name while preserving the internal source ID', () => {
  let name = 'RTSH Shqip';
  const logger = new RingLogger(10, () => name);
  logger.info('adapter0-frontend0-1040', 'Connected'); name = 'Renamed';
  assert.equal(logger.list()[0].sourceName, 'RTSH Shqip');
  assert.equal(logger.list()[0].source, 'adapter0-frontend0-1040');
});

test('invalid logger limits cannot create an infinite trim loop or an unbounded ring', () => {
  for (const limit of [-1, 0, NaN, Infinity, 'not-a-number', 1e9]) {
    const logger = new RingLogger(limit);
    assert.ok(Number.isSafeInteger(logger.limit) && logger.limit >= 1 && logger.limit <= 10000);
    for (let index = 0; index < 30; index++) logger.info('test', `Entry ${index}`);
    assert.ok(logger.entries.length <= logger.limit);
    logger.setLimit(2); logger.info('test', 'Fresh 1'); logger.info('test', 'Fresh 2'); assert.equal(logger.entries.length, 2);
    assert.equal(logger.list(null).length, 2); assert.equal(logger.list(-1).length, 1);
  }
});
