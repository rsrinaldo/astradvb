// These explicitly opted-in diagnostics demonstrate unsafe boundaries. A
// reproduced boundary is NOT a decoder safety success or a release gate pass.
import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import test from 'node:test';
import { createCASLab, labRequirements, reportLab, runOutsideContractDiagnostic } from './fixtures/cas-lab-runner.mjs';
import { connectNewcamdClient, cwForEpoch, startNewcamdProvider } from './fixtures/newcamd-provider.mjs';
import { announcedECMEpoch } from './fixtures/synthetic-cas.mjs';

test('unannounced-key fixture omits only the requested ECM identity, not the physical key/parity schedule', () => {
  assert.deepEqual([0, 1, 2, 3].map(epoch => announcedECMEpoch(epoch, 1)), [0, 0, 2, 3]);
  assert.deepEqual([0, 1, 2, 3].map(epoch => announcedECMEpoch(epoch)), [0, 1, 2, 3]);
  for (const value of [0, -1, 1.5, '1']) assert.throws(() => announcedECMEpoch(1, value), /Unannounced/);
});

test('wrong-CW diagnostic peer preserves genuine msgID/protocol framing but intentionally returns a different valid pair', async () => {
  const provider = await startNewcamdProvider({ policy: () => ({ wrongCW: true }) }); let client;
  try {
    client = await connectNewcamdClient(provider.credentials);
    const reply = await client.requestECM({ channelId: 1, epoch: 1 });
    assert.equal(reply.ok, true); assert.ok(Number.isSafeInteger(reply.msgId));
    assert.equal(timingSafeEqual(reply.controlWords, cwForEpoch(1, 1)), false, 'Fixture must actually supply incorrect words without logging them');
    assert.equal(timingSafeEqual(reply.controlWords, cwForEpoch(2, 1)), true);
    assert.equal(provider.snapshot().wrongCWReplies, 1); assert.equal(provider.snapshot().protocolErrors, 0);
    assert.equal(client.snapshot().protocolErrors, 0);
  } finally { client?.close(); await provider.close(); }
});

test('outside-contract diagnostic cannot silently run through the ordinary safety API opt-in', async () => {
  if (process.env.ASTRA_CAS_LAB === '1' && process.env.ASTRA_CAS_LAB_DIAGNOSTICS === '1') return;
  await assert.rejects(runOutsideContractDiagnostic({}, { boundary: 'wrong-provider-cw' }), /two explicit/);
});

const enabled = process.env.ASTRA_CAS_LAB === '1' && process.env.ASTRA_CAS_LAB_DIAGNOSTICS === '1';
test('UNPROTECTED outside-contract boundaries: reproduction is diagnostic evidence, NOT a safety pass', { skip: !enabled, timeout: 180000 }, async t => {
  labRequirements();
  for (const boundary of ['unannounced-epoch', 'wrong-provider-cw']) await t.test(`UNPROTECTED ${boundary} can publish bad continuation before PES detection`, { timeout: 60000 }, async t => {
    let wrongRequests = 0;
    const lab = await createCASLab({ policy: request => {
      if (boundary === 'wrong-provider-cw' && request.epoch === 1) { wrongRequests++; return { wrongCW: true }; }
      return {};
    } });
    t.after(async () => { try { reportLab(lab, `UNPROTECTED-${boundary}`); } finally { await lab.close(); } });
    const result = await runOutsideContractDiagnostic(lab, { boundary });
    assert.equal(result.protected, false); assert.equal(result.safetyPass, false);
    assert.ok(result.oracle.badPublishedPackets > 0, 'Known unsafe boundary was not reproduced; reassess the diagnostic contract rather than calling this a safety pass');
    assert.equal(result.oracle.firstBadPacket.pusi, false, 'Diagnostic must expose a bad continuation before the first PES-header check');
    if (boundary === 'wrong-provider-cw') { assert.ok(wrongRequests > 0); assert.ok(result.provider.wrongCWReplies > 0); }
    else {
      assert.equal(result.outsideContract.unannouncedECMEpoch, 1);
      assert.equal(lab.provider.snapshot().events.some(event => event.kind === 'request' && event.epoch === 1), false);
    }
    t.diagnostic('UNPROTECTED boundary reproduced; this is explicitly NOT protected playback and is excluded from safety-success totals.');
  });
});
