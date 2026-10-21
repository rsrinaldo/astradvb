import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const read = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');

test('channel tab changes cannot hide tuner, scan, profile or export dialog bodies', async () => {
  const source = await read('app.js');
  const fn = source.slice(source.indexOf('function selectTab('), source.indexOf('function toast('));
  const tab = id => ({ dataset: { tab: id }, attributes: {}, classList: { toggle() {} }, setAttribute(key, value) { this.attributes[key] = value; } });
  const tabs = ['general', 'delivery', 'advanced'].map(tab), panels = tabs.map(t => ({ dataset: { panel: t.dataset.tab }, classList: { toggle() {} } }));
  const selectors = [];
  const context = vm.createContext({ $$: selector => {
    selectors.push(selector);
    assert.ok(selector.startsWith('#stream-dialog '), 'Only the channel editor may be changed');
    return selector.endsWith('.tab') ? tabs : panels;
  } });
  vm.runInContext(fn + '; selectTab("delivery");', context);
  assert.equal(tabs[1].attributes['aria-selected'], 'true'); assert.equal(tabs[1].tabIndex, 0);
  assert.equal(tabs[0].tabIndex, -1); assert.equal(selectors.length, 2);
});

test('source fields belong to the padded general panel and tab IDs/ARIA bindings agree', async () => {
  const html = await read('index.html');
  const general = html.slice(html.indexOf('id="stream-panel-general"'), html.indexOf('id="stream-panel-delivery"'));
  assert.match(general, /name="serviceId"/); assert.match(general, /name="tvheadendUUID"/);
  assert.match(general, /name="inputs"/);
  for (const name of ['general', 'delivery', 'advanced']) {
    assert.ok(html.includes(`aria-controls="stream-panel-${name}"`));
    assert.ok(html.includes(`aria-labelledby="stream-tab-${name}"`));
  }
  assert.doesNotMatch(html, /href="\/enhancements\.css/);
  const source = await read('app.js'); assert.match(source, /addEventListener\('invalid'/); assert.match(source, /ArrowLeft.*ArrowRight.*Home.*End/);
  assert.doesNotMatch(source, /style="/); assert.match(source, /class="tuner-meter"/);
});

test('panel runtime summary contains uptime/version only, without engine labels or dots', async () => {
  const html = await read('index.html'), source = await read('app.js');
  assert.doesNotMatch(html, /Native engine|id="engine-status"/);
  assert.doesNotMatch(source, /Engine online|Engine offline/);
  const summary = source.split('\n').find(line => line.includes("$('#engine-detail').textContent"));
  assert.match(summary, /Uptime.*status\.version/); assert.doesNotMatch(summary, /backend|status\.engine/);
});

test('theme text, secondary text and state colours have readable contrast on panels', async () => {
  const css = await read('styles.css');
  const token = name => css.match(new RegExp(`--${name}:\\s*(#[a-f0-9]{6})`, 'i'))[1];
  const luminance = hex => {
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  for (const name of ['text', 'muted', 'green', 'amber', 'red', 'purple']) assert.ok(contrast(token(name), token('panel')) >= 4.5, `${name} text contrast`);
  assert.ok(contrast('#10223f', token('cyan')) >= 4.5, 'Primary action text contrast');
  assert.match(css, /prefers-reduced-motion/);
});

test('bulk controls report accepted jobs without optimistic channel changes or duplicate submissions', async () => {
  const source = await read('app.js'), html = await read('index.html');
  for (const id of ['enable-selected-streams', 'disable-selected-streams', 'stream-operation-progress', 'clear-stream-selection']) assert.ok(html.includes(`id="${id}"`));
  const fn = source.slice(source.indexOf('async function setSelectedEnabled('), source.indexOf('function showView('));
  const requests = [], notices = [], stream = { id: 'one', enabled: false };
  const state = { selectedStreams: new Set(['one']), streams: [stream], status: {}, config: {} };
  const context = vm.createContext({ state, confirm: () => true, renderStreams() {}, async refresh() {}, toast: (...args) => notices.push(args),
    api: async (path, options) => { requests.push({ path, body: JSON.parse(options.body) }); return { job: { id: 'job', state: 'queued' } }; } });
  vm.runInContext('let bulkRequestPending = false; ' + fn, context);
  await vm.runInContext('setSelectedEnabled(true)', context);
  assert.deepEqual(requests, [{ path: '/api/streams/state', body: { ids: ['one'], enabled: true } }]);
  assert.equal(stream.enabled, false, 'Only refreshed server state may change channel status');
  assert.equal(state.config, null); assert.equal(state.status.bulkState.state, 'queued');
  await vm.runInContext('setSelectedEnabled(true)', context); assert.equal(requests.length, 1);
  delete state.status.bulkState;
  context.api = async () => { throw new Error('Synthetic failure'); };
  await vm.runInContext('setSelectedEnabled(true)', context);
  assert.equal(stream.enabled, false); assert.deepEqual(notices.at(-1), ['Synthetic failure', true]);
});

test('selection controls count hidden selections and expose server-reported partial failures', async () => {
  const source = await read('app.js');
  const fn = source.slice(source.indexOf('function renderStreams('), source.indexOf('function renderSessions('));
  const elements = new Map();
  const state = { streams: [{ id: 'one', name: 'Rai', enabled: false, state: 'stopped' }, { id: 'two', name: 'Film', enabled: true, state: 'running' }], selectedStreams: new Set(['one', 'two']), sessions: [], query: 'Rai', status: { bulkState: { enabled: true, total: 2, completed: 1, applied: ['two'], unchanged: [], state: 'failed', error: 'Synthetic failure' } } };
  const context = vm.createContext({ state, bulkRequestPending: false, escapeHTML: x => String(x ?? ''), streamRatesMarkup: () => '', duration: () => '', $: id => {
    if (!elements.has(id)) elements.set(id, { classList: { toggle() {} } }); return elements.get(id);
  } });
  vm.runInContext(fn + ';renderStreams()', context);
  assert.equal(elements.get('#enable-selected-streams').disabled, false);
  assert.equal(elements.get('#disable-selected-streams').disabled, false);
  assert.match(elements.get('#stream-selection-count').textContent, /2 selected.*1 hidden/);
  assert.match(elements.get('#stream-operation-progress').textContent, /1\/2.*stopped: Synthetic failure/);
  state.status.bulkState.state = 'running';
  vm.runInContext('renderStreams()', context);
  assert.equal(elements.get('#enable-selected-streams').disabled, true);
  assert.equal(elements.get('#delete-selected-streams').disabled, true);
});
