const state = { status: null, streams: [], adapters: [], sessions: [], logs: [], config: null, query: '', editing: null, editingProfile: null, editingAdapter: null, token: sessionStorage.getItem('astra-token') || '' };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(state.token ? { authorization: `Bearer ${state.token}` } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Request failed: ${response.status}`);
  return value;
}

async function refresh() {
  try {
    const [status, streams, adapters, sessions, logs] = await Promise.all([
      api('/api/status'), api('/api/streams'), api('/api/adapters'), api('/api/sessions'), api('/api/logs?limit=100'),
    ]);
    Object.assign(state, { status, streams: streams.streams, adapters: adapters.adapters, sessions: sessions.sessions, logs: logs.logs });
    render();
  } catch (error) { toast(error.message, true); }
}

async function loadConfig() {
  try { state.config = await api('/api/config'); $('#auth-state').textContent = 'Configuration access granted.'; fillSettings(); return state.config; }
  catch (error) { $('#auth-state').textContent = error.message; throw error; }
}

function render() {
  const status = state.status || { engine: 'offline', uptimeSeconds: 0, streams: {}, sessions: 0, memory: {} };
  $('#engine-status').textContent = status.engine === 'online' ? 'Engine online' : 'Engine offline';
  $('#engine-detail').textContent = `Uptime ${duration(status.uptimeSeconds)} · v${status.version || '?'}`;
  const protectedAccess = status.authentication === 'enabled';
  $('#token-controls').classList.toggle('hidden', !protectedAccess);
  $('#auth-help').textContent = protectedAccess ? 'Enter the token configured in ASTRA_ADMIN_TOKEN. It stays in this browser tab.' : 'Anyone who can reach this server can change its configuration.';
  if (!protectedAccess) $('#auth-state').textContent = 'Open access enabled';
  for (const [id, path] of [['playlist-url', '/playlist.m3u'], ['epg-xml-url', '/epg.xml'], ['epg-json-url', '/api/epg']]) { const link = $(`#${id}`); link.href = path; link.textContent = `${location.origin}${path}`; }
  const bitrate = state.streams.reduce((sum, stream) => sum + (stream.bitrateKbps || 0), 0);
  const running = state.streams.filter((stream) => stream.state === 'running').length;
  $('#metrics').innerHTML = [
    ['●', 'Running streams', `${running}/${state.streams.length}`, `${status.streams?.warning || 0} need attention`],
    ['⌁', 'Aggregate bitrate', `${(bitrate / 1000).toFixed(1)} Mb/s`, 'Measured MPEG-TS payload'],
    ['◉', 'DVB adapters', `${state.adapters.length}`, 'Configured Linux frontends'],
    ['♙', 'HTTP sessions', `${status.sessions || 0}`, 'Connected relay clients'],
  ].map(([icon, label, value, detail]) => `<article class="metric"><span class="metric-icon">${icon}</span><div><label>${label}</label><strong>${value}</strong><small>${detail}</small></div></article>`).join('');
  renderAdapters(); renderStreams(); renderSessions(); renderLogs();
}

function renderAdapters() {
  $('#adapter-count').textContent = state.adapters.length;
  $('#adapters').innerHTML = state.adapters.length ? state.adapters.map((adapter) => {
    const signal = adapter.signal ? `${number(adapter.signal.value)}${escapeHTML(adapter.signal.unit || '')}` : '—';
    const quality = adapter.quality || (adapter.lock ? 'Locked' : '—');
    const status = adapter.detected ? (adapter.configured ? adapter.status : 'new hardware') : 'missing';
    return `<article class="adapter-card" data-adapter-id="${escapeHTML(adapter.id)}"><div class="adapter-top"><div><h3>${escapeHTML(adapter.name)}</h3><p>adapter${number(adapter.adapter)} / frontend${number(adapter.frontend)} · ${escapeHTML(adapter.deliverySystem || 'not configured')}</p></div><span class="state ${adapter.lock ? 'running' : 'warning'}">${escapeHTML(status)}</span></div><div class="signal"><span>Signal</span><strong>${signal}</strong></div><div class="signal"><span>Quality</span><strong>${escapeHTML(quality)}</strong></div><small class="adapter-source">${escapeHTML(adapter.configured ? adapter.inputUrl : 'Click to configure')}</small></article>`;
  }).join('') : '<div class="empty">No DVB hardware detected. Connected Linux DVB frontends appear here automatically.</div>';
}

