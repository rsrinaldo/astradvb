#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { TVHeadendClient, loadTVHOptions } from '../src/tvheadend-client.mjs';
import { TVHeadendBackend } from '../src/tvheadend-backend.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { RingLogger } from '../src/logger.mjs';
try {
  const options = loadTVHOptions(), client = new TVHeadendClient(options);
  if (process.argv.includes('--catalogue')) {
    const value = await client.api('channel/grid', { limit: 10000 });
    console.log(JSON.stringify({ channels: (value.entries || []).map(c => ({ uuid: c.uuid, name: c.name, enabled: c.enabled })) }, null, 2));
  } else {
    const config = normalizeConfig(JSON.parse(await readFile(process.env.ASTRA_CONFIG || '/var/lib/astra-linux/config.json', 'utf8')));
    const backend = new TVHeadendBackend(options, new RingLogger(), { client });
    await backend.validate(config);
    console.log(JSON.stringify({ valid: true, enabledStreams: config.streams.filter(s => s.enabled).length, tuners: config.adapters.length,
      needsHardwareVerification: config.adapters.some(a => a.deliverySystem === 'DVBS2X' || a.streamId >= 0 || a.scramblingSequenceIndex || !['AUTO', '35', '25', '20'].includes(a.rolloff)),
      note: 'Read-only validation. It does not start tuners, provision CAS readers, activate or test the provider.' }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
