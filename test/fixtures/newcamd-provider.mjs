// Test-only, loopback-only Newcamd525 peer. Never import into production code.
// Protocol framing follows the pinned OSCam/tsdecrypt implementations. All
// credentials, ECMs and CSA words in this fixture are disposable synthetic data.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import { performance } from 'node:perf_hooks';

export const FIXTURE_CREDENTIALS = Object.freeze({ host: '127.0.0.1', username: 'fixture', password: 'disposable', desKey: '0102030405060708091011121314', caid: '0B00' });
const TABLE_MODES = ['parity', 'fixed80', 'inverse'];
const PAIR_MODES = ['previous-current', 'current-next', 'two-period-pair', 'selected-only', 'opposite-only', 'unchanged-pair'];
const ECM_MODES = ['epoch', 'suffix-only'];
export const DEFAULT_TRANSPORT_MODE = Object.freeze({ tableMode: 'parity', pairMode: 'previous-current', ecmMode: 'epoch' });
export function normalizeTransportMode(value = DEFAULT_TRANSPORT_MODE) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['tableMode', 'pairMode', 'ecmMode'].includes(key)), 'Invalid synthetic transport mode');
  const mode = { ...DEFAULT_TRANSPORT_MODE, ...value };
  assert.ok(TABLE_MODES.includes(mode.tableMode) && PAIR_MODES.includes(mode.pairMode) && ECM_MODES.includes(mode.ecmMode), 'Invalid synthetic transport mode');
  assert.ok(mode.ecmMode !== 'suffix-only' || mode.tableMode === 'fixed80', 'Suffix-only synthetic transport mode requires fixed80');
  return Object.freeze(mode);
}
export function transportModeCode(value) {
  const mode = normalizeTransportMode(value); return TABLE_MODES.indexOf(mode.tableMode) + 4 * PAIR_MODES.indexOf(mode.pairMode) + 32 * ECM_MODES.indexOf(mode.ecmMode);
}
const bounded = (n, fallback, maximum) => Number.isSafeInteger(n) && n >= 0 ? Math.min(n, maximum) : fallback;
const loopback = host => { assert.ok(['127.0.0.1', '::1'].includes(host), 'CAS fixtures only permit loopback'); return host; };
const hash = (...parts) => createHash('md5').update(Buffer.concat(parts)).digest();

export function fixturePasswordHash(password) {
  const pw = Buffer.from(password), salt = Buffer.from('abcdefgh');
  const alternate = hash(pw, salt, pw), first = [pw, Buffer.from('$1$'), salt];
  for (let left = pw.length; left > 0; left -= 16) first.push(alternate.subarray(0, Math.min(left, 16)));
  for (let bits = pw.length; bits; bits >>= 1) first.push(bits & 1 ? Buffer.from([0]) : pw.subarray(0, 1));
  let digest = hash(...first);
  for (let i = 0; i < 1000; i++) digest = hash(i & 1 ? pw : digest, ...(i % 3 ? [salt] : []), ...(i % 7 ? [pw] : []), i & 1 ? digest : pw);
  const alphabet = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const to64 = (value, count) => { let text = ''; while (count--) { text += alphabet[value & 63]; value >>>= 6; } return text; };
  let encoded = '';
  for (let i = 0; i < 5; i++) encoded += to64((digest[i] << 16) | (digest[i + 6] << 8) | digest[i + 12 === 16 ? 5 : i + 12], 4);
  return `$1$abcdefgh$${encoded}${to64(digest[11], 2)}`;
}

