// A fast HTTP close must not exit before durable CAS admission state and its
// OS lock are flushed/released. Bound broken cleanup without losing errors.
export async function waitForShutdown(cleanups, { timeoutMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer;
  const deadline = new Promise(resolve => { timer = setTimer(() => resolve(false), timeoutMs); });
  const complete = Promise.allSettled(cleanups.map(cleanup => Promise.resolve().then(cleanup)))
    .then(results => results.every(result => result.status === 'fulfilled'));
  try { return await Promise.race([complete, deadline]); }
  finally { clearTimer(timer); }
}