function renderStreams() {
  const streams = state.streams.filter((stream) => `${stream.name} ${stream.id}`.toLowerCase().includes(state.query.toLowerCase()));
  $('#stream-count').textContent = streams.length;
  $('#streams').innerHTML = streams.length ? streams.map((stream) => `<article class="stream-card" data-stream="${escapeHTML(stream.id)}"><div class="stream-main"><span class="stream-orb ${escapeHTML(stream.state)}">⌁</span><div><h3>${escapeHTML(stream.name)}</h3><p>${escapeHTML(stream.id)} · input #${stream.activeInput >= 0 ? stream.activeInput + 1 : '—'}</p></div></div><div class="stream-foot"><strong>${number(stream.bitrateKbps).toLocaleString()} <small>Kbit/s</small></strong><span class="state ${escapeHTML(stream.state)}">${escapeHTML(stream.state)}</span></div></article>`).join('') : '<div class="empty">No streams match the current view.</div>';
}

function renderSessions() {
  $('#session-summary').textContent = `${state.sessions.length} active connections`;
  $('#session-rows').innerHTML = state.sessions.length ? state.sessions.map((session) => `<tr><td>${escapeHTML(streamName(session.streamId))}</td><td><code>${escapeHTML(session.ip || '')}</code></td><td>${escapeHTML(new Date(session.connectedAt).toLocaleString())}</td><td>${escapeHTML(session.userAgent || '—')}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">No active HTTP relay sessions.</td></tr>';
}

function renderLogs() {
  $('#log-lines').innerHTML = state.logs.length ? state.logs.map((entry) => { const date = new Date(entry.time); return `<div class="log-line"><time data-short="${date.toLocaleTimeString()}">${date.toLocaleString()}</time><span class="level-${escapeHTML(entry.level)}">${escapeHTML(entry.level.toUpperCase())}</span><span class="source">[${escapeHTML(entry.source)}]</span><span class="message">${escapeHTML(entry.message)}</span></div>`; }).join('') : '<div class="empty">No events recorded since this service started.</div>';
}

function fillSettings() {
  if (!state.config) return;
  const form = $('#settings-form');
  for (const [key, value] of Object.entries(state.config.settings || {})) if (form.elements[key]) form.elements[key].value = value;
  renderCASProfiles();
}

function renderCASProfiles() {
  const profiles = state.config?.casProfiles || [];
  $('#cas-profiles').innerHTML = profiles.length ? profiles.map((profile) => `<div class="profile-row" data-profile="${escapeHTML(profile.id)}"><div><strong>${escapeHTML(profile.name)}</strong><small>${escapeHTML(profile.id)}${profile.caid ? ` · CAID ${escapeHTML(profile.caid)}` : ''}${profile.serviceId ? ` · service ${number(profile.serviceId)}` : ''}</small></div><span class="profile-state">${profile.configured ? 'Configured' : 'Missing key'}</span></div>`).join('') : '<p class="muted">No Newcamd profiles configured.</p>';
}

async function openAdapter(id = null) {
  try {
    const config = state.config || await loadConfig();
    const live = id ? state.adapters.find((item) => item.id === id) : state.adapters.find((item) => !item.configured);
    const saved = id ? config.adapters.find((item) => item.id === id) : null;
    const adapter = saved || live || { id: '', name: '', enabled: true, adapter: 0, frontend: 0, demux: 0, deliverySystem: 'DVBS2', frequencyMHz: 0, symbolRateKsym: 0, bandwidthMHz: 8, polarization: 'HORIZONTAL', modulation: '', fec: 'AUTO', lnb: 'UNIVERSAL', diseqc: -1, unicableKHz: 0 };
    state.editingAdapter = saved?.id || null;
    const form = $('#adapter-form');
    const detected = state.adapters.filter((item) => item.detected);
    const deviceValue = `${adapter.adapter}:${adapter.frontend}`;
    const deviceOptions = detected.map((item) => `<option value="${item.adapter}:${item.frontend}">adapter${item.adapter} / frontend${item.frontend}${item.configured ? ` · ${escapeHTML(item.name)}` : ' · new'}</option>`);
    if (!detected.some((item) => `${item.adapter}:${item.frontend}` === deviceValue)) deviceOptions.push(`<option value="${deviceValue}">adapter${adapter.adapter} / frontend${adapter.frontend}${saved ? ' · currently missing' : ' · manual'}</option>`);
    form.elements.device.innerHTML = deviceOptions.join(''); form.elements.device.value = deviceValue;
    for (const key of ['id', 'name', 'deliverySystem', 'frequencyMHz', 'symbolRateKsym', 'bandwidthMHz', 'polarization', 'modulation', 'fec', 'lnb', 'diseqc', 'unicableKHz']) if (form.elements[key]) form.elements[key].value = adapter[key] ?? '';
    form.elements.id.disabled = Boolean(saved); form.elements.enabled.checked = adapter.enabled !== false;
    form.elements.inputUrl.value = `dvb://${adapter.id || live?.id || 'adapter0-frontend0'}`;
    $('#adapter-dialog-title').textContent = saved ? adapter.name : live ? 'Configure detected adapter' : 'Configure DVB adapter';
    $('#delete-adapter').classList.toggle('hidden', !saved); $('#use-adapter-stream').classList.toggle('hidden', !saved);
    $('#adapter-dialog').showModal();
  } catch (error) { toast(error.message, true); }
}