function spreadKey(source) {
  const key = Buffer.alloc(16);
  for (let half = 0; half < 2; half++) {
    const value = source.subarray(half * 7, half * 7 + 7);
    key[half * 8] = value[0] & 0xfe;
    for (let i = 1; i < 7; i++) key[half * 8 + i] = ((value[i - 1] << (8 - i)) | (value[i] >> i)) & 0xfe;
    key[half * 8 + 7] = (value[6] << 1) & 0xfe;
  }
  for (let i = 0; i < key.length; i++) { let ones = 0; for (let bits = key[i]; bits; bits >>= 1) ones += bits & 1; key[i] |= (ones & 1) ^ 1; }
  return key;
}
function deriveKey(base, modifier) { const mixed = Buffer.from(base); for (let i = 0; i < modifier.length; i++) mixed[i % 14] ^= modifier[i]; return spreadKey(mixed); }
function encode(payload, key, { msgId = 0, serviceId = 0, caid = 0x0b00 } = {}) {
  const message = Buffer.alloc(12 + payload.length);
  message.writeUInt16BE(msgId, 2); message.writeUInt16BE(serviceId, 4); message.writeUInt16BE(caid, 6); payload.copy(message, 12);
  message[13] = (message[13] & 0xf0) | ((payload.length - 3) >> 8); message[14] = (payload.length - 3) & 255;
  const padding = (8 - ((message.length - 1) % 8)) % 8;
  const body = Buffer.concat([message.subarray(2), Buffer.alloc(padding), Buffer.alloc(1)]);
  body[body.length - 1] = body.subarray(0, -1).reduce((sum, byte) => sum ^ byte, 0);
  const iv = randomBytes(8), cipher = createCipheriv('des-ede-cbc', key, iv); cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(body), cipher.final(), iv]);
  const header = Buffer.alloc(2); header.writeUInt16BE(encrypted.length);
  return Buffer.concat([header, encrypted]);
}
function decode(frame, key) {
  assert.ok(frame.length >= 18 && (frame.length - 2) % 8 === 0);
  const cipher = createDecipheriv('des-ede-cbc', key, frame.subarray(-8)); cipher.setAutoPadding(false);
  const body = Buffer.concat([cipher.update(frame.subarray(2, -8)), cipher.final()]);
  assert.equal(body.reduce((sum, byte) => sum ^ byte, 0), 0);
  const length = 3 + (((body[11] & 15) << 8) | body[12]);
  assert.ok(length >= 3 && length <= body.length - 11);
  return { msgId: body.readUInt16BE(0), serviceId: body.readUInt16BE(2), caid: body.readUInt16BE(4), payload: Buffer.from(body.subarray(10, 10 + length)) };
}

