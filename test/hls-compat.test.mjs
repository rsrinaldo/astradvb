import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { HLSCompatibilityBridge, hlsCompatibilityArgs } from '../src/hls-compat.mjs';

test('builds an HLS compatibility remux with repeated video headers and AAC audio', () => {
  const args = hlsCompatibilityArgs();
  assert.ok(args.includes('0:v:0?'));
  assert.ok(args.includes('0:a?'));
  assert.ok(args.includes('dump_extra=freq=keyframe'));
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args.at(-1), 'pipe:1');
});

class FakeRemux extends EventEmitter {
  constructor() {
    super(); this.exitCode = null; this.signalCode = null; this.kills = [];
    this.stdout = new EventEmitter(); this.stderr = new EventEmitter();
    this.stdin = Object.assign(new EventEmitter(), { writable: true, writableLength: 0, writes: 0,
      write: () => { this.stdin.writes++; }, destroy: () => { this.stdin.writable = false; } });
  }
  kill(signal) { this.kills.push(signal); }
}
function fixture() {
  const children = [], timers = new Set(), output = [], errors = []; let gaps = 0;
  const bridge = new HLSCompatibilityBridge(data => output.push(data), error => errors.push(error.message), {
    spawnChild: () => { const child = new FakeRemux(); children.push(child); return child; },
    setTimer: (callback, ms) => { const timer = { callback, ms, unref() {} }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer), onDiscontinuity: () => gaps++,
  });
  return { bridge, children, timers, output, errors, gaps: () => gaps };
}

test('HLS remux input has a hard queue bound and one paced recovery, without source/CAS restarts', () => {
  const f = fixture(); f.bridge.start(); const old = f.children[0]; old.stdin.writableLength = 2 * 1024 * 1024;
  f.bridge.write(Buffer.alloc(188)); f.bridge.write(Buffer.alloc(188));
  assert.equal(old.stdin.writes, 0); assert.equal(f.children.length, 1); assert.equal(f.errors.length, 1); assert.equal(f.gaps(), 1);
  assert.deepEqual(old.kills, ['SIGTERM']); assert.equal(old.stdin.writable, false);
  old.stdout.emit('data', Buffer.from('stale')); assert.equal(f.output.length, 0);
  const retry = [...f.timers].find(timer => timer.ms === 1000); f.timers.delete(retry); retry.callback();
  assert.equal(f.children.length, 2); f.children[1].stdout.emit('data', Buffer.from('fresh'));
  assert.equal(f.output[0].toString(), 'fresh');
  old.emit('close', 1); assert.equal(f.errors.length, 1, 'Old child close cannot invalidate its replacement');
  f.bridge.stop(); assert.equal(f.bridge.retryTimer, null);
  for (const child of f.children) { child.exitCode = 0; child.emit('close'); }
  assert.equal(f.timers.size, 0);
});

test('repeated HLS remux spawn failures back off and stop cancels retry', () => {
  const f = fixture(); f.bridge.start(); f.children[0].emit('error', new Error('not for logs'));
  const retry = f.bridge.retryTimer; assert.equal(retry.ms, 1000); f.timers.delete(retry); retry.callback();
  f.children[1].emit('close', 0); assert.equal(f.bridge.retryTimer.ms, 2000);
  assert.ok(f.errors.every(message => !message.includes('not for logs')));
  f.bridge.stop(); assert.equal(f.bridge.retryTimer, null);
  for (const child of f.children) { child.exitCode = 0; child.emit('close'); }
  assert.equal(f.timers.size, 0);
});
