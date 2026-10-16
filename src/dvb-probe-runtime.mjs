import { spawn } from 'node:child_process';
import { parseDVBFrontendStatus } from './dvb.mjs';

const pending = new Map(), children = new Set(), queue = [];
const MAX_PENDING = 64, MAX_ACTIVE = 5;
let active = 0, stopping = false;
const unknown = error => ({ lock: null, status: 'unknown', error });
const send = message => {
  if (!process.connected || stopping) return;
  try { process.send(message, error => { if (error) shutdown(); }); } catch { shutdown(); }
};

function settle(item, value) {
  if (item.done) return; item.done = true; clearTimeout(item.timer); pending.delete(item.id);
  const queued = queue.indexOf(item); if (queued >= 0) queue.splice(queued, 1);
  send({ type: 'result', id: item.id, value });
}
function terminate(item) {
  if (!item.child || item.child.exitCode !== null || item.child.signalCode) return;
  item.child.kill('SIGTERM');
  item.killTimer = setTimeout(() => { if (item.child.exitCode === null && !item.child.signalCode) item.child.kill('SIGKILL'); }, 250); item.killTimer.unref();
}
function drain() {
  while (!stopping && active < MAX_ACTIVE && queue.length) {
    const item = queue.shift(); if (item.done) continue;
    active++; let output = '';
    try { item.child = spawn(process.env.ASTRA_DVB_FE_TOOL || 'dvb-fe-tool', ['-a', String(item.adapter), '-f', String(item.frontend), '-m', '-c', '1'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { active--; settle(item, unknown('Signal probe could not start')); continue; }
    children.add(item);
    const collect = chunk => { output = (output + String(chunk)).slice(-16384); };
    item.child.stdout.on('data', collect); item.child.stderr.on('data', collect);
    item.child.on('error', () => { item.failed = true; });
    item.child.once('close', () => {
      clearTimeout(item.killTimer); children.delete(item); active--;
      if (!item.done) {
        const result = parseDVBFrontendStatus(output);
        if (result.lock === null) result.error = item.failed ? 'Signal probe could not start' : 'No usable frontend status was returned';
        settle(item, result);
      }
      drain();
    });
  }
}
process.on('message', message => {
  if (!message || stopping) return;
  if (message.type === 'cancel') {
    const item = pending.get(message.id); if (item) { settle(item, unknown('Signal probe cancelled')); terminate(item); } return;
  }
  if (message.type !== 'probe' || !Number.isSafeInteger(message.id)) return;
  if (pending.has(message.id)) return;
  if (pending.size >= MAX_PENDING) { send({ type: 'result', id: message.id, value: unknown('Signal monitor is busy') }); return; }
  if (![message.adapter, message.frontend].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) { send({ type: 'result', id: message.id, value: unknown('Invalid DVB frontend') }); return; }
  const item = { id: message.id, adapter: message.adapter, frontend: message.frontend, done: false, child: null };
  item.timer = setTimeout(() => { settle(item, unknown('Signal probe timed out')); terminate(item); drain(); }, Math.max(100, Math.min(10000, Number(message.timeoutMs) || 3000)));
  pending.set(item.id, item); queue.push(item); drain();
});
function shutdown() {
  if (stopping) return; stopping = true;
  for (const item of pending.values()) clearTimeout(item.timer); pending.clear(); queue.length = 0;
  for (const item of children) terminate(item);
  setTimeout(() => process.exit(0), 500).unref();
  if (!children.size) process.exit(0);
}
process.on('disconnect', shutdown); process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
if (!process.send) process.exit(1);
send({ type: 'ready' });
