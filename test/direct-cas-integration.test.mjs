import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createCASLab, runNativeMedia, runNativeSoak } from './fixtures/cas-lab-runner.mjs';
import { cwForEpoch } from './fixtures/newcamd-provider.mjs';

const enabled = process.platform === 'linux' && process.env.ASTRA_CAS_LAB_DIRECT === '1';
async function until(check, timeout = 15000) {
  for (const deadline = Date.now() + timeout; !check();) {
    if (Date.now() >= deadline) throw new Error('Isolated direct CAS deadline exceeded');
    await delay(10);
  }
}
async function fixture(t, options = {}) {
  const lab = await createCASLab({ ...options, directTransport: true });
  t.after(() => lab.close()); return lab;
}
test('direct OSCam handles 90 simultaneous channels with correct keys and one paced provider session', { skip: !enabled, timeout: 30000 }, async t => {
  const lab = await fixture(t, { policy: () => ({ delayMs: 100 }), fragmentSizes: [1, 3, 7], fragmentDelayMs: 1 });
  const clients = [];
  for (let i=0;i<90;i++) clients.push(await lab.client());
  const replies = await Promise.all(clients.map((c,i) => c.requestECM({ channelId: i+1, epoch: 7000, timeoutMs: 10000 })));
  for (let i=0;i<replies.length;i++) {
    assert.equal(replies[i].ok, true, `channel ${i+1}`);
    assert.deepEqual(replies[i].controlWords, cwForEpoch(i+1,7000,lab.transportMode));
  }
  const s=lab.snapshot();
  assert.equal(s.provider.connections,1); assert.equal(s.provider.protocolErrors,0);
  assert.equal(s.provider.requests,90); assert.equal(s.guard.transport,'direct-oscam');
  assert.equal(s.provider.peakRequestsPerSecond<=20,true,JSON.stringify({peak:s.provider.peakRequestsPerSecond}));
  assert.equal(s.guard.connectionResets,0);
  console.log(JSON.stringify({case:'direct-90',connections:s.provider.connections,requests:s.provider.requests,peak:s.provider.peakRequestsPerSecond,correctKeys:90}));
});
test('direct OSCam tolerates delayed complete replies and local controller shutdown cannot close its provider socket', { skip: !enabled, timeout: 20000 }, async t => {
  const lab = await fixture(t,{policy:()=>({delayMs:4000})});
  const c=await lab.client();
  let reply=await c.requestECM({channelId:1,epoch:7010}); assert.equal(reply.ok,true);
  assert.deepEqual(reply.controlWords,cwForEpoch(1,7010,lab.transportMode));
  await lab.guard.stop();
  reply=await c.requestECM({channelId:1,epoch:7011}); assert.equal(reply.ok,true);
  assert.deepEqual(reply.controlWords,cwForEpoch(1,7011,lab.transportMode));
  assert.equal(lab.provider.snapshot().connections,1);
});
test('direct OSCam deduplicates identical channel requests and negatives do not reconnect the shared account', { skip: !enabled, timeout: 25000 }, async t => {
  let reject=false;
  const lab=await fixture(t,{policy:()=>({delayMs:100,reject})});
  const clients=[]; for(let i=0;i<20;i++) clients.push(await lab.client());
  const replies=await Promise.all(clients.map(c=>c.requestECM({channelId:1,epoch:7020})));
  assert.equal(replies.every(r=>r.ok),true); assert.equal(lab.provider.snapshot().requests,1);
  reject=true;
  const negatives=await Promise.all(clients.map((c,i)=>c.requestECM({channelId:i+1,epoch:7021})));
  assert.equal(negatives.every(r=>!r.ok&&!r.timedOut&&!r.closed),true);
  assert.equal(lab.provider.snapshot().connections,1);
  assert.equal(lab.snapshot().guard.connectionResets,0);
});
test('direct native reconnects obey the durable three-attempt window under repeated real TCP resets', { skip: !enabled, timeout: 90000 }, async t => {
  const lab=await fixture(t); const began=Date.now();
  assert.equal(lab.provider.snapshot().connections,1);
  for(const expected of [2,3]) {
    lab.provider.reset();
    await until(()=>lab.provider.snapshot().connections===expected,12000);
    await until(()=>lab.snapshot().guard.readerReady,12000);
  }
  lab.provider.reset(); await delay(12000);
  assert.equal(lab.provider.snapshot().connections,3,'fourth attempt must not bypass durable window');
  await until(()=>lab.provider.snapshot().connections===4,65000);
  assert.ok(Date.now()-began>=59000,'fourth provider connection must wait for original window');
  await until(()=>lab.snapshot().guard.readerReady,12000);
  const c=await lab.client(); const r=await c.requestECM({channelId:1,epoch:7030});
  assert.equal(r.ok,true); assert.deepEqual(r.controlWords,cwForEpoch(1,7030,lab.transportMode));
  const s=lab.provider.snapshot(); assert.equal(s.activeConnections,1); assert.equal(s.protocolErrors,0);
  console.log(JSON.stringify({case:'direct-reset-window',connections:s.connections,elapsedMs:Date.now()-began}));
});
test('direct OSCam preserves generated media through an actual native decoder', { skip: !enabled, timeout: 60000 }, async t => {
  const lab=await fixture(t,{policy:()=>({delayMs:50})});
  const result=await runNativeMedia(lab,{durationSeconds:12,epochSeconds:4,decode:true,admit:true});
  console.log(JSON.stringify({case:'direct-native-media',exactAV:result.exactAV,avBytes:result.avBytes,expectedAVBytes:result.expectedAVBytes,continuityErrors:result.continuityErrors}));
});
test('direct OSCam preserves every generated A/V packet with 85 overlapping native decoders', { skip: !enabled || process.env.ASTRA_CAS_LAB_DIRECT_SOAK !== '1', timeout: 600000 }, async t => {
  const lab=await fixture(t,{policy:()=>({delayMs:20})});
  const result=await runNativeSoak(lab,85);
  assert.equal(result.allExactAV,true); assert.equal(result.peakActualNativeDecoders,85);
  assert.equal(result.providerConnections,1);
  console.log(JSON.stringify({case:'direct-85-native',...result}));
});
