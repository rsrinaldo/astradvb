import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createCASLab, runNativeMedia, runNativeSoak } from './fixtures/cas-lab-runner.mjs';
import { cwForEpoch, connectNewcamdClient } from './fixtures/newcamd-provider.mjs';
import { CASIngress } from '../src/cas-ingress.mjs';

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
  assert.equal(s.ingress.target,'local-oscam-only'); assert.equal(s.ingress.sessions,90);
  assert.ok(s.ingress.peakFramesPerSecond<=20); assert.ok(s.ingress.minimumFrameIntervalMs>=51);
  console.log(JSON.stringify({case:'direct-90',connections:s.provider.connections,requests:s.provider.requests,peak:s.provider.peakRequestsPerSecond,correctKeys:90}));
});
test('local decoder churn and a negative-reply retry flood cannot reset the native provider session', { skip: !enabled, timeout: 35000 }, async t => {
  let reject=true;
  const lab=await fixture(t,{policy:()=>({reject})});
  const clients=[];for(let i=0;i<20;i++)clients.push(await lab.client());
  const due=Date.now()+5000;
  const counts=await Promise.all(clients.map(async(c,i)=>{let n=0;while(Date.now()<due){const r=await c.requestECM({channelId:i+1,epoch:7100+n,timeoutMs:5000});assert.equal(r.ok,false);assert.equal(r.closed,undefined);n++;}return n;}));
  for(const c of clients)c.close();
  await until(()=>lab.ingress.snapshot().sessions===0);
  const before=lab.provider.snapshot();assert.equal(before.connections,1);assert.equal(before.activeConnections,1);
  assert.ok(before.peakRequestsPerSecond<=20);assert.ok(lab.ingress.snapshot().peakFramesPerSecond<=20);
  reject=false;
  const c=await lab.client();const r=await c.requestECM({channelId:77,epoch:7200});assert.equal(r.ok,true);
  assert.deepEqual(r.controlWords,cwForEpoch(77,7200,lab.transportMode));
  assert.equal(lab.provider.snapshot().connections,1);assert.equal(lab.snapshot().guard.connectionResets,0);
  console.log(JSON.stringify({case:'local-retry-churn',localRequests:counts.reduce((a,b)=>a+b,0),providerConnections:1,localPeak:lab.ingress.snapshot().peakFramesPerSecond,providerPeak:lab.provider.snapshot().peakRequestsPerSecond,recoveredFreshKey:true}));
});
test('production eight-second deadlines complete forty delayed replies on one shared connection', { skip: !enabled, timeout: 25000 }, async t => {
  const lab=await fixture(t,{policy:()=>({delayMs:4000})}),clients=[];
  for(let i=0;i<40;i++)clients.push(await lab.client());
  const replies=await Promise.all(clients.map((c,i)=>c.requestECM({channelId:i+1,epoch:7299,timeoutMs:12000})));
  for(let i=0;i<40;i++){assert.equal(replies[i].ok,true);assert.deepEqual(replies[i].controlWords,cwForEpoch(i+1,7299,lab.transportMode));}
  const s=lab.snapshot();assert.equal(s.provider.connections,1);assert.equal(s.guard.connectionResets,0);
  assert.equal(s.ingress.expiredCloses+s.ingress.capacityCloses+s.ingress.transportCloses,0);
  console.log(JSON.stringify({case:'production-delayed-40-eight-second',correctKeys:40,providerConnections:1,providerPeak:s.provider.peakRequestsPerSecond}));
});
test('five-second deadlines bound delayed bursts without resetting or misassigning late keys', { skip: !enabled, timeout: 25000 }, async t => {
  let delayed=true;
  const lab=await fixture(t,{callerTimeoutMs:5000,policy:()=>({delayMs:delayed?4000:20})}),clients=[];
  for(let i=0;i<40;i++)clients.push(await lab.client());
  const replies=await Promise.all(clients.map((c,i)=>c.requestECM({channelId:i+1,epoch:7300,timeoutMs:10000})));
  const correct=replies.filter(r=>r.ok).length;
  assert.ok(correct>=30&&correct<40,JSON.stringify({correct,expired:40-correct}));
  for(let i=0;i<40;i++){assert.equal(replies[i].closed,undefined);if(replies[i].ok)assert.deepEqual(replies[i].controlWords,cwForEpoch(i+1,7300,lab.transportMode));}
  delayed=false;
  const fresh=await Promise.all(clients.map((c,i)=>c.requestECM({channelId:i+1,epoch:7301,timeoutMs:10000})));
  for(let i=0;i<40;i++){assert.equal(fresh[i].ok,true);assert.deepEqual(fresh[i].controlWords,cwForEpoch(i+1,7301,lab.transportMode));}
  const s=lab.snapshot();assert.equal(s.provider.connections,1);assert.equal(s.guard.connectionResets,0);
  assert.equal(s.ingress.expiredCloses+s.ingress.capacityCloses+s.ingress.transportCloses,0);
  console.log(JSON.stringify({case:'local-delayed-40',correctKeys:correct,expiredRequests:40-correct,freshCorrectKeys:40,providerConnections:1,providerPeak:s.provider.peakRequestsPerSecond,localPeak:s.ingress.peakFramesPerSecond}));
});