async function saveAdapter(event) {
  event.preventDefault(); const form = event.currentTarget;
  const [adapterNumber, frontend] = form.elements.device.value.split(':').map(Number);
  const id = state.editingAdapter || form.elements.id.value.trim();
  const adapter = { id, name: form.elements.name.value.trim(), enabled: form.elements.enabled.checked, adapter: adapterNumber, frontend, demux: Number(form.elements.demux.value) || 0, deliverySystem: form.elements.deliverySystem.value, frequencyMHz: Number(form.elements.frequencyMHz.value) || 0, symbolRateKsym: Number(form.elements.symbolRateKsym.value) || 0, bandwidthMHz: Number(form.elements.bandwidthMHz.value) || 8, polarization: form.elements.polarization.value, modulation: form.elements.modulation.value.trim(), fec: form.elements.fec.value.trim() || 'AUTO', lnb: form.elements.lnb.value.trim() || 'UNIVERSAL', diseqc: Number(form.elements.diseqc.value), unicableKHz: Number(form.elements.unicableKHz.value) || 0 };
  const adapters = [...(state.config?.adapters || []).filter((item) => item.id !== id), adapter];
  try { await api('/api/adapters', { method: 'PUT', body: JSON.stringify({ adapters }) }); $('#adapter-dialog').close(); state.config = null; await refresh(); toast(`${adapter.name} saved`); }
  catch (error) { toast(error.message, true); }
}

async function deleteAdapter() {
  if (!state.editingAdapter || !confirm(`Delete adapter ${state.editingAdapter}?`)) return;
  const adapters = (state.config?.adapters || []).filter((item) => item.id !== state.editingAdapter);
  try { await api('/api/adapters', { method: 'PUT', body: JSON.stringify({ adapters }) }); $('#adapter-dialog').close(); state.config = null; await refresh(); toast('Adapter configuration deleted'); }
  catch (error) { toast(error.message, true); }
}

async function useAdapterInStream() {
  const id = state.editingAdapter; if (!id) return;
  $('#adapter-dialog').close(); await openStream(null, `dvb://${id}`);
}

async function openCASProfile(id = null) {
  const config = state.config || await loadConfig(); const profile = id ? config.casProfiles.find((item) => item.id === id) : { id: '', name: '', caid: '', serviceId: 0, emm: false };
  if (!profile) return toast('CAS profile not found', true);
  state.editingProfile = id; const form = $('#cas-profile-form');
  form.elements.id.value = profile.id; form.elements.id.disabled = Boolean(id); form.elements.name.value = profile.name; form.elements.line.value = ''; form.elements.line.required = !profile.configured;
  form.elements.caid.value = profile.caid || ''; form.elements.serviceId.value = profile.serviceId || 0; form.elements.emm.checked = Boolean(profile.emm);
  $('#cas-profile-title').textContent = id ? profile.name : 'New Newcamd profile'; $('#delete-cas-profile').classList.toggle('hidden', !id); $('#cas-profile-dialog').showModal();
}

