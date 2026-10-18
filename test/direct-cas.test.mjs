import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildOscamConfiguration, CASProxyManager } from '../src/cas-proxy.mjs';
import { DirectCASController, parseDirectStatus } from '../src/direct-cas-controller.mjs';
import { encryptSecret } from '../src/secrets.mjs';
import { openProviderBudgetStore } from '../src/provider-budget.mjs';
import { RingLogger } from '../src/logger.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('direct manager shares local ingress across aliases without a WAN proxy or Node budget owner', async () => {
  const directory=mkdtempSync(join(tmpdir(),'astra-direct-manager-')); const old=process.env.ASTRA_SECRET_KEY;
  let proxy, ingressStarts = 0, ingressStops = 0, spawns = 0;
  try {
    process.env.ASTRA_SECRET_KEY='synthetic-direct-manager';
    const child=new EventEmitter();
    Object.assign(child,{exitCode:null,signalCode:null,stdout:new PassThrough(),stderr:new PassThrough()});
    child.kill=signal=>{child.signalCode=signal;queueMicrotask(()=>child.emit('exit',null,signal));return true;};
    proxy=new CASProxyManager(new RingLogger(),{transport:'direct',runtimeDir:join(directory,'config'),protectedBuild:()=>true,
      guardFactory:()=>{throw new Error('Node forwarding guard must not exist');},
      ingressFactory:options=>{assert.equal(options.port,23000);assert.equal(options.rate,20);return {
        start:async()=>{ingressStarts++;return 31000;},stop:async()=>{ingressStops++;},snapshot:()=>({target:'local-oscam-only'})};},
      budgetStoreFactory:()=>{throw new Error('Node must not own the native connection budget');},
      spawnChild:()=>{spawns++;return child;},waitForPorts:async ports=>{assert.deepEqual(ports,[23000]);}});
    const profile={id:'p',caid:'0B00',lineEncrypted:encryptSecret('provider.invalid 15000 fake fake 0102030405060708091011121314')};
    const profiles=[profile,{...profile,id:'alias'}];
    const connections=await proxy.start(profiles); assert.equal(connections.size,2);
    assert.equal(connections.get('p'),connections.get('alias'));assert.equal(connections.get('p').port,31000);
    assert.equal(proxy.directPorts.get('p'),23000);assert.equal(ingressStarts,1);
    assert.equal(await proxy.start(profiles),connections);assert.equal(spawns,1);assert.equal(ingressStarts,1);
    assert.equal(proxy.guardedPorts.size,0); assert.equal(proxy.budgetStore,null);
    child.stdout.write('astra direct status: port=23000 ready=1 connections=1 closes=0 frames=2 failures=0 retryMs=0 attempts=1 stableRecoveries=0\n');
    assert.equal(proxy.guardMetrics()[0].readerReady,true);
    assert.equal(proxy.guardMetrics()[0].transport,'direct-oscam');
    assert.equal(proxy.guardMetrics()[0].ingress.target,'local-oscam-only');
  } finally { await proxy?.stop(); if(old===undefined)delete process.env.ASTRA_SECRET_KEY;else process.env.ASTRA_SECRET_KEY=old;rmSync(directory,{recursive:true,force:true}); }
  assert.equal(ingressStops,1);
});
test('native direct send loops preserve partial writes and bound backpressure without replay', () => {
  const directory=mkdtempSync(join(tmpdir(),'astra-direct-io-'));
  try {
    const patch=readFileSync(join(root,'patches/oscam-newcamd-stream-io.patch'),'utf8');
    const header=patch.split('+++ b/astra-newcamd-io.h\n')[1]; assert.ok(header);
    writeFileSync(join(directory,'astra-newcamd-io.h'),header.split('\n').filter(line=>line.startsWith('+')).map(line=>line.slice(1)).join('\n')+'\n');
    const apply=spawnSync('git',['apply','--include=astra-newcamd-io.h',join(root,'patches/oscam-direct-transport.patch')],{cwd:directory,encoding:'utf8'});
    assert.equal(apply.status,0,apply.stderr);
    const binary=join(directory,'probe');
    const build=spawnSync('cc',['-std=c11','-Wall','-Wextra','-Werror','-I',directory,join(root,'test/native-oscam-direct-io.c'),'-o',binary],{encoding:'utf8'});
    assert.equal(build.status,0,build.stderr);
    const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000}); assert.equal(run.status,0,run.stderr);
    assert.match(run.stdout,/^PASS:/);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
test('legacy Node and native budget formats preserve consumed attempts in both migration directions', async () => {
  const directory=mkdtempSync(join(tmpdir(),'astra-direct-interop-'));
  const id='b'.repeat(64),boot='12345678-1234-1234-1234-123456789abc';
  let delta=0,store;
  const options={directory,bootId:boot,now:()=>200000+delta,uptimeNow:()=>1000000+delta,wallNow:()=>1700000000000+delta,
    createLock:async()=>({valid:()=>true,async close(){}})};
  try {
    const binary=join(directory,'probe');
    const build=spawnSync('cc',['-std=c11','-Wall','-Wextra','-Werror','-I',join(root,'native'),join(root,'test/native-provider-budget.c'),'-o',binary],{encoding:'utf8'});
    assert.equal(build.status,0,build.stderr);
    store=await openProviderBudgetStore(options); let account=await store.account(id);
    for(let i=0;i<3;i++) {
      delta=i*5000; const r=await account.reserveConnection(); assert.equal(r.allowed,true); r.lease.release(); await account.recordFailure();
    }
    await store.close(); store=null;
    let run=spawnSync(binary,[directory,id,boot,'1020000','1700000020000'],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr); assert.deepEqual(JSON.parse(run.stdout),{allowed:0,attempts:3,failures:3});
    run=spawnSync(binary,[directory,id,boot,'1061000','1700000061000'],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr); assert.deepEqual(JSON.parse(run.stdout),{allowed:1,attempts:3,failures:3});
    delta=61000; store=await openProviderBudgetStore(options); account=await store.account(id);
    assert.equal(account.snapshot().attemptsLastWindow,3); assert.equal(account.snapshot().failureCount,3);
    assert.equal((await account.reserveConnection()).allowed,false);
  } finally { await store?.close(); rmSync(directory,{recursive:true,force:true}); }
});
test('native budget enforces durable admission and pacing without a Node provider socket', () => {
  const directory = mkdtempSync(join(tmpdir(), 'astra-direct-native-test-'));
  try {
    const binary = join(directory, 'test');
    const build = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', join(root, 'native'), join(root, 'test/native-provider-budget.c'), '-o', binary], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /^PASS:/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('direct configuration keeps the real provider in OSCam and assigns only opaque local budget identity', () => {
  const old = process.env.ASTRA_SECRET_KEY;
  try {
    process.env.ASTRA_SECRET_KEY = 'synthetic-direct-test';
    const profiles = [{ id: 'p', caid: '0B00', lineEncrypted: encryptSecret('provider.invalid 15000 fake fake 0102030405060708091011121314') }];
    const directAccounts = new Map([['p', 'a'.repeat(64)]]);
    const config = buildOscamConfiguration(profiles, { directAccounts, budgetDirectory: '/private/budgets' });
    assert.match(config.server, /^device = provider\.invalid,15000$/m);
    assert.match(config.server, /^astra_direct = 1$/m);
    assert.match(config.server, /^astra_ecm_scheduler = 1$/m);
    assert.match(config.server, /^astra_report_port = 23000$/m);
    assert.match(config.server, /^astra_budget_directory = \/private\/budgets$/m);
    assert.throws(() => buildOscamConfiguration(profiles, { directAccounts, budgetDirectory: '/bad\nvalue' }));
    assert.throws(() => buildOscamConfiguration(profiles, { directAccounts, budgetDirectory: '/private', guardedPorts: new Map([['p', 31000]]) }));
  } finally { if (old === undefined) delete process.env.ASTRA_SECRET_KEY; else process.env.ASTRA_SECRET_KEY = old; }
});
test('numeric native status is strict and cannot retain provider text or extra fields', () => {
  const line = 'private-context astra direct status: port=23000 ready=1 connections=1 closes=0 frames=10 failures=0 retryMs=0 attempts=1 stableRecoveries=0';
  const value = parseDirectStatus(line); assert.equal(value.frames, 10);
  assert.equal(JSON.stringify(value).includes('private-context'), false);
  for (const invalid of [line+' credential=x', line.replace('ready=1','ready=2'), line.replace('attempts=1','attempts=4'), line.replace('frames=10','frames=-1')]) assert.equal(parseDirectStatus(invalid), null);
});
test('direct mode preserves an explicit provider pause and lower configured rate', async () => {
  const previous={secret:process.env.ASTRA_SECRET_KEY,pause:process.env.ASTRA_CAS_PROVIDER_PAUSED,rate:process.env.ASTRA_CAS_REQUESTS_PER_SECOND};
  let c;
  try {
    process.env.ASTRA_SECRET_KEY='synthetic-paused-direct';process.env.ASTRA_CAS_PROVIDER_PAUSED='1';process.env.ASTRA_CAS_REQUESTS_PER_SECOND='5';
    const profiles=[{id:'p',caid:'0B00',lineEncrypted:encryptSecret('provider.invalid 15000 fake fake 0102030405060708091011121314')}];
    const config=buildOscamConfiguration(profiles,{directAccounts:new Map([['p','a'.repeat(64)]]),budgetDirectory:'/private/budgets'});
    assert.match(config.server,/^enable = 0$/m); assert.match(config.server,/^astra_frame_interval = 201$/m);
    c=new DirectCASController({reportPort:23000}); assert.equal(c.snapshot().state,'paused');assert.equal(c.snapshot().rate,5);
  } finally {
    await c?.stop();
    for(const [key,value] of [['ASTRA_SECRET_KEY',previous.secret],['ASTRA_CAS_PROVIDER_PAUSED',previous.pause],['ASTRA_CAS_REQUESTS_PER_SECOND',previous.rate]]) {
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
});
test('local controller only schedules starts and observes current-generation native counters', async () => {
  const c = new DirectCASController({ reportPort: 23000 });
  try {
    c.setReaderReady(true); assert.equal(c.readerReady, false);
    c.update({ port: 23001, ready: 1 }); assert.equal(c.readerReady, false);
    const status = { port: 23000, ready: 1, connections: 1, closes: 0, frames: 10, failures: 0, retryMs: 0, attempts: 1, stableRecoveries: 0 };
    c.update(status); assert.equal(c.readerReady, true);
    c.beginGeneration(); assert.equal(c.readerReady, false);
    c.update({ ...status, frames: 2 }); assert.equal(c.snapshot().framesSent, 12);
    assert.equal(c.snapshot().connections, 2);
    for (let i=0;i<100;i++) c.result(false);
    assert.equal(c.snapshot().connectionResets, 0);
    assert.equal(c.snapshot().transport, 'direct-oscam');
  } finally { await c.stop(); }
});
