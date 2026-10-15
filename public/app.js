const state = { status: null, streams: [], adapters: [], sessions: [], logs: [], config: null, query: '', selectedStreams: new Set(), editing: null, editingProfile: null, editingAdapter: null, editingAdapterDeviceId: null, scanningAdapter: null, scanServices: [], cardCapabilities: {}, loadingCards: new Set() };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Request failed: ${response.status}`);
  return value;
}

async function refresh() {
  if (refresh.pending) return;
  refresh.pending = true;
  try {
    const [status, streams, adapters, sessions, logs] = await Promise.all([
      api('/api/status'), api('/api/streams'), api('/api/adapters'), api('/api/sessions'), api('/api/logs?limit=100'),
    ]);
    Object.assign(state, { status, streams: streams.streams, adapters: adapters.adapters, sessions: sessions.sessions, logs: logs.logs });
    const existing = new Set(state.streams.map((stream) => stream.id));
    state.selectedStreams = new Set([...state.selectedStreams].filter((id) => existing.has(id)));
    render();
  } catch (error) { toast(error.message, true); }
  finally { refresh.pending = false; }
}

async function loadConfig() {
  state.config = await api('/api/config'); fillSettings(); return state.config;
}

function render() {
  const status = state.status || { engine: 'offline', uptimeSeconds: 0, streams: {}, sessions: 0, memory: {} };
  $('#engine-status').textContent = status.engine === 'online' ? 'Engine online' : 'Engine offline';
  $('#engine-detail').textContent = `Uptime ${duration(status.uptimeSeconds)} · v${status.version || '?'}`;
  for (const [id, path] of [['playlist-url', '/playlist.m3u'], ['epg-xml-url', '/epg.xml'], ['epg-json-url', '/api/epg']]) { const link = $(`#${id}`); link.href = path; link.textContent = `${location.origin}${path}`; }
  const bitrate = state.streams.reduce((sum, stream) => sum + (stream.bitrateKbps || 0), 0);
  const running = state.streams.filter((stream) => stream.state === 'running').length;
  const scrambled = state.streams.filter((stream) => stream.state === 'scrambled').length;
  const cards = groupAdapterCards();
  $('#metrics').innerHTML = [
    ['●', 'Running streams', `${running}/${state.streams.length}`, `${scrambled} scrambled · ${status.streams?.warning || 0} need attention`],
    ['⌁', 'Aggregate bitrate', `${(bitrate / 1000).toFixed(1)} Mb/s`, 'Measured MPEG-TS payload'],
    ['◉', 'DVB hardware', `${cards.length} cards`, `${state.adapters.length} tuners available`],
    ['♙', 'HTTP sessions', `${status.sessions || 0}`, 'Connected relay clients'],
  ].map(([icon, label, value, detail]) => `<article class="metric"><span class="metric-icon">${icon}</span><div><label>${label}</label><strong>${value}</strong><small>${detail}</small></div></article>`).join('');
  renderAdapters(); renderStreams(); renderSessions(); renderLogs();
}

function groupAdapterCards() {
  const groups = new Map();
  for (const adapter of state.adapters) {
    const key = adapter.cardId || `adapter-${adapter.adapter}`;
    if (!groups.has(key)) groups.set(key, { id: key, address: adapter.cardAddress || '', tuners: [] });
    groups.get(key).tuners.push(adapter);
  }
  return [...groups.values()]
    .map((card) => ({ ...card, tuners: card.tuners.sort((a, b) => a.adapter - b.adapter || a.frontend - b.frontend) }))
    .sort((a, b) => (a.tuners[0]?.adapter ?? Number.MAX_SAFE_INTEGER) - (b.tuners[0]?.adapter ?? Number.MAX_SAFE_INTEGER) || a.address.localeCompare(b.address))
    .map((card, index) => ({ ...card, number: index + 1 }));
}

function adapterLocation(adapter) {
  for (const card of groupAdapterCards()) {
    const tuner = card.tuners.findIndex((item) => item.adapter === adapter.adapter && item.frontend === adapter.frontend);
    if (tuner >= 0) return { card: card.number, tuner: tuner + 1 };
  }
  return { card: 0, tuner: Number(adapter.adapter) + 1 };
}

