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
  constructor(onData, onError = () => {}) {
    this.onData = onData;
    this.onError = onError;
    this.child = null;
    this.stopped = false;
    this.stderr = '';
  }

  start() {
    if (this.child || this.stopped) return;
    const binary = process.env.ASTRA_FFMPEG || 'ffmpeg';
    const child = spawn(binary, hlsCompatibilityArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.stderr = '';
    child.stdout.on('data', this.onData);
    child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4096); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => this.onError(error));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (!this.stopped && code !== 0) this.onError(new Error(`HLS compatibility remux exited ${code}: ${this.stderr.trim()}`));
    });
  }

  write(chunk) {
    if (this.stopped) return;
    if (!this.child) this.start();
    if (this.child?.stdin.writable) this.child.stdin.write(chunk);
  }

  stop() {
    this.stopped = true;
    const child = this.child; this.child = null;
    if (!child) return;
    child.stdin.end();
    child.kill('SIGTERM');
  }
}
