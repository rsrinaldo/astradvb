import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { uptime } from 'node:os';

const WINDOW = 60000, LIMIT = 3, STORAGE_RETRY = 5000;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const number = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const messages = {
  storage: 'Provider connection budget storage is unavailable; connection attempts remain paused and will retry safely.',
  recovery: 'Provider connection budget requires conservative recovery; connections wait for one bounded safety window.',
};

// The identity is an opaque HMAC supplied by the caller. Never accept provider
// hosts, usernames, passwords, ECMs or control words here. A single OS lock owns
// this private directory; critical attempt/backoff snapshots are atomically
// synced, whereas high-frequency frame slots deliberately stay in memory.

async function document(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) throw Object.assign(new Error('Invalid budget file'), { code: 'BUDGET_INVALID' });
    const bytes = Buffer.alloc(4097); let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count > 4096) throw Object.assign(new Error('Invalid budget file'), { code: 'BUDGET_INVALID' });
    let value;
    try { value = JSON.parse(bytes.subarray(0, count).toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid budget file'), { code: 'BUDGET_INVALID' }); }
    return { value, stat };
  } finally { await handle?.close(); }
}

function validState(value) {
  const keys = ['version', 'savedWallMs', 'savedUptimeMs', 'bootId', 'attemptUptimeMs', 'failureCount', 'backoffUntilUptimeMs', 'quarantineUntilUptimeMs', 'frameUntilUptimeMs'];
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) && value.version === 1
    && number(value.savedWallMs) && number(value.savedUptimeMs) && (value.bootId === null || uuid(value.bootId))
    && Array.isArray(value.attemptUptimeMs) && value.attemptUptimeMs.length <= LIMIT && value.attemptUptimeMs.every((at, index, times) => number(at) && at <= value.savedUptimeMs && (!index || times[index - 1] <= at))
    && Number.isSafeInteger(value.failureCount) && value.failureCount >= 0 && value.failureCount <= 32
    && number(value.backoffUntilUptimeMs) && value.backoffUntilUptimeMs <= value.savedUptimeMs + 60000
    && number(value.quarantineUntilUptimeMs) && value.quarantineUntilUptimeMs <= value.savedUptimeMs + WINDOW
    && number(value.frameUntilUptimeMs) && value.frameUntilUptimeMs <= value.savedUptimeMs + 1000;
}