function tunerMetric(value, unit, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (unit === '%') return Math.max(0, Math.min(100, numeric));
  return Math.max(0, Math.min(100, ((numeric - minimum) / (maximum - minimum)) * 100));
}

function tunerIndicators(adapter) {
  if (!adapter.configured) return '<div class="tuner-indicators unavailable">Signal unavailable</div>';
  const strength = tunerMetric(adapter.signal?.value, adapter.signal?.unit, -90, -20);
  const cnr = tunerMetric(adapter.cnr?.value, adapter.cnr?.unit, 0, 20);
  const strengthText = adapter.signal ? `${number(adapter.signal.value).toFixed(1)} ${escapeHTML(adapter.signal.unit || '')}` : '—';
  const cnrText = adapter.cnr ? `${number(adapter.cnr.value).toFixed(1)} ${escapeHTML(adapter.cnr.unit || '')}` : escapeHTML(adapter.quality || '—');
  return `<div class="tuner-indicators"><div title="Signal ${strengthText}"><small>Signal <b>${strengthText}</b></small><span><i style="width:${strength.toFixed(1)}%"></i></span></div><div title="C/N ${cnrText}"><small>C/N <b>${cnrText}</b></small><span><i style="width:${cnr.toFixed(1)}%"></i></span></div></div>`;
}

function renderAdapters() {
  const cards = groupAdapterCards();
  $('#adapter-count').textContent = cards.length ? `${cards.length} cards · ${state.adapters.length} tuners` : '0';
  $('#adapters').innerHTML = cards.length ? cards.map((card) => {
    const capability = state.cardCapabilities[card.id];
    const configured = card.tuners.filter((item) => item.configured).length;
    const locked = card.tuners.filter((item) => item.lock).length;
    const title = capability?.hardwareName || `DVB card ${card.number}`;
    const rows = card.tuners.map((adapter, tunerIndex) => {
      const status = adapter.configured ? adapter.status : 'not configured';
      const tuning = adapter.configured ? `${number(adapter.frequencyMHz)} MHz · ${escapeHTML((adapter.polarization || '').slice(0, 1))} · ${number(adapter.symbolRateKsym)} kSym/s` : 'Click to configure';
      return `<button type="button" class="tuner-row" data-adapter-id="${escapeHTML(adapter.id)}"><span class="tuner-number">${tunerIndex + 1}</span><span class="tuner-description"><strong>Tuner ${tunerIndex + 1}</strong><small>${tuning}</small></span>${tunerIndicators(adapter)}<span class="state ${adapter.lock ? 'running' : 'warning'}">${escapeHTML(status)}</span><span class="tuner-arrow">›</span></button>`;
    }).join('');
    return `<section class="dvb-card"><header><div><h3>${escapeHTML(title)}</h3><p>Card ${card.number}${card.address ? ` · PCI ${escapeHTML(card.address)}` : ''} · ${card.tuners.length} tuners</p></div><div class="card-summary"><strong>${locked}</strong><small>locked</small><strong>${configured}</strong><small>configured</small></div></header><div class="tuner-list">${rows}</div></section>`;
  }).join('') : '<div class="empty">No DVB hardware detected. Connected Linux DVB frontends appear here automatically.</div>';
  loadCardSummaries(cards);
}

function loadCardSummaries(cards) {
  for (const card of cards) {
    if (state.cardCapabilities[card.id] || state.loadingCards.has(card.id) || !card.tuners[0]) continue;
    state.loadingCards.add(card.id);
    api(`/api/adapters/${encodeURIComponent(card.tuners[0].id)}/capabilities`).then((capability) => {
      state.cardCapabilities[card.id] = capability; renderAdapters();
    }).catch(() => {}).finally(() => state.loadingCards.delete(card.id));
  }
}

