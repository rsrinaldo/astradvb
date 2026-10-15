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