class AccountBudget {
  constructor(store, id) {
    this.store = store; this.path = join(store.directory, `${id}.json`);
    this.attempts = []; this.failureCount = 0; this.backoffUntil = 0; this.quarantineUntil = 0; this.nextFrameAt = 0;
    this.backoffBootAt = 0; this.quarantineBootAt = 0; this.frameBootAt = 0;
    this.storageRetryAt = 0; this.needsReload = false; this.activeLease = null; this.status = 'ready'; this.warned = new Set();
  }
  warn(reason) {
    if (this.warned.has(reason)) return;
    this.warned.add(reason); this.store.warn(reason);
  }
  trim(now = this.store.now()) { while (this.attempts.length && now - this.attempts[0].at >= WINDOW) this.attempts.shift(); }
  async load() {
    let loaded;
    try { loaded = (await document(this.path)).value; }
    catch (error) {
      if (error.code === 'ENOENT') { this.needsReload = false; this.status = 'ready'; return; }
      if (error.code !== 'BUDGET_INVALID') { this.unavailable(true); return; }
    }
    const now = this.store.now(); const wall = this.store.wallNow(); const up = this.store.uptimeNow();
    const elapsed = loaded ? up - loaded.savedUptimeMs : NaN;
    const wallElapsed = loaded ? wall - loaded.savedWallMs : NaN;
    if (!validState(loaded) || !this.store.bootId || loaded.bootId !== this.store.bootId || elapsed < 0 || wallElapsed < -1000 || Math.abs(wallElapsed - elapsed) > 5000) {
      this.attempts = []; this.failureCount = 0; this.backoffUntil = 0; this.quarantineUntil = now + WINDOW; this.nextFrameAt = now + 1000;
      this.backoffBootAt = 0; this.quarantineBootAt = up + WINDOW; this.frameBootAt = up + 1000;
      this.status = 'recovery-hold'; this.needsReload = false; this.warn('recovery');
      await this.persist(); return;
    }
    // OS uptime can have coarse resolution. Retain an extra second after a
    // process restart rather than expiring a provider attempt prematurely.
    this.attempts = loaded.attemptUptimeMs.map(value => ({ at: now - Math.max(0, up - value - 1000), uptime: value })); this.trim(now);
    this.failureCount = loaded.failureCount;
    this.backoffBootAt = loaded.backoffUntilUptimeMs; this.quarantineBootAt = loaded.quarantineUntilUptimeMs;
    this.backoffUntil = this.backoffBootAt ? now + Math.max(0, this.backoffBootAt - up + 1000) : 0;
    this.quarantineUntil = this.quarantineBootAt ? now + Math.max(0, this.quarantineBootAt - up + 1000) : 0;
    // No 20Hz disk writes: a restored account always holds its first frame for
    // one conservative second, while live aliases share synchronous slots.
    this.nextFrameAt = now + 1000; this.frameBootAt = up + 1000;
    this.needsReload = false; this.status = this.quarantineUntil > now ? 'recovery-hold' : 'ready';
  }
  unavailable(reload = false) {
    this.status = 'storage-unavailable'; this.storageRetryAt = this.store.now() + STORAGE_RETRY;
    this.needsReload ||= reload; this.warn('storage');
  }
  state() {
    const now = this.store.now(); this.trim(now);
    return { version: 1, savedWallMs: this.store.wallNow(), savedUptimeMs: this.store.uptimeNow(), bootId: this.store.bootId,
      attemptUptimeMs: this.attempts.map(at => at.uptime), failureCount: this.failureCount,
      backoffUntilUptimeMs: this.backoffBootAt, quarantineUntilUptimeMs: this.quarantineBootAt, frameUntilUptimeMs: this.frameBootAt };
  }
  async persist() {
    try {
      await this.store.write(this.path, this.state());
      this.storageRetryAt = 0; this.warned.delete('storage');
      this.status = this.quarantineUntil > this.store.now() ? 'recovery-hold' : 'ready'; return true;
    } catch { this.unavailable(); return false; }
  }
  delayMs() {
    const now = this.store.now(); this.trim(now);
    return Math.max(0, this.store.closed || !this.store.lockValid() ? STORAGE_RETRY : 0, this.activeLease ? 1000 : 0, this.storageRetryAt - now, this.quarantineUntil - now, this.backoffUntil - now, this.attempts.length >= LIMIT ? this.attempts[0].at + WINDOW - now : 0);
  }
  reserveConnection() {
    if (this.store.closed || !this.store.lockValid()) return Promise.resolve({ allowed: false, retryAfterMs: STORAGE_RETRY, reason: 'closed' });
    return this.store.serialize(async () => {
      if (this.store.closed || !this.store.lockValid()) return { allowed: false, retryAfterMs: STORAGE_RETRY, reason: 'closed' };
      if (this.needsReload && this.store.now() >= this.storageRetryAt) await this.load();
      const delay = this.delayMs();
      if (delay) return { allowed: false, retryAfterMs: delay, reason: this.activeLease ? 'account-in-use' : this.status };
      let released = false;
      const lease = { release: () => { if (released) return; released = true; if (this.activeLease === lease) this.activeLease = null; } };
      this.activeLease = lease; this.attempts.push({ at: this.store.now(), uptime: this.store.uptimeNow() });
      if (!(await this.persist()) || this.store.closed) { lease.release(); return { allowed: false, retryAfterMs: Math.max(STORAGE_RETRY, this.delayMs()), reason: this.store.closed ? 'closed' : 'storage-unavailable' }; }
      return { allowed: true, lease };
    });
  }
  recordFailure() {
    if (this.store.closed) return Promise.resolve(false);
    this.failureCount = Math.min(32, this.failureCount + 1);
    const delay = Math.min(15000, 1000 * 2 ** Math.min(16, this.failureCount - 1));
    this.backoffUntil = Math.max(this.backoffUntil, this.store.now() + delay); this.backoffBootAt = Math.max(this.backoffBootAt, this.store.uptimeNow() + delay);
    return this.store.serialize(() => this.persist());
  }
  recordHealthy() {
    if (this.store.closed) return Promise.resolve(false);
    this.failureCount = 0; this.backoffUntil = 0; this.backoffBootAt = 0;
    return this.store.serialize(() => this.persist());
  }
  frameDelayMs() { return Math.max(this.store.closed || !this.store.lockValid() ? STORAGE_RETRY : 0, this.nextFrameAt - this.store.now()); }
  takeFrame(intervalMs) {
    const now = this.store.now();
    if (this.store.closed || !this.store.lockValid() || now < this.nextFrameAt || !Number.isFinite(intervalMs) || intervalMs < 1 || intervalMs > 1000) return false;
    this.nextFrameAt = now + intervalMs; this.frameBootAt = this.store.uptimeNow() + intervalMs; return true;
  }
  snapshot() {
    this.trim(); return { persistent: true, status: this.store.closed ? 'closed' : this.status, attemptsLastWindow: this.attempts.length, maxAttempts: LIMIT, windowMs: WINDOW, failureCount: this.failureCount, retryAfterMs: this.delayMs(), frameDelayMs: this.frameDelayMs(), connectionLeased: Boolean(this.activeLease) };
  }
}

