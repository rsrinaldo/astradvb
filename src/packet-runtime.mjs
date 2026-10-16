import { parentPort } from 'node:worker_threads';
import { PacketPipeline } from './packet-pipeline.mjs';

const channels = new Map();
let segments = [];
parentPort.on('message', message => {
  if (message.type === 'register') {
    const pipeline = new PacketPipeline(message.config, message.settings, segment => segments.push({ handle: message.handle, segment: { ...segment } }));
    channels.set(message.handle, pipeline);
    parentPort.postMessage({ type: 'registered', handle: message.handle }); return;
  }
  if (message.type === 'remove') { channels.delete(message.handle); return; }
  if (message.type !== 'batch') return;
  const pipeline = channels.get(message.handle);
  const output = []; const completed = [];
  if (pipeline) for (const operation of message.operations) {
    if (operation.kind === 'barrier') { completed.push(operation.request); continue; }
    const data = operation.data ? Buffer.from(operation.data.buffer, operation.data.byteOffset, operation.data.byteLength) : null;
    const bytes = pipeline.process(operation.kind, data, operation.now);
    if (bytes?.length) output.push(bytes);
  }
  const metrics = pipeline && (!pipeline.sampled || completed.length) ? pipeline.snapshot(true) : null;
  if (pipeline) pipeline.sampled = true;
  parentPort.postMessage({ type: 'batch', batch: message.batch, handle: message.handle, output, completed, metrics, segments });
  segments = []; pipeline?.releasePublishedMedia();
});
const timer = setInterval(() => {
  const metrics = [...channels].map(([handle, pipeline]) => ({ handle, metrics: pipeline.snapshot() }));
  parentPort.postMessage({ type: 'metrics', channels: metrics });
}, 1000);
timer.unref();
