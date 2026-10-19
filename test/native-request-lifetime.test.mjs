import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createCASLab } from './fixtures/cas-lab-runner.mjs';
import { cwForEpoch } from './fixtures/newcamd-provider.mjs';

const enabled=process.platform==='linux'&&process.env.ASTRA_CAS_LAB_DIRECT==='1';
test('expired and closed callers keep a 7.5-second late reply isolated during fresh work', {skip:!enabled,timeout:30000},async t=>{
  const lab=await createCASLab({directTransport:true,callerTimeoutMs:5000,policy:({epoch})=>({delayMs:epoch===63000?7500:3000})});
  t.after(()=>lab.close());
  const old=await lab.client({timeoutMs:12000});
  const expired=await old.requestECM({channelId:1,epoch:63000});
  assert.equal(expired.ok,false);assert.equal(expired.closed,undefined);
  assert.ok(expired.elapsedMs>=4500&&expired.elapsedMs<6500);
  old.close();
  const fresh=await lab.client({timeoutMs:12000});
  const reply=await fresh.requestECM({channelId:1,epoch:63001});
  assert.equal(reply.ok,true);assert.ok(reply.elapsedMs>=2900);
  assert.deepEqual(reply.controlWords,cwForEpoch(1,63001,lab.transportMode));
  for(let n=0;lab.snapshot().guard.ecmHealth.late<1&&n<700;n++)await delay(10);
  const s=lab.snapshot();
  assert.ok(s.guard.ecmHealth.late>=1);assert.equal(s.guard.ecmHealth.good,1);
  assert.equal(s.provider.connections,1);assert.equal(s.provider.protocolErrors,0);
  assert.equal(s.guard.connectionResets,0);
  console.log(JSON.stringify({case:'expired-closed-caller-late-reply',expiredAfterMs:expired.elapsedMs,lateReplyMs:7500,correctFreshKey:true,providerConnections:1}));
});