async function saveCASProfile(event) {
  event.preventDefault(); const form = event.currentTarget; const id = state.editingProfile || form.elements.id.value.trim();
  const profile = { id, name: form.elements.name.value.trim(), caid: form.elements.caid.value.trim(), serviceId: Number(form.elements.serviceId.value) || 0, emm: form.elements.emm.checked };
  if (form.elements.line.value.trim()) profile.line = form.elements.line.value.trim();
  const profiles = [...(state.config?.casProfiles || []).filter((item) => item.id !== id), profile];
  try { await api('/api/cas-profiles', { method: 'PUT', body: JSON.stringify({ profiles }) }); $('#cas-profile-dialog').close(); state.config = null; await loadConfig(); toast(`${profile.name} saved`); } catch (error) { toast(error.message, true); }
}

async function deleteCASProfile() {
  if (!state.editingProfile || !confirm(`Delete CAS profile ${state.editingProfile}?`)) return;
  const profiles = (state.config?.casProfiles || []).filter((profile) => profile.id !== state.editingProfile);
  try { await api('/api/cas-profiles', { method: 'PUT', body: JSON.stringify({ profiles }) }); $('#cas-profile-dialog').close(); state.config = null; await loadConfig(); toast('CAS profile deleted'); } catch (error) { toast(error.message, true); }
}

async function openStream(id = null, initialInput = '') {
  try {
    const config = state.config || await loadConfig();
    const stream = id ? config.streams.find((item) => item.id === id) : { id: '', name: '', enabled: false, inputs: [], outputs: [], hls: true, http: true, onDemand: false, keepActiveSeconds: 0, cam: { enabled: false, profile: 'default' } };
    if (!stream) throw new Error('Stream configuration not found');
    state.editing = id;
    const form = $('#stream-form');
    form.elements.name.value = stream.name || '';
    form.elements.id.value = stream.id || '';
    form.elements.id.disabled = Boolean(id);
    form.elements.enabled.checked = Boolean(stream.enabled);
    form.elements.inputs.value = initialInput || (stream.inputs || []).map((input) => input.url).join('\n');
    form.elements.outputs.value = (stream.outputs || []).map((output) => output.url).join('\n');
    form.elements.http.checked = stream.http !== false; form.elements.hls.checked = stream.hls !== false;
    form.elements.onDemand.checked = Boolean(stream.onDemand); form.elements.keepActiveSeconds.value = stream.keepActiveSeconds || 0;
    form.elements.camEnabled.checked = Boolean(stream.cam?.enabled);
    const profiles = [{ id: 'default', name: 'Select a profile' }, ...(config.casProfiles || []).filter((profile) => profile.id !== 'default')];
    form.elements.camProfile.innerHTML = profiles.map((profile) => `<option value="${escapeHTML(profile.id)}">${escapeHTML(profile.name)} (${escapeHTML(profile.id)})</option>`).join('');
    form.elements.camProfile.value = stream.cam?.profile || 'default';
    $('#stream-dialog-title').textContent = id ? stream.name : 'New stream';
    $('#delete-stream').classList.toggle('hidden', !id);
    selectTab('general'); $('#stream-dialog').showModal();
  } catch (error) { toast(error.message, true); if (state.status?.authentication === 'enabled') showView('settings'); }
}

async function saveStream(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = state.editing || form.elements.id.value.trim();
  const value = { id, name: form.elements.name.value.trim(), enabled: form.elements.enabled.checked, inputs: lines(form.elements.inputs.value).map((url) => ({ url })), outputs: lines(form.elements.outputs.value).map((url) => ({ url })), http: form.elements.http.checked, hls: form.elements.hls.checked, onDemand: form.elements.onDemand.checked, keepActiveSeconds: Number(form.elements.keepActiveSeconds.value) || 0, cam: { enabled: form.elements.camEnabled.checked, profile: form.elements.camProfile.value.trim() || 'default' } };
  try {
    await api(state.editing ? `/api/streams/${encodeURIComponent(id)}` : '/api/streams', { method: state.editing ? 'PUT' : 'POST', body: JSON.stringify(value) });
    $('#stream-dialog').close(); state.config = null; await refresh(); toast(`${value.name} saved`);
  } catch (error) { toast(error.message, true); }
}

async function deleteStream() {
  if (!state.editing || !confirm(`Delete stream ${state.editing}?`)) return;
  try { await api(`/api/streams/${encodeURIComponent(state.editing)}`, { method: 'DELETE' }); $('#stream-dialog').close(); state.config = null; await refresh(); toast('Stream deleted'); }
  catch (error) { toast(error.message, true); }
}

