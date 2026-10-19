#!/usr/bin/env node
import { readdirSync, readlinkSync } from 'node:fs';

// Run as the root ExecStartPre check, not periodically and never from status.
// Refuse a second tuner owner; do not kill it or change device permissions.
let busy = false;
for (const pid of readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
  let fds; try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
  for (const fd of fds) { try { if (readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith('/dev/dvb/')) busy = true; } catch {} }
}
if (busy) { console.error('DVB devices already have an owner. Stop the previous backend before starting TVHeadend.'); process.exitCode = 1; }