export async function createProviderBudgetLock({ path, spawnChild = spawn, acquireTimeoutMs = 5000 }) {
  // flock(2) belongs to the open-file description. FD3 in the short-lived
  // helper is a dup of THIS retained handle, not a separately opened path.
  // The helper can exit immediately without releasing the main owner's lock.
  // Conversely the main process's death closes its descriptor automatically;
  // there is no independent holder process that can survive or die first.
  let handle, child, closing = false, acquired = false, closePromise;
  const failure = () => new Error('Provider budget directory already has an active owner or locking is unavailable');
  try {
    handle = await open(path, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0), 0o600);
    if (!(await handle.stat()).isFile()) throw failure();
    await handle.chmod(0o600);
    child = spawnChild('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'ignore', 'ignore', handle.fd],
    });
    let spawnFailed = false, timedOut = false;
    const timeoutMs = Number.isFinite(acquireTimeoutMs) ? Math.max(1, Math.min(5000, Math.trunc(acquireTimeoutMs))) : 5000;
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.once('error', () => { spawnFailed = true; });
      // Node emits close after exit or a spawn error. Await it before closing
      // the retained handle, so a late helper cannot acquire a discarded lock.
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    if (spawnFailed || timedOut || result.code !== 0 || result.signal) throw failure();
    acquired = true;
    return {
      valid: () => acquired && !closing && handle.fd >= 0,
      close() { return closePromise ||= (async () => { closing = true; acquired = false; await handle.close(); })(); },
    };
  } catch {
    closing = true;
    await handle?.close().catch(() => {});
    throw failure();
  }
}

export async function openProviderBudgetStore({ directory, onWarning = () => {}, now = () => performance.now(), wallNow = () => Date.now(), uptimeNow = () => uptime() * 1000, bootId, createLock = createProviderBudgetLock, beforePersist = null } = {}) {
  if (typeof directory !== 'string' || !directory) throw new Error('A private provider budget directory is required');
  if (bootId === undefined) { try { bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); } catch { bootId = null; } }
  if (!uuid(bootId)) bootId = null;
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const lockPath = join(directory, 'owner.lock');
  const lockFile = await open(lockPath, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
  try { if (!(await lockFile.stat()).isFile()) throw new Error('Provider budget ownership is unavailable'); await lockFile.chmod(0o600); }
  finally { await lockFile.close(); }
  let store; const lock = await createLock({ path: lockPath, onLost: () => { if (store) { store.closed = true; store.warn('storage'); } } });
  let tail = Promise.resolve(), closePromise; const accounts = new Map();
  store = { directory, now, wallNow, uptimeNow, bootId, closed: false, lockValid: () => lock.valid(),
    warn(reason) { try { const returned = onWarning({ code: `provider_budget_${reason}`, message: messages[reason] }); returned?.catch?.(() => {}); } catch { /* Never expose filesystem errors or break existing streams. */ } },
    serialize(operation) { const result = tail.catch(() => {}).then(operation); tail = result.catch(() => {}); return result; },
    async write(path, value) {
      const temporary = join(directory, `.budget-${randomBytes(12).toString('hex')}.tmp`); let handle;
      try {
        if (!lock.valid()) throw new Error('Provider budget ownership is unavailable');
        await beforePersist?.();
        handle = await open(temporary, 'wx', 0o600); await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); await handle.close(); handle = null;
        if (!lock.valid()) throw new Error('Provider budget ownership is unavailable');
        await rename(temporary, path);
        const parent = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY || 0));
        try { await parent.sync(); } finally { await parent.close(); }
      } finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
    },
    account(id) {
      if (store.closed) return Promise.reject(new Error('Provider budget store is closed'));
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return Promise.reject(new Error('Invalid opaque provider account identity'));
      if (accounts.has(id)) return accounts.get(id);
      if (accounts.size >= 128) return Promise.reject(new Error('Provider account budget limit reached'));
      const budget = new AccountBudget(store, id);
      const result = store.serialize(async () => { await budget.load(); return budget; }); accounts.set(id, result); return result;
    },
    snapshot() { return { persistent: true, closed: store.closed, accounts: accounts.size, singleWriter: true }; },
    close() { store.closed = true; return closePromise ||= (async () => { await tail; await lock.close(); })(); },
  };
  return store;
}