function renderStreams() {
  const rank = { running: 0, scrambled: 1, starting: 2, connecting: 3, warning: 4, failover: 5, error: 6, stopped: 7 };
  const streams = state.streams
    .filter((stream) => `${stream.name} ${stream.id}`.toLowerCase().includes(state.query.toLowerCase()))
    .sort((a, b) => (rank[a.state] ?? 8) - (rank[b.state] ?? 8) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  $('#stream-count').textContent = streams.length;
  $('#streams').innerHTML = streams.length ? streams.map((stream) => `<article class="stream-card${state.selectedStreams.has(stream.id) ? ' selected' : ''}" data-stream="${escapeHTML(stream.id)}"><label class="stream-select" title="Select ${escapeHTML(stream.name)}"><input type="checkbox" aria-label="Select ${escapeHTML(stream.name)}" data-stream-select="${escapeHTML(stream.id)}"${state.selectedStreams.has(stream.id) ? ' checked' : ''} /><span>Select</span></label><button type="button" class="stream-main stream-edit" data-edit-stream="${escapeHTML(stream.id)}" aria-label="Edit ${escapeHTML(stream.name)}"><span class="stream-orb ${escapeHTML(stream.state)}">⌁</span><span class="stream-description"><strong>${escapeHTML(stream.name)}</strong><small>${stream.activeInput >= 0 ? `Input ${stream.activeInput + 1}` : 'No active input'} · ${stream.clients || 0} viewers</small></span></button><div class="stream-uptime" title="Continuous output uptime; resets after restart, failover, or an output interruption"><span>Uptime</span><time>${stream.startedAt ? duration(stream.uptimeSeconds) : '—'}</time></div><div class="stream-foot"><strong>${number(stream.bitrateKbps).toLocaleString()} <small>Kbit/s</small></strong><span class="state ${escapeHTML(stream.state)}">${escapeHTML(stream.state)}</span></div></article>`).join('') : '<div class="empty">No streams match the current view.</div>';
  const visibleIds = streams.map((stream) => stream.id);
  const selectedVisible = visibleIds.filter((id) => state.selectedStreams.has(id)).length;
  const selectAll = $('#select-all-streams');
  selectAll.checked = Boolean(visibleIds.length) && selectedVisible === visibleIds.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  const deleteButton = $('#delete-selected-streams');
  deleteButton.disabled = state.selectedStreams.size === 0;
  deleteButton.textContent = state.selectedStreams.size ? `Delete selected (${state.selectedStreams.size})` : 'Delete selected';
}

function renderSessions() {
  $('#session-summary').textContent = `${state.sessions.length} active connections`;
  $('#session-rows').innerHTML = state.sessions.length ? state.sessions.map((session) => `<tr><td>${escapeHTML(streamName(session.streamId))}</td><td><code>${escapeHTML(session.ip || '')}</code></td><td>${escapeHTML(new Date(session.connectedAt).toLocaleString())}</td><td class="session-uptime">${duration(Math.max(0, Math.floor((Date.now() - new Date(session.connectedAt).getTime()) / 1000)))}</td><td>${escapeHTML(session.userAgent || '—')}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">No active HTTP relay sessions.</td></tr>';
}

function renderLogs() {
  $('#log-lines').innerHTML = state.logs.length ? state.logs.map((entry) => { const date = new Date(entry.time); const source = entry.sourceName || streamName(entry.source); return `<div class="log-line"><time data-short="${date.toLocaleTimeString()}">${date.toLocaleString()}</time><span class="level-${escapeHTML(entry.level)}">${escapeHTML(entry.level.toUpperCase())}</span><span class="source" title="${escapeHTML(source)}">${escapeHTML(source)}</span><span class="message">${escapeHTML(entry.message)}</span></div>`; }).join('') : '<div class="empty">No events recorded since this service started.</div>';
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
    const saved = id ? config.adapters.find((item) => item.id === id) || (live ? config.adapters.find((item) => item.adapter === live.adapter && item.frontend === live.frontend) : null) : null;
    const defaults = { id: '', name: '', enabled: true, adapter: 0, frontend: 0, demux: 0, deliverySystem: 'DVBS2X', frequencyMHz: 0, symbolRateKsym: 0, bandwidthMHz: 8, polarization: 'HORIZONTAL', modulation: '', fec: 'AUTO', inversion: 'AUTO', pilot: 'AUTO', rolloff: 'AUTO', streamId: -1, scramblingSequenceIndex: 0, lnb: 'EXTENDED', diseqc: -1, unicableKHz: 0 };
    const adapter = { ...defaults, ...(live || {}), ...(saved || {}) };
    state.editingAdapter = saved?.id || null;
    state.editingAdapterDeviceId = live?.id || saved?.id || null;
    const form = $('#adapter-form');
    const detected = state.adapters.filter((item) => item.detected).sort((a, b) => a.adapter - b.adapter || a.frontend - b.frontend);
    const deviceValue = `${adapter.adapter}:${adapter.frontend}`;
    const deviceOptions = detected.map((item) => { const location = adapterLocation(item); return `<option value="${item.adapter}:${item.frontend}">Card ${location.card} · Tuner ${location.tuner}${item.cardAddress ? ` · PCI ${escapeHTML(item.cardAddress)}` : ''}${item.configured ? ' · configured' : ''}</option>`; });
    if (!detected.some((item) => `${item.adapter}:${item.frontend}` === deviceValue)) deviceOptions.push(`<option value="${deviceValue}">adapter${adapter.adapter} / frontend${adapter.frontend}${saved ? ' · currently missing' : ' · manual'}</option>`);
    form.elements.device.innerHTML = deviceOptions.join(''); form.elements.device.value = deviceValue;
    if (![...form.elements.deliverySystem.options].some((option) => option.value === adapter.deliverySystem)) form.elements.deliverySystem.add(new Option(adapter.deliverySystem, adapter.deliverySystem));
    if (![...form.elements.lnb.options].some((option) => option.value === adapter.lnb)) form.elements.lnb.add(new Option(adapter.lnb === 'EXTENDED' ? 'Universal (extended)' : adapter.lnb, adapter.lnb, adapter.lnb === 'EXTENDED'));
    for (const key of ['id', 'name', 'deliverySystem', 'frequencyMHz', 'symbolRateKsym', 'bandwidthMHz', 'polarization', 'modulation', 'fec', 'inversion', 'pilot', 'rolloff', 'streamId', 'scramblingSequenceIndex', 'lnb', 'diseqc', 'unicableKHz']) if (form.elements[key]) form.elements[key].value = adapter[key] ?? '';
    form.elements.id.disabled = Boolean(saved); form.elements.enabled.checked = adapter.enabled !== false;
    form.elements.inputUrl.value = `dvb://${adapter.id || live?.id || 'adapter0-frontend0'}`;
    const location = adapterLocation(adapter);
    $('#adapter-dialog-title').textContent = location.card ? `Card ${location.card} · Tuner ${location.tuner}` : `Tuner ${location.tuner}`;
    $('#delete-adapter').classList.toggle('hidden', !saved); $('#use-adapter-stream').classList.toggle('hidden', !saved); $('#scan-adapter').classList.toggle('hidden', !saved);
    $('#adapter-capabilities').textContent = 'Inspecting frontend capabilities…';
    $('#adapter-dialog').showModal();
    loadAdapterCapabilities(live?.id || saved?.id).catch((error) => { $('#adapter-capabilities').textContent = error.message; });
  } catch (error) { toast(error.message, true); }
}

async function loadAdapterCapabilities(id) {
  if (!id) return;
  const capability = await api(`/api/adapters/${encodeURIComponent(id)}/capabilities`);
  const badges = [capability.s2x ? 'DVB-S2X' : '', capability.multistream ? 'MIS capable' : '', capability.apiVersion ? `API ${capability.apiVersion}` : ''].filter(Boolean);
  $('#adapter-capabilities').innerHTML = `<strong>${escapeHTML(capability.hardwareName)}</strong><span>${badges.map((badge) => `<b>${escapeHTML(badge)}</b>`).join('')}</span><small>${escapeHTML((capability.deliverySystems || []).join(', ') || 'Delivery systems unavailable')}</small>`;
}

async function saveAdapter(event) {
  event.preventDefault(); const form = event.currentTarget;
  const [adapterNumber, frontend] = form.elements.device.value.split(':').map(Number);
  const id = `adapter${adapterNumber}-frontend${frontend}`;
  const adapter = { id, name: form.elements.name.value.trim(), enabled: form.elements.enabled.checked, adapter: adapterNumber, frontend, demux: Number(form.elements.demux.value) || 0, deliverySystem: form.elements.deliverySystem.value, frequencyMHz: Number(form.elements.frequencyMHz.value) || 0, symbolRateKsym: Number(form.elements.symbolRateKsym.value) || 0, bandwidthMHz: Number(form.elements.bandwidthMHz.value) || 8, polarization: form.elements.polarization.value, modulation: form.elements.modulation.value.trim(), fec: form.elements.fec.value.trim() || 'AUTO', inversion: form.elements.inversion.value, pilot: form.elements.pilot.value, rolloff: form.elements.rolloff.value, streamId: Number(form.elements.streamId.value), scramblingSequenceIndex: Number(form.elements.scramblingSequenceIndex.value) || 0, lnb: form.elements.lnb.value.trim() || 'EXTENDED', diseqc: Number(form.elements.diseqc.value), unicableKHz: Number(form.elements.unicableKHz.value) || 0 };
  const adapters = [...(state.config?.adapters || []).filter((item) => item.id !== id && item.id !== state.editingAdapter), adapter];
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
  const id = state.editingAdapterDeviceId; if (!id) return;
  $('#adapter-dialog').close(); await openStream(null, `dvb://${id}`);
}

function openAdapterScan() {
  if (!state.editingAdapterDeviceId) return;
  state.scanningAdapter = state.editingAdapterDeviceId; state.scanServices = [];
  const profiles = (state.config?.casProfiles || []).filter((profile) => profile.configured);
  $('#scan-cam-profile').innerHTML = ['<option value="">None — keep encrypted services scrambled</option>', ...profiles.map((profile) => `<option value="${escapeHTML(profile.id)}">${escapeHTML(profile.name)} (${escapeHTML(profile.id)})</option>`)].join('');
  $('#adapter-dialog').close(); $('#scan-dialog-title').textContent = `Scan ${state.editingAdapter}`;
  $('#scan-status').textContent = 'The saved tuner settings are used as the initial transponder.';
  $('#scan-service-rows').innerHTML = '<tr><td colspan="5" class="muted">No scan results yet.</td></tr>';
  $('#create-scanned-streams').classList.add('hidden'); $('#select-all-services').checked = false;
  $('#scan-dialog').showModal();
}

async function scanAdapter(event) {
  event.preventDefault();
  const button = $('#start-scan'); const networkScan = event.currentTarget.elements.networkScan.checked;
  button.disabled = true; button.textContent = 'Scanning…'; $('#scan-status').textContent = 'Tuning and reading PAT/PMT/SDT tables. Keep this window open…';
  try {
    const result = await api(`/api/adapters/${encodeURIComponent(state.scanningAdapter)}/scan`, { method: 'POST', body: JSON.stringify({ networkScan, timeoutMultiply: 2, timeoutMs: networkScan ? 240000 : 90000 }) });
    state.scanServices = result.services || [];
    $('#scan-status').textContent = `Found ${state.scanServices.length} services.`;
    $('#scan-service-rows').innerHTML = state.scanServices.map((service, index) => `<tr><td><input type="checkbox" data-scan-service="${index}" checked /></td><td><strong>${escapeHTML(service.name)}</strong></td><td>${number(service.serviceId)}</td><td>${escapeHTML((service.videoPids || []).join(', ') || '—')}</td><td>${escapeHTML((service.audioPids || []).join(', ') || '—')}</td></tr>`).join('');
    $('#select-all-services').checked = true; $('#create-scanned-streams').classList.remove('hidden');
  } catch (error) { $('#scan-status').textContent = error.message; toast(error.message, true); }
  finally { button.disabled = false; button.textContent = 'Start scan'; }
}

async function createScannedStreams() {
  const selected = $$('[data-scan-service]:checked').map((checkbox) => state.scanServices[Number(checkbox.dataset.scanService)]).filter(Boolean);
  if (!selected.length) return toast('Select at least one service', true);
  const camProfile = $('#scan-cam-profile').value;
  const button = $('#create-scanned-streams'); button.disabled = true; button.textContent = 'Creating…';
  let created = 0; const failed = [];
  for (const service of selected) {
    const id = `${state.scanningAdapter}-${service.serviceId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
    try {
      await api('/api/streams', { method: 'POST', body: JSON.stringify({ id, name: service.name || `Service ${service.serviceId}`, enabled: true, inputs: [{ url: service.inputUrl }], outputs: [], http: true, hls: true, hlsCompatibility: false, onDemand: false, service: { serviceId: service.serviceId }, cam: { enabled: Boolean(camProfile), profile: camProfile || 'default' } }) });
      created += 1;
    } catch (error) { failed.push(`${service.name}: ${error.message}`); }
  }
  button.disabled = false; button.textContent = 'Create selected streams';
  state.config = null; await refresh();
  if (failed.length) { $('#scan-status').textContent = `Created ${created}; ${failed.length} failed: ${failed.join('; ')}`; toast(`Created ${created} streams; ${failed.length} failed`, true); }
  else { $('#scan-dialog').close(); toast(`Created ${created} DVB streams${camProfile ? ' with Newcamd' : ''}`); }
}

async function openCASProfile(id = null) {
  const config = state.config || await loadConfig(); const profile = id ? config.casProfiles.find((item) => item.id === id) : { id: '', name: '', caid: '', serviceId: 0 };
  if (!profile) return toast('CAS profile not found', true);
  state.editingProfile = id; const form = $('#cas-profile-form');
  form.elements.id.value = profile.id; form.elements.id.disabled = Boolean(id); form.elements.name.value = profile.name; form.elements.line.value = ''; form.elements.line.required = !profile.configured;
  form.elements.caid.value = profile.caid || ''; form.elements.serviceId.value = profile.serviceId || 0;
  $('#cas-profile-title').textContent = id ? profile.name : 'New Newcamd profile'; $('#delete-cas-profile').classList.toggle('hidden', !id); $('#cas-profile-dialog').showModal();
}

async function saveCASProfile(event) {
  event.preventDefault(); const form = event.currentTarget; const id = state.editingProfile || form.elements.id.value.trim();
  const profile = { id, name: form.elements.name.value.trim(), caid: form.elements.caid.value.trim(), serviceId: Number(form.elements.serviceId.value) || 0 };
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
    const stream = id ? config.streams.find((item) => item.id === id) : { id: '', name: '', enabled: false, inputs: [], outputs: [], hls: true, hlsCompatibility: false, http: true, onDemand: false, keepActiveSeconds: 0, cam: { enabled: false, profile: 'default' } };
    if (!stream) throw new Error('Stream configuration not found');
    state.editing = id;
    const form = $('#stream-form');
    form.elements.name.value = stream.name || '';
    form.elements.id.value = stream.id || '';
    form.elements.id.disabled = Boolean(id);
    form.elements.enabled.checked = Boolean(stream.enabled);
    form.elements.inputs.value = initialInput || (stream.inputs || []).map((input) => input.url).join('\n');
    form.elements.outputs.value = (stream.outputs || []).map((output) => output.url).join('\n');
    form.elements.http.checked = stream.http !== false; form.elements.hls.checked = stream.hls !== false; form.elements.hlsCompatibility.checked = Boolean(stream.hlsCompatibility);
    form.elements.onDemand.checked = Boolean(stream.onDemand); form.elements.keepActiveSeconds.value = stream.keepActiveSeconds || 0;
    form.elements.camEnabled.checked = Boolean(stream.cam?.enabled);
    const profiles = [{ id: 'default', name: 'Select a profile' }, ...(config.casProfiles || []).filter((profile) => profile.id !== 'default')];
    form.elements.camProfile.innerHTML = profiles.map((profile) => `<option value="${escapeHTML(profile.id)}">${escapeHTML(profile.name)} (${escapeHTML(profile.id)})</option>`).join('');
    form.elements.camProfile.value = stream.cam?.profile || 'default';
    $('#stream-dialog-title').textContent = id ? stream.name : 'New stream';
    $('#delete-stream').classList.toggle('hidden', !id);
    selectTab('general'); $('#stream-dialog').showModal();
  } catch (error) { toast(error.message, true); }
}

async function saveStream(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = state.editing || form.elements.id.value.trim();
  const value = { id, name: form.elements.name.value.trim(), enabled: form.elements.enabled.checked, inputs: lines(form.elements.inputs.value).map((url) => ({ url })), outputs: lines(form.elements.outputs.value).map((url) => ({ url })), http: form.elements.http.checked, hls: form.elements.hls.checked, hlsCompatibility: form.elements.hlsCompatibility.checked, onDemand: form.elements.onDemand.checked, keepActiveSeconds: Number(form.elements.keepActiveSeconds.value) || 0, cam: { enabled: form.elements.camEnabled.checked, profile: form.elements.camProfile.value.trim() || 'default' } };
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

async function deleteSelectedStreams() {
  const ids = [...state.selectedStreams];
  if (!ids.length || !confirm(`Delete ${ids.length} selected channel${ids.length === 1 ? '' : 's'}?`)) return;
  const button = $('#delete-selected-streams'); button.disabled = true; button.textContent = 'Deleting…';
  try {
    const result = await api('/api/streams/delete', { method: 'POST', body: JSON.stringify({ ids }) });
    state.selectedStreams.clear(); state.config = null; await refresh(); toast(`${result.removed.length} channel${result.removed.length === 1 ? '' : 's'} deleted`);
  } catch (error) { toast(error.message, true); renderStreams(); }
}

function showView(id) { $$('.view').forEach((view) => view.classList.toggle('active', view.id === id)); $$('.nav').forEach((button) => button.classList.toggle('active', button.dataset.view === id)); if (id === 'settings') loadConfig().catch(() => {}); }
function selectTab(id) { $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === id)); $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === id)); }
function toast(message, failed = false) { const node = $('#toast'); node.textContent = message; node.style.borderColor = failed ? '#fa707055' : ''; node.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 2800); }
function streamName(id) { return state.streams.find((stream) => stream.id === id)?.name || id; }
function lines(value) { return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function duration(seconds) { seconds = Math.max(0, Math.floor(number(seconds))); const days = Math.floor(seconds / 86400); const clock = [Math.floor(seconds % 86400 / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map((part) => String(part).padStart(2, '0')).join(':'); return `${days ? `${days}d ` : ''}${clock}`; }
function escapeHTML(value) { return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }

$$('.nav').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
$$('.tab').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.tab)));
$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.closeDialog}`).close()));
$('#refresh').addEventListener('click', refresh);
$('#search').addEventListener('input', (event) => { state.query = event.target.value; renderStreams(); });
$('#new-stream').addEventListener('click', () => openStream());
$('#export-streams').addEventListener('click', () => $('#export-dialog').showModal());
$('#new-adapter').addEventListener('click', () => openAdapter());
$('#streams').addEventListener('click', (event) => { if (event.target.closest('.stream-select')) return; const card = event.target.closest('[data-stream]'); if (card) openStream(card.dataset.stream); });
$('#streams').addEventListener('change', (event) => { const checkbox = event.target.closest('[data-stream-select]'); if (!checkbox) return; if (checkbox.checked) state.selectedStreams.add(checkbox.dataset.streamSelect); else state.selectedStreams.delete(checkbox.dataset.streamSelect); renderStreams(); });
$('#select-all-streams').addEventListener('change', (event) => { const visible = state.streams.filter((stream) => `${stream.name} ${stream.id}`.toLowerCase().includes(state.query.toLowerCase())); for (const stream of visible) { if (event.target.checked) state.selectedStreams.add(stream.id); else state.selectedStreams.delete(stream.id); } renderStreams(); });
$('#delete-selected-streams').addEventListener('click', deleteSelectedStreams);
$('#adapters').addEventListener('click', (event) => { const card = event.target.closest('[data-adapter-id]'); if (card) openAdapter(card.dataset.adapterId); });
$('#stream-form').addEventListener('submit', saveStream);
$('#delete-stream').addEventListener('click', deleteStream);
$('#settings-form').addEventListener('submit', async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); for (const key of Object.keys(data)) data[key] = Number(data[key]); try { await api('/api/settings', { method: 'PUT', body: JSON.stringify(data) }); state.config = null; await refresh(); toast('Runtime settings applied'); } catch (error) { toast(error.message, true); } });
$('#new-cas-profile').addEventListener('click', () => openCASProfile());
$('#cas-profiles').addEventListener('click', (event) => { const row = event.target.closest('[data-profile]'); if (row) openCASProfile(row.dataset.profile); });
$('#cas-profile-form').addEventListener('submit', saveCASProfile);
$('#delete-cas-profile').addEventListener('click', deleteCASProfile);
$('#adapter-form').addEventListener('submit', saveAdapter);
$('#delete-adapter').addEventListener('click', deleteAdapter);
$('#use-adapter-stream').addEventListener('click', useAdapterInStream);
$('#scan-adapter').addEventListener('click', openAdapterScan);
$('#scan-form').addEventListener('submit', scanAdapter);
$('#create-scanned-streams').addEventListener('click', createScannedStreams);
$('#select-all-services').addEventListener('change', (event) => $$('[data-scan-service]').forEach((checkbox) => { checkbox.checked = event.target.checked; }));
$('#adapter-form').elements.device.addEventListener('change', (event) => {
  const [adapter, frontend] = event.target.value.split(':').map(Number); const id = `adapter${adapter}-frontend${frontend}`;
  state.editingAdapterDeviceId = id; $('#adapter-form').elements.id.value = id; $('#adapter-form').elements.inputUrl.value = `dvb://${id}`;
  if (!state.editingAdapter) { const live = state.adapters.find((item) => item.adapter === adapter && item.frontend === frontend); const location = live ? adapterLocation(live) : { card: 0, tuner: adapter + 1 }; $('#adapter-form').elements.name.value = location.card ? `Card ${location.card} Tuner ${location.tuner}` : `Tuner ${location.tuner}`; }
  $('#adapter-capabilities').textContent = 'Inspecting frontend capabilities…';
  loadAdapterCapabilities(id).catch((error) => { $('#adapter-capabilities').textContent = error.message; });
});
$('#adapter-form').elements.id.addEventListener('input', (event) => { if (!state.editingAdapter) $('#adapter-form').elements.inputUrl.value = `dvb://${event.target.value.trim()}`; });
$('#export-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const format = event.currentTarget.elements.format.value;
  const delivery = event.currentTarget.elements.delivery.value;
  const paths = { m3u: '/playlist.m3u', xspf: '/playlist.xspf', txt: '/playlist.txt', json: '/api/playlist' };
  const params = new URLSearchParams({ delivery });
  if (event.currentTarget.elements.includeDisabled.checked) params.set('include_disabled', '1');
  window.location.assign(`${paths[format]}?${params}`);
  $('#export-dialog').close();
});

refresh(); setInterval(refresh, 3000);
const events = new EventSource('/api/events'); events.addEventListener('status', (event) => { state.status = JSON.parse(event.data); render(); }); events.addEventListener('log', (event) => { state.logs.unshift(JSON.parse(event.data)); state.logs = state.logs.slice(0, 100); renderLogs(); });
events.addEventListener('sessions', (event) => { state.sessions = JSON.parse(event.data).sessions; if (state.status) state.status.sessions = state.sessions.length; render(); });