export function syntheticECM({ channelId = 1, epoch = 0, parity = epoch & 1, transportMode = DEFAULT_TRANSPORT_MODE } = {}) {
  assert.ok(Number.isSafeInteger(channelId) && channelId > 0 && channelId <= 65535);
  assert.ok(Number.isSafeInteger(epoch) && epoch >= 0 && epoch <= 0xffffffff);
  assert.ok(parity === 0 || parity === 1);
  const mode = normalizeTransportMode(transportMode), modeCode = transportModeCode(mode);
  const tableParity = mode.tableMode === 'fixed80' ? 0 : mode.tableMode === 'inverse' ? parity ^ 1 : parity;
  const section = Buffer.alloc(24); section[0] = 0x80 | tableParity; section[1] = 0x70; section[2] = section.length - 3;
  section.write('ASTR', 3); section[7] = modeCode ? 2 : 1; section.writeUInt16BE(channelId, 8);
  if (mode.ecmMode === 'suffix-only') {
    assert.ok(epoch <= 0xffffff && parity === (epoch & 1), 'Suffix-only synthetic epoch must fit24bits and match its physical parity');
    section[7] = 3; section[15] = modeCode;
    createHash('sha256').update(`synthetic-ecm-suffix:${channelId}:mode:${modeCode}`).digest().copy(section, 16, 0, 5);
    section.writeUIntBE(epoch, 21, 3);
    // Bytes0..20 are deliberately identical across epochs. Only the three
    // bytes missed by the upstream section_length comparison may change.
    return section;
  }
  section.writeUInt32BE(epoch, 10); section[14] = parity;
  const body = createHash('sha256').update(`synthetic-ecm:${channelId}:${epoch}:${parity}${modeCode ? `:mode:${modeCode}` : ''}`).digest();
  if (modeCode) { section[15] = modeCode; body.copy(section, 16, 0, 8); } else body.copy(section, 15, 0, 9);
  return section;
}
export function cwForEpoch(channelId, epoch, transportMode = DEFAULT_TRANSPORT_MODE) {
  const mode = normalizeTransportMode(transportMode);
  const word = number => {
    const digest = createHash('sha256').update(`astra-synthetic-cw-v1:${channelId}:${number}`).digest(), key = Buffer.alloc(8);
    for (let group = 0; group < 2; group++) { for (let j = 0; j < 3; j++) key[group * 4 + j] = digest[group * 3 + j]; key[group * 4 + 3] = (key[group * 4] + key[group * 4 + 1] + key[group * 4 + 2]) & 255; }
    return key;
  };
  let words;
  if (mode.pairMode === 'current-next') words = epoch & 1 ? Buffer.concat([word(epoch + 1), word(epoch)]) : Buffer.concat([word(epoch), word(epoch + 1)]);
  else if (mode.pairMode === 'two-period-pair') { const base = epoch - (epoch & 1); words = Buffer.concat([word(base), word(base + 1)]); }
  else if (mode.pairMode === 'unchanged-pair') words = Buffer.concat([word(0), word(1)]);
  else words = epoch & 1 ? Buffer.concat([word(epoch - 1), word(epoch)]) : Buffer.concat([word(epoch), word(epoch - 1)]);
  if (mode.pairMode === 'selected-only') words.fill(0, ((epoch & 1) ^ 1) * 8, (((epoch & 1) ^ 1) + 1) * 8);
  if (mode.pairMode === 'opposite-only') words.fill(0, (epoch & 1) * 8, ((epoch & 1) + 1) * 8);
  return words;
}
export const syntheticCW = cwForEpoch;