test('five-second caller expiry retains the shared socket and cannot deliver a six-second reply to fresh work', { skip: !enabled, timeout: 25000 }, async t => {
  const lab=await fixture(t,{callerTimeoutMs:5000,policy:({epoch})=>({delayMs:epoch===61000?6000:epoch===61001?1500:20})});
  const c=await lab.client({timeoutMs:12000}),other=await lab.client({timeoutMs:12000});
  const old=await c.requestECM({channelId:1,epoch:61000});
  assert.equal(old.ok,false);assert.equal(old.closed,undefined);assert.ok(old.elapsedMs>=4500&&old.elapsedMs<6500,JSON.stringify({elapsedMs:old.elapsedMs}));
  const fresh=c.requestECM({channelId:1,epoch:61001});
  const good=await other.requestECM({channelId:2,epoch:61002});assert.equal(good.ok,true);assert.deepEqual(good.controlWords,cwForEpoch(2,61002,lab.transportMode));
  const current=await fresh;assert.equal(current.ok,true);assert.ok(current.elapsedMs>=1400);assert.deepEqual(current.controlWords,cwForEpoch(1,61001,lab.transportMode));
  await until(()=>lab.snapshot().guard.ecmHealth.late>=1,7000);
  const s=lab.snapshot();assert.equal(s.provider.connections,1);assert.equal(s.guard.connectionResets,0);assert.equal(s.guard.ecmHealth.good,2);
  console.log(JSON.stringify({case:'caller-five-socket-eight',expiredAfterMs:old.elapsedMs,correctFreshKeys:2,providerConnections:1,health:s.guard.ecmHealth}));
});