function showView(id) { $$('.view').forEach((view) => view.classList.toggle('active', view.id === id)); $$('.nav').forEach((button) => button.classList.toggle('active', button.dataset.view === id)); if (id === 'settings') loadConfig().catch(() => {}); }
function selectTab(id) { $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === id)); $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === id)); }
function toast(message, failed = false) { const node = $('#toast'); node.textContent = message; node.style.borderColor = failed ? '#fa707055' : ''; node.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 2800); }
function streamName(id) { return state.streams.find((stream) => stream.id === id)?.name || id; }
function lines(value) { return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function duration(seconds) { const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); return days ? `${days}d ${hours}h` : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`; }
function escapeHTML(value) { return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }

$$('.nav').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
$$('.tab').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.tab)));
$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.closeDialog}`).close()));
$('#refresh').addEventListener('click', refresh);
$('#search').addEventListener('input', (event) => { state.query = event.target.value; renderStreams(); });
$('#new-stream').addEventListener('click', () => openStream());
$('#export-streams').addEventListener('click', () => $('#export-dialog').showModal());
$('#new-adapter').addEventListener('click', () => openAdapter());
$('#streams').addEventListener('click', (event) => { const card = event.target.closest('[data-stream]'); if (card) openStream(card.dataset.stream); });
$('#adapters').addEventListener('click', (event) => { const card = event.target.closest('[data-adapter-id]'); if (card) openAdapter(card.dataset.adapterId); });
$('#stream-form').addEventListener('submit', saveStream);
$('#delete-stream').addEventListener('click', deleteStream);
$('#settings-form').addEventListener('submit', async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); for (const key of Object.keys(data)) data[key] = Number(data[key]); try { await api('/api/settings', { method: 'PUT', body: JSON.stringify(data) }); state.config = null; await refresh(); toast('Runtime settings applied'); } catch (error) { toast(error.message, true); } });
$('#new-cas-profile').addEventListener('click', () => openCASProfile());
$('#cas-profiles').addEventListener('click', (event) => { const row = event.target.closest('[data-profile]'); if (row) openCASProfile(row.dataset.profile); });
$('#cas-profile-form').addEventListener('submit', saveCASProfile);
$('#delete-cas-profile').addEventListener('click', deleteCASProfile);
$('#save-token').addEventListener('click', () => { state.token = $('#admin-token').value; sessionStorage.setItem('astra-token', state.token); state.config = null; loadConfig().then(() => toast('Administrator access enabled')).catch((error) => toast(error.message, true)); });
$('#adapter-form').addEventListener('submit', saveAdapter);
$('#delete-adapter').addEventListener('click', deleteAdapter);
$('#use-adapter-stream').addEventListener('click', useAdapterInStream);
$('#adapter-form').elements.device.addEventListener('change', (event) => {
  if (state.editingAdapter) return;
  const [adapter, frontend] = event.target.value.split(':').map(Number); const id = `adapter${adapter}-frontend${frontend}`;
  $('#adapter-form').elements.id.value = id; $('#adapter-form').elements.name.value = `DVB adapter ${adapter} frontend ${frontend}`; $('#adapter-form').elements.inputUrl.value = `dvb://${id}`;
});
$('#adapter-form').elements.id.addEventListener('input', (event) => { if (!state.editingAdapter) $('#adapter-form').elements.inputUrl.value = `dvb://${event.target.value.trim()}`; });
$('#export-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const format = event.currentTarget.elements.format.value;
  const paths = { m3u: '/playlist.m3u', xspf: '/playlist.xspf', txt: '/playlist.txt', json: '/api/playlist' };
  const suffix = event.currentTarget.elements.includeDisabled.checked ? '?include_disabled=1' : '';
  window.location.assign(`${paths[format]}${suffix}`);
  $('#export-dialog').close();
});

$('#admin-token').value = state.token;
refresh(); setInterval(refresh, 3000);
const events = new EventSource('/api/events'); events.addEventListener('status', (event) => { state.status = JSON.parse(event.data); render(); }); events.addEventListener('log', (event) => { state.logs.unshift(JSON.parse(event.data)); state.logs = state.logs.slice(0, 100); renderLogs(); });