// Bounded aggregate observations, not a cache or request admission policy.
// All identities below describe public synthetic ECMs; no key bytes or ECM
// digests are returned. Eviction makes distinct counts explicitly inexact.
export function createSyntheticRequestMetrics({ maxIdentities = 10000, maxChannels = 256, maxInFlight = 2048, maxRows = 4096 } = {}) {
  for (const [value, maximum] of [[maxIdentities, 10000], [maxChannels, 256], [maxInFlight, 2048], [maxRows, 4096]]) assert.ok(Number.isSafeInteger(value) && value > 0 && value <= maximum);
  const identities = new Map(), epochs = new Map(), channels = new Map(), outstanding = new Set();
  const totals = { requests: 0, uniqueIdentities: 0, uniqueEpochs: 0, duplicateRequests: 0, identityEvictions: 0, epochEvictions: 0, channelEvictions: 0, peakInFlight: 0, abandoned: 0, duplicateReplies: 0 };
  const bounds = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, null];
  const latency = { samples: 0, sumMs: 0, maxMs: 0, buckets: bounds.map(upperMs => ({ upperMs, count: 0 })) };
  const evict = (map, maximum, field) => { if (map.size > maximum) { map.delete(map.keys().next().value); totals[field]++; } };
  const release = token => {
    if (!outstanding.delete(token)) return false;
    token.identity.inFlight--; token.channel.inFlight--; return true;
  };
  return {
    begin({ channelId, epoch, parity, transportMode = DEFAULT_TRANSPORT_MODE }, now = performance.now()) {
      // syntheticECM also validates the identifier bounds, without retaining
      // its bytes. Its canonical body is determined by these three fields.
      const canonical = syntheticECM({ channelId, epoch, parity, transportMode }), modeCode = transportModeCode(transportMode), tableId = canonical[0];
      assert.ok(Number.isFinite(now)); assert.ok(outstanding.size < maxInFlight, 'Synthetic unresolved request bound exceeded');
      const identityName = canonical.toString('hex'), epochName = `${channelId}:${epoch}`;
      let channel = channels.get(channelId);
      if (!channel) { channel = { channelId, requests: 0, uniqueIdentities: 0, uniqueEpochs: 0, duplicateRequests: 0, replies: 0, rejected: 0, dropped: 0, abandoned: 0, inFlight: 0, peakInFlight: 0 }; channels.set(channelId, channel); evict(channels, maxChannels, 'channelEvictions'); }
      let identity = identities.get(identityName);
      if (!identity) {
        identity = { channelId, epoch, parity, tableId, modeCode, firstRequestAtMs: now, lastRequestAtMs: now, firstReplyAtMs: null, lastReplyAtMs: null,
          requests: 0, replies: 0, rejected: 0, dropped: 0, abandoned: 0, inFlight: 0, peakInFlight: 0 };
        identities.set(identityName, identity); evict(identities, maxIdentities, 'identityEvictions'); totals.uniqueIdentities++; channel.uniqueIdentities++;
      } else { totals.duplicateRequests++; channel.duplicateRequests++; }
      if (!epochs.has(epochName)) { epochs.set(epochName, true); evict(epochs, maxIdentities, 'epochEvictions'); totals.uniqueEpochs++; channel.uniqueEpochs++; }
      totals.requests++; channel.requests++; identity.requests++; identity.lastRequestAtMs = now; identity.inFlight++; channel.inFlight++;
      identity.peakInFlight = Math.max(identity.peakInFlight, identity.inFlight); channel.peakInFlight = Math.max(channel.peakInFlight, channel.inFlight);
      const token = { identity, channel, started: now, dropped: false, attempt: identity.requests }; outstanding.add(token); totals.peakInFlight = Math.max(totals.peakInFlight, outstanding.size); return token;
    },
    drop(token) {
      // A deliberately dropped reply is still unresolved on the wire. Only
      // a reply or connection closure can settle it from the provider's view.
      if (!outstanding.has(token) || token.dropped) return;
      token.dropped = true; token.identity.dropped++; token.channel.dropped++;
    },
    reply(token, { rejected = false } = {}, now = performance.now()) {
      assert.ok(Number.isFinite(now)); if (!release(token)) return false;
      token.identity.replies++; token.identity.firstReplyAtMs ??= now; token.identity.lastReplyAtMs = now;
      token.channel.replies++; if (rejected) { token.identity.rejected++; token.channel.rejected++; }
      const elapsed = Math.max(0, now - token.started); latency.samples++; latency.sumMs += elapsed; latency.maxMs = Math.max(latency.maxMs, elapsed);
      latency.buckets.find(bucket => bucket.upperMs === null || elapsed <= bucket.upperMs).count++; return true;
    },
    abandon(token) { if (release(token)) { totals.abandoned++; token.identity.abandoned++; token.channel.abandoned++; } },
    duplicateReply() { totals.duplicateReplies++; },
    hasReplied({ channelId, epoch, parity = epoch & 1, transportMode = DEFAULT_TRANSPORT_MODE }) {
      const identity = identities.get(syntheticECM({ channelId, epoch, parity, transportMode }).toString('hex'));
      return Boolean(identity && identity.replies > identity.rejected);
    },
    snapshot() {
      return { ...totals, uniqueCountsExact: !(totals.identityEvictions || totals.epochEvictions || totals.channelEvictions),
        trackedIdentities: identities.size, trackedEpochs: epochs.size, trackedChannels: channels.size,
        inFlight: outstanding.size, identityRowsTruncated: Math.max(0, identities.size - maxRows),
        responseLatency: { measurement: 'server-write-admission-not-client-receipt', samples: latency.samples, sumMs: Math.round(latency.sumMs * 1000) / 1000, maxMs: Math.round(latency.maxMs * 1000) / 1000, buckets: latency.buckets.map(bucket => ({ ...bucket })) },
        channels: [...channels.values()].map(channel => ({ ...channel })), keyEpochs: [...identities.values()].slice(0, maxRows).map(identity => ({ ...identity })) };
    },
  };
}