test('five-second expired callers do not advance actual eight-second shared-silence recovery', { skip: !enabled, timeout: 30000 }, async t => {
  const lab=await fixture(t,{callerTimeoutMs:5000,policy:({epoch})=>({drop:epoch===62000,delayMs:20})}),c=await lab.client({timeoutMs:12000});
  const began=performance.now(),old=await c.requestECM({channelId:1,epoch:62000});
  assert.equal(old.ok,false);assert.equal(old.closed,undefined);assert.ok(old.elapsedMs>=4500&&old.elapsedMs<6500);
  await delay(Math.max(0,7500-(performance.now()-began)));
  assert.equal(lab.provider.snapshot().connections,1);assert.equal(lab.snapshot().guard.connectionResets,0);
  await until(()=>lab.provider.snapshot().connections===2&&lab.snapshot().guard.readerReady,10000);
  assert.ok(performance.now()-began>=7900);
  const fresh=await lab.client(),reply=await fresh.requestECM({channelId:1,epoch:62001});assert.equal(reply.ok,true);assert.deepEqual(reply.controlWords,cwForEpoch(1,62001,lab.transportMode));
  assert.ok(lab.snapshot().guard.attemptsLastWindow<=3);
  console.log(JSON.stringify({case:'caller-expiry-no-early-reset',expiredAfterMs:old.elapsedMs,providerConnections:2,correctFreshKey:true}));
});
test('prolonged account-wide key failure reduces fresh upstream work and recovers without TCP reset', { skip: !enabled, timeout: 160000 }, async t => {
  let reject=false, running=true;
  const lab=await fixture(t,{policy:()=>({reject,delayMs:25})}),clients=[];
  for(let i=0;i<20;i++)clients.push(await lab.client());
  const warm=await Promise.all(clients.map((c,i)=>c.requestECM({channelId:i+1,epoch:7500})));
  assert.ok(warm.every(r=>r.ok)); reject=true;
  const loops=clients.map(async(c,i)=>{let epoch=7501;while(running){const r=await c.requestECM({channelId:i+1,epoch:epoch++});assert.equal(r.closed,undefined);}});
  const work=Promise.all(loops);work.catch(()=>{});
  t.after(async()=>{running=false;for(const c of clients)c.close();await work.catch(()=>{});});
  await until(()=>lab.snapshot().guard.ecmHealth.mode===1,30000);
  await delay(18000);
  const before=lab.provider.snapshot().requests;
  await delay(20000);
  const after=lab.provider.snapshot().requests;
  assert.ok(after-before<=5,`Prolonged failure forwarded ${after-before} requests in 20 seconds`);
  assert.equal(lab.provider.snapshot().connections,1);
  reject=false;
  await until(()=>lab.snapshot().guard.ecmHealth.recoveries>=1,65000);
  running=false;await work;
  const r=await clients[0].requestECM({channelId:1,epoch:8500});assert.equal(r.ok,true);
  assert.deepEqual(r.controlWords,cwForEpoch(1,8500,lab.transportMode));
  const s=lab.snapshot();assert.equal(s.provider.connections,1);assert.equal(s.guard.connectionResets,0);
  assert.equal(s.ingress.expiredCloses+s.ingress.capacityCloses+s.ingress.transportCloses,0);
  assert.ok(s.provider.peakRequestsPerSecond<=20);
  console.log(JSON.stringify({case:'prolonged-negative-recovery',failureRequestsPer20Seconds:after-before,health:s.guard.ecmHealth,providerConnections:1}));
});
test('unsupported channels cannot throttle an otherwise working account', { skip: !enabled, timeout: 45000 }, async t => {
  const lab=await fixture(t,{policy:({channelId})=>({reject:channelId!==1,delayMs:20})}),clients=[];
  for(let i=0;i<20;i++)clients.push(await lab.client());
  const due=Date.now()+24000;
  await Promise.all(clients.map(async(c,i)=>{let n=0;while(Date.now()<due){const r=await c.requestECM({channelId:i+1,epoch:9000+n++});assert.equal(r.ok,i===0);assert.equal(r.closed,undefined);}}));
  const s=lab.snapshot();assert.equal(s.guard.ecmHealth.mode,0);assert.equal(s.guard.ecmHealth.entries,0);
  assert.equal(s.provider.connections,1);assert.ok(s.provider.peakRequestsPerSecond<=20);
  console.log(JSON.stringify({case:'mixed-entitlements',health:s.guard.ecmHealth,providerConnections:1}));
});
test('matched late positive replies cannot falsely reopen full-rate admission', { skip: !enabled, timeout: 55000 }, async t => {
  const lab=await fixture(t,{policy:({channelId})=>channelId%2?{reject:true}:{delayMs:9500}}),clients=[];
  for(let i=0;i<20;i++)clients.push(await lab.client());
  let running=true;
  const work=Promise.all(clients.map(async(c,i)=>{let n=0;while(running){const r=await c.requestECM({channelId:i+1,epoch:10000+n++,timeoutMs:12000});assert.equal(r.ok,false);assert.equal(r.closed,undefined);}}));
  work.catch(()=>{});t.after(async()=>{running=false;for(const c of clients)c.close();await work.catch(()=>{});});
  // Retired wire IDs now discard terminal replies before caller/key delivery.
  // Their evidence belongs to isolation.lateReplies, not matched-live health.
  await until(()=>lab.snapshot().guard.ecmHealth.mode===1&&lab.snapshot().guard.ecmIsolation.lateReplies>0,35000);
  const s=lab.snapshot();assert.equal(s.guard.ecmHealth.good,0);assert.equal(s.guard.ecmHealth.recoveries,0);
  assert.equal(s.provider.connections,1);assert.equal(s.guard.connectionResets,0);
  running=false;await work;
  console.log(JSON.stringify({case:'late-positive-not-recovery',health:lab.snapshot().guard.ecmHealth,isolation:lab.snapshot().guard.ecmIsolation,providerConnections:1}));
});
test('positive packets with invalid null keys cannot grant healthy admission', { skip: !enabled, timeout: 40000 }, async t => {
  const lab=await fixture(t,{policy:()=>({zeroCW:true})}),clients=[];
  for(let i=0;i<20;i++)clients.push(await lab.client());
  const due=Date.now()+23000;
  await Promise.all(clients.map(async(c,i)=>{let n=0;while(Date.now()<due){const r=await c.requestECM({channelId:i+1,epoch:11000+n++});assert.equal(r.ok,false);assert.equal(r.closed,undefined);}}));
  const s=lab.snapshot();assert.equal(s.guard.ecmHealth.good,0);assert.equal(s.guard.ecmHealth.mode,1);
  assert.ok(s.guard.ecmHealth.late>0);assert.equal(s.provider.connections,1);
  console.log(JSON.stringify({case:'invalid-positive-not-recovery',health:s.guard.ecmHealth,providerConnections:1}));
});
test('a full 90-channel failed account has fresh fair probes and all channels recover', { skip: !enabled, timeout: 120000 }, async t => {
  let reject=true,running=true;
  const lab=await fixture(t,{policy:()=>({reject,delayMs:30})}),clients=[],recovered=new Set();
  for(let i=0;i<90;i++)clients.push(await lab.client({timeoutMs:15000}));
  const work=Promise.all(clients.map(async(c,i)=>{let n=0;while(running){const epoch=12000+n++,r=await c.requestECM({channelId:i+1,epoch,timeoutMs:15000});assert.equal(r.closed,undefined);if(r.ok){assert.deepEqual(r.controlWords,cwForEpoch(i+1,epoch,lab.transportMode));recovered.add(i+1);}}}));
  work.catch(()=>{});t.after(async()=>{running=false;for(const c of clients)c.close();await work.catch(()=>{});});
  await until(()=>lab.snapshot().guard.ecmHealth.mode===1&&lab.snapshot().guard.ecmHealth.probes>=1,40000);
  reject=false;
  await until(()=>recovered.size===90,45000);
  running=false;await work;
  const s=lab.snapshot();assert.equal(s.provider.connections,1);assert.equal(s.guard.connectionResets,0);
  assert.ok(s.provider.peakRequestsPerSecond<=20);assert.ok(s.ingress.peakFramesPerSecond<=20);
  assert.equal(s.ingress.expiredCloses+s.ingress.capacityCloses+s.ingress.transportCloses,0);
  console.log(JSON.stringify({case:'full-account-recovery',correctRecoveredChannels:recovered.size,health:s.guard.ecmHealth,providerConnections:1,providerPeak:s.provider.peakRequestsPerSecond}));
});
test('short good-key bursts cannot release full-rate recovery and stale recovery work is retired', { skip: !enabled, timeout: 210000 }, async t => {
  let reject=true,running=true;
  const lab=await fixture(t,{localIngress:false,policy:()=>({reject,delayMs:reject?5000:30})}),clients=[];
  for(let i=0;i<40;i++)clients.push(await lab.client({timeoutMs:15000}));
  const began=Date.now(),seen=new Set();
  const work=Promise.all(clients.map(async(c,i)=>{while(running){const epoch=14000+Math.floor((Date.now()-began)/10000),r=await c.requestECM({channelId:i+1,epoch,timeoutMs:15000});assert.equal(r.closed,undefined);if(r.ok){assert.deepEqual(r.controlWords,cwForEpoch(i+1,epoch,lab.transportMode));seen.add(i+1);}await delay(100);}}));
  work.catch(()=>{});t.after(async()=>{running=false;for(const c of clients)c.close();await work.catch(()=>{});});
  await until(()=>lab.snapshot().guard.ecmHealth.mode===1,40000);
  for(let pulse=0;pulse<2;pulse++) {
    reject=false;await until(()=>lab.snapshot().guard.ecmHealth.mode>=2,25000);
    await delay(4000);reject=true;
    for(let n=0;n<40;n++) {assert.equal(lab.snapshot().guard.ecmHealth.recoveries,0,'A brief positive burst cannot unlock full rate');await delay(100);}
    await until(()=>lab.snapshot().guard.ecmHealth.mode===1,20000);
  }
  reject=false;seen.clear();await until(()=>lab.snapshot().guard.ecmHealth.recoveries>=1&&seen.size===40,70000);
  running=false;await work;
  const s=lab.snapshot();assert.equal(s.provider.connections,1);assert.equal(s.guard.connectionResets,0);
  assert.ok(s.provider.peakRequestsPerSecond<=20);
  assert.ok(s.guard.ecmTrace.repeatedNOK>0,'Same-identity failed retries must be measured, not blacklisted');
  assert.ok(s.guard.ecmTrace.maxRecoveryAgeMs<2000,JSON.stringify(s.guard.ecmTrace));
  assert.ok(s.guard.ecmTrace.peakRecoverySent<=16,JSON.stringify(s.guard.ecmTrace));
  assert.ok(s.guard.ecmTrace.recoveryExpired>0);
  console.log(JSON.stringify({case:'intermittent-recovery-freshness',correctRecoveredChannels:seen.size,health:s.guard.ecmHealth,trace:s.guard.ecmTrace,providerConnections:1}));
});
test('closing and replacing the Node local guard with work in flight leaves the provider socket alive', { skip: !enabled, timeout: 20000 }, async t => {
  const lab=await fixture(t,{policy:()=>({delayMs:2000})});
  const old=await lab.client(),pending=old.requestECM({channelId:1,epoch:7400});
  await until(()=>lab.provider.snapshot().requests===1);
  await lab.ingress.stop();assert.equal((await pending).closed,true);
  assert.equal(lab.provider.snapshot().connections,1);assert.equal(lab.provider.snapshot().activeConnections,1);
  const replacement=new CASIngress({port:lab.backendPort});t.after(()=>replacement.stop());
  const port=await replacement.start();
  const c=await connectNewcamdClient({...lab.credentials,port,transportMode:lab.transportMode});t.after(()=>c.close());
  const r=await c.requestECM({channelId:2,epoch:7401});assert.equal(r.ok,true);
  assert.deepEqual(r.controlWords,cwForEpoch(2,7401,lab.transportMode));
  assert.equal(lab.provider.snapshot().connections,1);assert.equal(lab.snapshot().guard.connectionResets,0);
  console.log(JSON.stringify({case:'local-guard-replacement',providerConnections:1,freshKeyAfterReplacement:true}));
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
test('one missing and one late reply cannot reset healthy channels or poison fresh keys', { skip: !enabled, timeout: 60000 }, async t => {
  const lab=await fixture(t,{policy:({channelId,epoch})=>({drop:channelId===1&&epoch===20000,delayMs:channelId===3&&epoch===20000?11000:20})});
  const lost=await lab.client(),late=await lab.client(),healthy=await lab.client();
  const missing=lost.requestECM({channelId:1,epoch:20000}),delayed=late.requestECM({channelId:3,epoch:20000});
  const end=Date.now()+37000;let correct=0;
  while(Date.now()<end) {
    const epoch=21000+correct,r=await healthy.requestECM({channelId:2,epoch});
    assert.equal(r.ok,true);assert.deepEqual(r.controlWords,cwForEpoch(2,epoch,lab.transportMode));correct++;await delay(250);
  }
  assert.equal((await missing).ok,false);assert.equal((await delayed).ok,false);
  for(const [client,id] of [[lost,1],[late,3]]) {const r=await client.requestECM({channelId:id,epoch:22000});assert.equal(r.ok,true);assert.deepEqual(r.controlWords,cwForEpoch(id,22000,lab.transportMode));}
  const s=lab.snapshot();assert.equal(s.provider.connections,1);assert.equal(s.guard.connectionResets,0);
  assert.ok(s.guard.ecmIsolation.retired>=2);assert.ok(s.guard.ecmIsolation.pendingIDs>=1);assert.ok(s.guard.ecmIsolation.lateReplies>=1);
  console.log(JSON.stringify({case:'isolated-missing-late',correctHealthyReplies:correct,providerConnections:1,isolation:s.guard.ecmIsolation}));
});
test('four sparse successful keys recover a limited account without extra requests', { skip: !enabled, timeout: 75000 }, async t => {
  const lab=await fixture(t,{initialHealthLimited:true,policy:()=>({delayMs:20})}),c=await lab.client();
  await delay(15500);
  for(let n=0;n<4;n++) {if(n)await delay(10010);const epoch=23000+n,r=await c.requestECM({channelId:1,epoch});assert.equal(r.ok,true);assert.deepEqual(r.controlWords,cwForEpoch(1,epoch,lab.transportMode));}
  await until(()=>lab.snapshot().guard.ecmHealth.limited===0,7000);
  const s=lab.snapshot();assert.equal(s.provider.requests,4);assert.equal(s.provider.connections,1);assert.equal(s.guard.ecmHealth.recoveries,1);
  console.log(JSON.stringify({case:'sparse-account-recovery',correctKeys:4,providerRequests:4,providerConnections:1,health:s.guard.ecmHealth}));
});
test('one failing service has bounded retries and cannot block other services recovery', { skip: !enabled, timeout: 100000 }, async t => {
  const lab=await fixture(t,{initialHealthLimited:true,policy:({channelId})=>({reject:channelId===1,delayMs:20})}),clients=[];
  for(let n=0;n<10;n++)clients.push(await lab.client());
  await delay(15500);let run=true,correct=0,negative=0,failure;
  // Sparse probe admission intentionally expires stale queued work. A healthy
  // service retries with a fresh identity; every delivered key must be exact.
  const work=Promise.all(clients.map(async(c,n)=>{let epoch=24000;while(run){const current=epoch++,r=await c.requestECM({channelId:n+1,epoch:current});assert.equal(r.closed,undefined);if(!n){assert.equal(r.ok,false);negative++;}else if(r.ok){assert.deepEqual(r.controlWords,cwForEpoch(n+1,current,lab.transportMode));correct++;}await delay(n?1000:10);}}));
  work.catch(error=>{failure=error;});t.after(async()=>{run=false;clients.forEach(c=>c.close());await work.catch(()=>{});});
  // A persisted sparse account can spend a 15s probe interval plus a caller
  // renewal cycle finding its first useful service, then needs 30s of proof.
  await until(()=>{if(failure)throw failure;return lab.snapshot().guard.ecmHealth.recoveries===1;},65000);run=false;await work;
  assert.ok(correct>=20,'Working services must deliver useful keys throughout recovery');
  const s=lab.snapshot();assert.equal(s.provider.connections,1);assert.equal(s.guard.connectionResets,0);assert.ok(negative<20,'Failure retries must not use the whole account rate');assert.ok(s.provider.peakRequestsPerSecond<=20);
  console.log(JSON.stringify({case:'mixed-service-recovery',correctKeys:correct,negativeReplies:negative,providerConnections:1,health:s.guard.ecmHealth,isolation:s.guard.ecmIsolation}));
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
