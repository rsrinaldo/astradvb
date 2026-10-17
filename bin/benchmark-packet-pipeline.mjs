// Generated clear transport only: no sockets, subprocesses, configuration,
// broadcaster data, credentials, ECMs or keys. Run in a fresh Node process.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]);
const pattern = process.argv[3];
const iterations = Number(process.argv[4] || 100000);
assert.ok(['media', 'pat', 'si'].includes(pattern));
assert.ok(Number.isSafeInteger(iterations) && iterations >= 512 && iterations <= 200000);
const { PacketPipeline } = await import(pathToFileURL(join(root, 'src/packet-pipeline.mjs')));
const { StreamMetadata, mpegCRC32 } = await import(pathToFileURL(join(root, 'src/si-metadata.mjs')));
function section(header, body = Buffer.alloc(0)) {
  const data = Buffer.concat([Buffer.from(header), body, Buffer.alloc(4)]);
  data[1] = 0xb0 | ((data.length - 3) >> 8); data[2] = (data.length - 3) & 255;
  data.writeUInt32BE(mpegCRC32(data.subarray(0, -4)), data.length - 4); return data;
}
const pat = section([0, 0, 0, 0, 1, 0xc1, 0, 0], Buffer.from([0, 1, 0xe0, 100]));
const name = Buffer.from('Synthetic');
const descriptor = Buffer.concat([Buffer.from([0x48, name.length + 3, 1, 0, name.length]), name]);
const sdt = section([0x42, 0, 0, 0, 1, 0xc1, 0, 0, 0, 1, 0xff], Buffer.concat([Buffer.from([0, 1, 0xfc, 0x80, descriptor.length]), descriptor]));
const eit = section([0x4e, 0, 0, 0, 1, 0xc1, 0, 0, 0, 1, 0, 1, 0, 0x4e]);
const sender = new StreamMetadata('Sender'); const counters = [0, 0];
const sources = Array.from({ length: 512 }, (_, index) => {
  const packets = [];
  if (pattern !== 'media') packets.push(sender.packets(0, pat));
  if (pattern === 'si') packets.push(sender.packets(17, sdt), sender.packets(18, eit));
  while (packets.length < 21) {
    const audio = packets.length % 3 === 0, pid = audio ? 257 : 256;
    const packet = Buffer.alloc(188, 0xaa), keyframe = !audio && packets.length === (pattern === 'media' ? 1 : pattern === 'pat' ? 1 : 4);
    packet.set([0x47, (pid >> 8) | (keyframe ? 0x40 : 0), pid & 255, (keyframe ? 0x30 : 0x10) | (counters[Number(audio)]++ & 15)]);
    if (keyframe) packet.set([1, 0x40], 4);
    packet.writeUInt32BE(index, 30); packets.push(packet);
  }
  const data = Buffer.from(new SharedArrayBuffer(21 * 188));
  let offset = 0; for (const packet of packets) { data.set(packet, offset); offset += packet.length; }
  return data;
});
const pipeline = new PacketPipeline({ id: 'synthetic', name: 'Synthetic Ë Ç', serviceId: 1, hls: true, camEnabled: false }, { hlsSegmentSeconds: 2, hlsWindowSegments: 3 });
const av = (hash, data) => {
  for (let offset = 0; offset < data.length; offset += 188) {
    const pid = ((data[offset + 1] & 31) << 8) | data[offset + 2];
    if (pid === 256 || pid === 257) hash.update(data.subarray(offset, offset + 188));
  }
};
const expected = createHash('sha256'), actual = createHash('sha256');
for (let index = 0; index < sources.length; index++) {
  av(expected, sources[index]); av(actual, pipeline.process('output', sources[index], index * 3)); pipeline.releasePublishedMedia();
}
assert.equal(actual.digest('hex'), expected.digest('hex'), 'exact ordered A/V');
global.gc?.();
const before = process.cpuUsage(), started = performance.now();
for (let index = 0; index < iterations; index++) {
  pipeline.process('output', sources[index % sources.length], (index + sources.length) * 3);
  pipeline.releasePublishedMedia();
}
const elapsedMs = performance.now() - started, cpu = process.cpuUsage(before);
const cpuMs = (cpu.user + cpu.system) / 1000, inputBytes = iterations * sources[0].length;
const metrics = pipeline.analyzer.snapshot();
assert.equal(metrics.continuityErrors, 0);
global.gc?.();
console.log(JSON.stringify({ pattern, iterations, inputBytes, exactAV: true, continuityErrors: metrics.continuityErrors,
  cpuMs, cpuMsPerMiB: cpuMs / (inputBytes / 1048576), elapsedMs,
  maxRSSKiB: process.resourceUsage().maxRSS, memory: process.memoryUsage(),
  measurement: 'generated-packet-pipeline-not-live-capacity' }));