export async function startNewcamdProvider({ host = '127.0.0.1', port = 0, policy = () => ({}), fragmentSizes = [], fragmentDelayMs = 0, transportMode = DEFAULT_TRANSPORT_MODE } = {}) {
  loopback(host); assert.ok(Number.isSafeInteger(port) && port >= 0 && port <= 65535);
  assert.equal(typeof policy, 'function'); assert.ok(Array.isArray(fragmentSizes) && fragmentSizes.length <= 64 && fragmentSizes.every(n => Number.isSafeInteger(n) && n > 0 && n <= 4096));
  assert.ok(Number.isSafeInteger(fragmentDelayMs) && fragmentDelayMs >= 0 && fragmentDelayMs <= 1000);
  const mode = normalizeTransportMode(transportMode);
  const origin = performance.now(), peers = new Set(), peerIds = new WeakMap(), zeroReplyControls = new Map(), timers = new Map(), recent = [], events = [], semantic = createSyntheticRequestMetrics();
  // pending counts unfinished policy/write jobs; semantic.inFlight counts
  // unanswered requests, including deliberately dropped responses.
  const counts = { connections: 0, requests: 0, replies: 0, rejected: 0, dropped: 0, wrongCWReplies: 0, unmatchedReplies: 0, protocolErrors: 0, peakRequestsPerSecond: 0, requestRateSamplesTruncated: false, pending: 0 };
  let stopped = false;
  const note = event => { events.push({ atMs: Math.round(performance.now() - origin), ...event }); if (events.length > 1024) events.shift(); };
  const wait = milliseconds => stopped ? Promise.resolve() : new Promise(resolve => { const timer = setTimeout(() => { timers.delete(timer); resolve(); }, bounded(milliseconds, 0, 30000)); timers.set(timer, resolve); });
  const server = net.createServer(socket => {
    if (stopped || peers.size >= 128) { socket.destroy(); return; }
    socket.setNoDelay(true); peers.add(socket); const connectionId = ++counts.connections; peerIds.set(socket, connectionId);
    const greeting = randomBytes(14), base = Buffer.from(FIXTURE_CREDENTIALS.desKey, 'hex');
    let key = deriveKey(base, greeting), phase = 'login', pending = Buffer.alloc(0), writer = Promise.resolve(), lastRequest = null; const unanswered = new Set();
    const write = (bytes, action = {}) => {
      writer = writer.then(async () => {
        const sizes = action.fragmentSizes || fragmentSizes, delay = action.fragmentDelayMs ?? fragmentDelayMs;
        let offset = 0, index = 0;
        while (offset < bytes.length && !socket.destroyed && !stopped) {
          const size = sizes.length ? Math.max(1, bounded(sizes[index++ % sizes.length], bytes.length, 4096)) : bytes.length;
          const end = Math.min(bytes.length, offset + size); socket.write(bytes.subarray(offset, end)); offset = end;
          if (offset < bytes.length && delay) await wait(delay);
        }
        return offset === bytes.length;
      }).catch(() => { socket.destroy(); return false; });
      return writer;
    };
    zeroReplyControls.set(connectionId, async () => {
      if (stopped || socket.destroyed || phase !== 'ready' || !lastRequest) return false;
      const { channelId, epoch, command, message } = lastRequest;
      const response = Buffer.concat([Buffer.from([command, 0x10, 0]), cwForEpoch(channelId, epoch, mode)]);
      if (!await write(encode(response, key, { ...message, msgId: 0 }))) return false;
      counts.unmatchedReplies++; note({ kind: 'unmatched-zero-id-reply', connectionId }); return true;
    });
    socket.on('error', () => {}); socket.once('close', () => { for (const token of unanswered) semantic.abandon(token); unanswered.clear(); peers.delete(socket); zeroReplyControls.delete(connectionId); note({ kind: 'closed', connectionId }); });
    void write(greeting);
    socket.on('data', bytes => {
      if (pending.length + bytes.length > 65536) { counts.protocolErrors++; socket.destroy(); return; }
      pending = Buffer.concat([pending, bytes]);
      try {
        while (pending.length >= 2 && pending.length >= pending.readUInt16BE(0) + 2) {
          const length = pending.readUInt16BE(0) + 2; assert.ok(length >= 18 && length <= 1024);
          const frame = Buffer.from(pending.subarray(0, length)); pending = pending.subarray(length);
          const message = decode(frame, key), command = message.payload[0];
          if (phase === 'login') {
            const fields = message.payload.subarray(3).toString('utf8').split('\0');
            const valid = command === 0xe0 && fields[0] === FIXTURE_CREDENTIALS.username && fields[1] === fixturePasswordHash(FIXTURE_CREDENTIALS.password);
            void write(encode(Buffer.from([valid ? 0xe1 : 0xe2, 0, 0]), key, message));
            if (!valid) { phase = 'rejected'; continue; }
            key = deriveKey(base, Buffer.from(fields[1])); phase = 'card'; note({ kind: 'login', connectionId });
          } else if (phase === 'card') {
            assert.equal(command, 0xe3);
            const card = Buffer.alloc(26); card[0] = 0xe4; card[3] = 1; card[4] = 0x0b; card[14] = 1;
            void write(encode(card, key, message)); phase = 'ready'; note({ kind: 'ready', connectionId });
          } else if (phase === 'ready' && (command === 0x80 || command === 0x81)) {
            const payload = message.payload; assert.ok(payload.length === 24 && payload.toString('ascii', 3, 7) === 'ASTR' && [1, 2, 3].includes(payload[7]));
            const channelId = payload.readUInt16BE(8), epoch = payload[7] === 3 ? payload.readUIntBE(21, 3) : payload.readUInt32BE(10), parity = payload[7] === 3 ? epoch & 1 : payload[14];
            assert.ok(payload.equals(syntheticECM({ channelId, epoch, parity, transportMode: mode })), 'Synthetic ECM body must be canonical for its configured transport mode');
            lastRequest = { channelId, epoch, command, message: { msgId: message.msgId, serviceId: message.serviceId } };
            const token = semantic.begin({ channelId, epoch, parity, transportMode: mode }); unanswered.add(token); const attempt = token.attempt;
            counts.requests++; const now = performance.now(); recent.push(now); while (recent.length && now - recent[0] >= 1000) recent.shift(); counts.peakRequestsPerSecond = Math.max(counts.peakRequestsPerSecond, recent.length);
            if (recent.length > 10000) { recent.shift(); counts.requestRateSamplesTruncated = true; }
            const request = { channelId, epoch, parity, tableId: command, modeCode: transportModeCode(mode), serviceId: message.serviceId, msgId: message.msgId, attempt, connectionId };
            note({ kind: 'request', ...request });
            assert.ok(counts.pending < 2048); counts.pending++;
            void (async () => {
              try {
                const action = await policy({ ...request }) || {};
                if (socket.destroyed || stopped) return;
                if (action.delayMs) await wait(action.delayMs);
                if (socket.destroyed || stopped) return;
                if (action.close) { note({ kind: 'forced-close', ...request }); socket.destroy(); return; }
                if (action.drop) { counts.dropped++; semantic.drop(token); note({ kind: 'drop', ...request }); return; }
                const replyMode = action.pairMode ? normalizeTransportMode({ ...mode, pairMode: action.pairMode }) : mode;
                assert.ok(action.wrongCW === undefined || typeof action.wrongCW === 'boolean', 'Synthetic wrongCW policy must be explicit');
                // Diagnostic only: protocol correlation/checksums are valid,
                // but the provider deliberately supplies another channel's CW.
                const replyChannel = action.wrongCW ? channelId === 65535 ? 1 : channelId + 1 : channelId;
                const response = action.reject ? Buffer.from([command, 0, 0]) : Buffer.concat([Buffer.from([command, 0x10, 0]), action.zeroCW ? Buffer.alloc(16) : cwForEpoch(replyChannel, epoch, replyMode)]);
                if (!await write(encode(response, key, message), action)) return;
                if (!semantic.reply(token, { rejected: Boolean(action.reject) })) return; unanswered.delete(token);
                counts.replies++; if (action.reject) counts.rejected++; else if (action.wrongCW) counts.wrongCWReplies++;
                note({ kind: action.reject ? 'rejected' : 'reply', ...request, ...(action.wrongCW ? { wrongCW: true } : {}) });
                if (action.duplicate && await write(encode(response, key, message), action)) semantic.duplicateReply();
              } catch { counts.protocolErrors++; socket.destroy(); }
              finally { counts.pending--; }
            })();
          } else if (phase === 'ready' && command === 0xfd) void write(encode(Buffer.from([0xfd, 0, 0]), key, message));
          else throw new Error('Unexpected synthetic protocol phase');
        }
        if (pending.length >= 2) assert.ok(pending.readUInt16BE(0) + 2 <= 1024);
      } catch { counts.protocolErrors++; socket.destroy(); }
    });
  });
  server.listen(port, host); await once(server, 'listening');
  const controlledPeers = connectionId => {
    assert.ok(connectionId === null || Number.isSafeInteger(connectionId) && connectionId > 0, 'Synthetic connection control requires a positive connection ID or null');
    return [...peers].filter(peer => connectionId === null || peerIds.get(peer) === connectionId);
  };
  return { port: server.address().port, credentials: { ...FIXTURE_CREDENTIALS, host, port: server.address().port, transportMode: mode },
    hasReplied: (channelId, epoch) => semantic.hasReplied({ channelId, epoch, transportMode: mode }),
    setPolicy(next) { assert.equal(typeof next, 'function'); policy = next; },
    // Fault injection affects only sockets accepted by this disposable
    // loopback server. No socket references, addresses or key data escape.
    pauseReads(connectionId = null) { const selected = controlledPeers(connectionId); for (const peer of selected) peer.pause(); return selected.length; },
    resumeReads(connectionId = null) { const selected = controlledPeers(connectionId); for (const peer of selected) peer.resume(); return selected.length; },
    disconnect(connectionId = null) { const selected = controlledPeers(connectionId); for (const peer of selected) peer.destroy(); return selected.length; },
    reset(connectionId = null) { const selected = controlledPeers(connectionId); for (const peer of selected) { assert.equal(typeof peer.resetAndDestroy, 'function'); peer.resetAndDestroy(); } return selected.length; },
    // The reserved zero ID cannot match an ordinary fixture request. Its
    // valid encrypted frame is deliberately NOT a semantic completion.
    async sendZeroIdReply(connectionId) {
      assert.ok(Number.isSafeInteger(connectionId) && connectionId > 0, 'Synthetic zero-ID reply requires a positive connection ID');
      return zeroReplyControls.get(connectionId)?.() || false;
    },
    snapshot: () => ({ ...counts, activeConnections: peers.size, readPausedConnections: [...peers].filter(peer => peer.isPaused()).length,
      semantic: semantic.snapshot(), events: events.map(event => ({ ...event })) }),
    async close() { stopped = true; for (const [timer, resolve] of timers) { clearTimeout(timer); resolve(); } timers.clear(); for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}

export async function connectNewcamdClient({ host = '127.0.0.1', port, username = FIXTURE_CREDENTIALS.username, password = FIXTURE_CREDENTIALS.password, desKey = FIXTURE_CREDENTIALS.desKey, timeoutMs = 10000, transportMode = DEFAULT_TRANSPORT_MODE } = {}) {
  loopback(host); assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535); assert.match(desKey, /^[0-9a-f]{28}$/i);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000);
  for (const value of [username, password]) assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('\0'));
  const mode = normalizeTransportMode(transportMode);
  const socket = net.createConnection({ host, port }); socket.setNoDelay(true);
  const base = Buffer.from(desKey, 'hex'), waiters = new Map(), counters = { requests: 0, replies: 0, lateReplies: 0, protocolErrors: 0 };
  let pending = Buffer.alloc(0), greeting = null, key = null, nextId = 0;
  let greetingResolve, greetingReject;
  const greeted = new Promise((resolve, reject) => { greetingResolve = resolve; greetingReject = reject; });
  const greetingTimer = setTimeout(() => { greetingReject(new Error('Synthetic login timed out')); socket.destroy(); }, timeoutMs);
  const finish = () => { clearTimeout(greetingTimer); greetingReject(new Error('Synthetic connection closed')); for (const [, item] of waiters) { clearTimeout(item.timer); item.resolve({ ok: false, controlWords: null, msgId: item.msgId, closed: true, elapsedMs: performance.now() - item.started }); } waiters.clear(); };
  socket.on('error', () => {}); socket.once('close', finish);
  socket.on('data', bytes => {
    try {
      assert.ok(pending.length + bytes.length <= 65536); pending = Buffer.concat([pending, bytes]);
      if (!greeting) { if (pending.length < 14) return; greeting = Buffer.from(pending.subarray(0, 14)); pending = pending.subarray(14); key = deriveKey(base, greeting); clearTimeout(greetingTimer); greetingResolve(); }
      while (pending.length >= 2 && pending.length >= pending.readUInt16BE(0) + 2) {
        const length = pending.readUInt16BE(0) + 2; assert.ok(length >= 18 && length <= 1024);
        const message = decode(pending.subarray(0, length), key); pending = pending.subarray(length);
        const item = waiters.get(message.msgId);
        if (!item) { counters.lateReplies++; continue; }
        clearTimeout(item.timer); waiters.delete(message.msgId); counters.replies++;
        item.resolve({ ok: true, payload: message.payload, msgId: message.msgId, elapsedMs: performance.now() - item.started });
      }
    } catch { counters.protocolErrors++; socket.destroy(); }
  });
  const send = (payload, serviceId = 0, deadline = timeoutMs) => new Promise(resolve => {
    const msgId = nextId = nextId % 65535 + 1, started = performance.now();
    if (socket.destroyed || waiters.size >= 256) { resolve({ ok: false, controlWords: null, msgId, closed: true, elapsedMs: 0 }); return; }
    const timer = setTimeout(() => { waiters.delete(msgId); resolve({ ok: false, controlWords: null, msgId, timedOut: true, elapsedMs: performance.now() - started }); }, bounded(deadline, timeoutMs, 30000));
    waiters.set(msgId, { resolve, timer, started, msgId }); socket.write(encode(payload, key, { msgId, serviceId }));
  });
  try {
    await greeted;
    const login = await send(Buffer.concat([Buffer.from([0xe0, 0, 0]), Buffer.from(`${username}\0${fixturePasswordHash(password)}\0`)]));
    assert.ok(login.ok && login.payload[0] === 0xe1, 'Synthetic Newcamd login must succeed');
    key = deriveKey(base, Buffer.from(fixturePasswordHash(password)));
    const card = await send(Buffer.from([0xe3, 0, 0])); assert.ok(card.ok && card.payload[0] === 0xe4, 'Synthetic card data must be valid');
  } catch (error) { socket.destroy(); throw error; }
  return { requestECM: async ({ channelId = 1, epoch = 0, parity = epoch & 1, serviceId = channelId, timeoutMs: deadline = timeoutMs, transportMode: requestMode = mode } = {}) => {
    counters.requests++; const reply = await send(syntheticECM({ channelId, epoch, parity, transportMode: requestMode }), serviceId, deadline);
    return { ok: Boolean(reply.ok && reply.payload.length === 19), controlWords: reply.ok && reply.payload.length === 19 ? Buffer.from(reply.payload.subarray(3)) : null, msgId: reply.msgId, elapsedMs: reply.elapsedMs, ...(reply.timedOut ? { timedOut: true } : {}), ...(reply.closed ? { closed: true } : {}) };
  }, snapshot: () => ({ ...counters, pending: waiters.size, connected: !socket.destroyed }), close: () => socket.destroy() };
}
