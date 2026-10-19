#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';
import { loadTVHOptions } from '../src/tvheadend-client.mjs';
const options = loadTVHOptions();
const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`;
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch(`${options.url}/api/serverinfo`, { method: 'POST', headers: { authorization }, redirect: 'error', signal: AbortSignal.timeout(1000) });
    const value = await response.json(); if (response.ok && typeof value.sw_version === 'string') { ready = true; break; }
  } catch {}
  await delay(1000);
}
if (!ready) { console.error('TVHeadend HTTP startup deadline exceeded'); process.exitCode = 1; }
