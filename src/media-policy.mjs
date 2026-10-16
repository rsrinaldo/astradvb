import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const choices = new Set(['system', 'cubic', 'bbr']);
const fallbackFor = env => choices.has(env?.ASTRA_MEDIA_TCP_CONGESTION)
  ? { congestionControl: env.ASTRA_MEDIA_TCP_CONGESTION, source: 'environment' }
  : { congestionControl: 'system', source: 'default' };
const warning = { code: 'media_policy_invalid', message: 'Media delivery policy is invalid or unavailable; retaining the last accepted policy.' };

async function readPolicy(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) return { invalid: true };
    const buffer = Buffer.alloc(4097);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > 4096) return { invalid: true };
    const value = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'version') || !Object.hasOwn(value, 'congestionControl') || value.version !== 1 || !choices.has(value.congestionControl)) return { invalid: true };
    return { congestionControl: value.congestionControl, source: 'file' };
  } catch (error) {
    return error?.code === 'ENOENT' ? { missing: true } : { invalid: true };
  } finally {
    try { await handle?.close(); } catch { /* No file descriptors are intentionally retained between polls. */ }
  }
}

// A private file, not an HTTP endpoint. No raw content, path or OS errors escape
// into callbacks/diagnostics. Existing accepted policy survives malformed writes.
export async function startMediaPolicy({ path, env = process.env, onChange = () => {}, onWarning = () => {}, pollMs = 5000 } = {}) {
  const fallback = fallbackFor(env);
  let state = { ...fallback, status: 'fallback', updatedAt: new Date().toISOString() };
  let initialized = false;
  let closed = false;
  let invalidWarned = false;
  let pending = null;
  let timer = null;
  const snapshot = () => ({ ...state });
  const warn = async () => {
    if (closed || invalidWarned) return;
    invalidWarned = true;
    try { await onWarning({ ...warning }); } catch { /* Diagnostics must not break delivery or policy polling. */ }
  };
  const poll = () => {
    if (closed) return Promise.resolve(snapshot());
    if (pending) return pending;
    pending = (async () => {
      const read = typeof path === 'string' && path.length ? await readPolicy(path) : { missing: true };
      if (closed) return snapshot();
      const next = read.invalid ? { congestionControl: state.congestionControl, source: state.source } : read.missing ? fallback : read;
      const changed = next.congestionControl !== state.congestionControl;
      const nextState = {
        ...next,
        status: read.invalid ? 'invalid' : read.missing ? 'fallback' : 'active',
        updatedAt: !initialized || changed || next.source !== state.source ? new Date().toISOString() : state.updatedAt,
      };
      if (!initialized || changed) {
        try { await onChange({ ...nextState }); }
        catch {
          if (!closed) { state = { ...state, status: 'invalid' }; await warn(); }
          return snapshot();
        }
      }
      if (closed) return snapshot();
      state = nextState;
      initialized = true;
      if (read.invalid) await warn(); else invalidWarned = false;
      return snapshot();
    })().finally(() => { pending = null; });
    return pending;
  };
  const close = async () => {
    if (!closed) {
      closed = true;
      clearInterval(timer);
      state = { ...state, status: 'closed' };
    }
    if (pending) await pending;
  };
  await poll();
  const interval = Number.isFinite(Number(pollMs)) ? Math.min(60000, Math.max(100, Math.floor(Number(pollMs)))) : 5000;
  timer = setInterval(() => { void poll(); }, interval);
  timer.unref();
  return { snapshot, poll, close };
}
