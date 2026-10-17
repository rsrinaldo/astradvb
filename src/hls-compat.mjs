import { spawn } from 'node:child_process';

export function hlsCompatibilityArgs() {
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-fflags', '+genpts+discardcorrupt', '-analyzeduration', '5000000', '-probesize', '10000000',
    '-i', 'pipe:0',
    '-map', '0:v:0?', '-map', '0:a?',
    '-c:v', 'copy', '-bsf:v', 'dump_extra=freq=keyframe',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'mpegts', 'pipe:1',
  ];
}

export class HLSCompatibilityBridge {
  constructor(onData, onError = () => {}, { onDiscontinuity = () => {}, spawnChild = spawn, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { onData, onError, onDiscontinuity, spawnChild, now, setTimer, clearTimer });
    this.child = null; this.stopped = false; this.retryTimer = null; this.attempt = 0; this.healthySince = null;
  }

  start() {
    if (this.child || this.stopped || this.retryTimer) return;
    const binary = process.env.ASTRA_FFMPEG || 'ffmpeg';
    let child;
    try { child = this.spawnChild(binary, hlsCompatibilityArgs(), { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { this.#recover(null, 'HLS compatibility remux could not start'); return; }
    this.child = child;
    this.healthySince = null;
    child.stdout.on('data', chunk => {
      if (this.child !== child || this.stopped) return;
      const at = this.now(); if (this.healthySince === null) this.healthySince = at;
      if (at - this.healthySince >= 60000) this.attempt = 0;
      this.onData(chunk);
    });
    // Drain stderr without retaining broadcaster-controlled diagnostic text.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => this.#recover(child, 'HLS compatibility input pipe closed'));
    child.on('error', () => this.#recover(child, 'HLS compatibility remux could not start'));
    child.on('close', () => this.#recover(child, 'HLS compatibility remux stopped'));
  }

  write(chunk) {
    if (this.stopped) return;
    if (!this.child) this.start();
    const child = this.child;
    if (!child?.stdin.writable) return;
    if (child.stdin.writableLength + chunk.length > 2 * 1024 * 1024) {
      this.#recover(child, 'HLS compatibility input queue overflow; recovering without restarting the source or CAS'); return;
    }
    child.stdin.write(chunk);
  }

  #recover(child, message) {
    if (this.stopped || this.child !== child || this.retryTimer) return;
    this.child = null; this.#retire(child); this.onDiscontinuity();
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5));
    this.retryTimer = this.setTimer(() => { this.retryTimer = null; this.start(); }, delay); this.retryTimer?.unref?.();
    this.onError(new Error(`${message}; retry in ${delay / 1000}s`));
  }

  #retire(child) {
    if (!child) return;
    child.stdin.destroy(); child.kill('SIGTERM');
    if (child.exitCode === null && !child.signalCode) {
      const timer = this.setTimer(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); }, 1500);
      child.once('close', () => this.clearTimer(timer)); timer?.unref?.();
    }
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) this.clearTimer(this.retryTimer); this.retryTimer = null;
    const child = this.child; this.child = null;
    this.#retire(child);
  }
}
