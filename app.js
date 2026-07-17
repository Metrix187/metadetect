/*
 * app.js — MetaDetect
 *
 * scans BLE advertisements (where the browser lets us) and flags gadgets that
 * are probably filming or recording you. the whole thing is best-effort by
 * design — read LIMITATIONS.md before trusting it with anything that matters.
 *
 * platform reality, short version:
 *   - Android Chrome/Edge WITH the experimental flag on -> real passive scan.
 *   - desktop Chrome/Edge WITH the flag -> works if the machine has BT.
 *   - iPhone/iPad (any browser) -> no Web Bluetooth at all. can't help you here.
 *     that's an Apple/WebKit thing, nothing we can do from a web page.
 *   - anything else -> demo mode so you can at least see the UI.
 */

(function () {
  'use strict';

  const DB = window.MD_DB;
  const { SIGNAL_WEIGHTS, CONFIDENCE, COMPANY_IDS, SERVICE_UUIDS, NAME_PATTERNS } = DB;

  // ---- tiny helpers -------------------------------------------------------

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const now = () => Date.now();

  function fmtClock(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtAgo(ts) {
    const s = Math.max(0, Math.round((now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s ago`;
  }

  // rssi (dBm) -> rough 0..1 closeness bar. -30ish is on top of you, -100 is far.
  function rssiToPct(rssi) {
    if (rssi == null) return 0;
    const clamped = Math.max(-100, Math.min(-30, rssi));
    return Math.round(((clamped + 100) / 70) * 100);
  }

  function rssiToRange(rssi) {
    if (rssi == null) return 'unknown range';
    if (rssi >= -55) return 'very close (arm’s reach)';
    if (rssi >= -70) return 'close (same room)';
    if (rssi >= -85) return 'nearby';
    return 'faint / far';
  }

  // ---- settings (persisted) ----------------------------------------------

  const DEFAULT_SETTINGS = {
    sound: true,
    vibrate: true,
    rssiThreshold: -90,   // ignore threats fainter than this
    showAll: false,       // also list non-threat BLE devices
    autoResumeMin: 0,     // 0 = stay paused until i say so
  };

  let settings = loadSettings();

  function loadSettings() {
    try {
      const raw = localStorage.getItem('md_settings');
      return raw ? Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw)) : Object.assign({}, DEFAULT_SETTINGS);
    } catch (_) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function saveSettings() {
    try { localStorage.setItem('md_settings', JSON.stringify(settings)); } catch (_) {}
  }

  // ---- app state ----------------------------------------------------------

  const state = {
    mode: 'idle',        // idle | scanning | paused | unsupported | demo
    scan: null,          // the BluetoothLEScan handle, so we can stop it
    devices: new Map(),  // device.id -> record
    log: [],             // detection events
    demoTimer: null,
    pruneTimer: null,
    renderTimer: null,
    resumeTimer: null,
    audioCtx: null,
    alertedRecently: new Set(), // device ids we've already buzzed for this session
  };

  const PRUNE_AFTER_MS = 30000; // a device unseen for 30s drops off "nearby now"

  // ---- classification: is this advert a recorder? -------------------------

  // pull whatever the browser gives us into a normalized shape.
  function readAdvertisement(event) {
    const companyIds = [];
    if (event.manufacturerData && typeof event.manufacturerData.forEach === 'function') {
      event.manufacturerData.forEach((_value, key) => companyIds.push(Number(key)));
    }

    const serviceUuids = new Set();
    (event.uuids || []).forEach((u) => serviceUuids.add(String(u).toLowerCase()));
    if (event.serviceData && typeof event.serviceData.forEach === 'function') {
      event.serviceData.forEach((_v, key) => serviceUuids.add(String(key).toLowerCase()));
    }

    return {
      id: event.device && event.device.id ? event.device.id : 'unknown',
      name: event.name || (event.device && event.device.name) || '',
      rssi: typeof event.rssi === 'number' ? event.rssi : null,
      txPower: typeof event.txPower === 'number' ? event.txPower : null,
      companyIds,
      serviceUuids: Array.from(serviceUuids),
    };
  }

  // score it. returns { score, confidence, brand, product, category, risk, signals[] }
  function classify(adv) {
    const signals = [];
    let score = 0;
    let best = null; // the most descriptive match wins the label

    const consider = (hit, kindLabel, detail) => {
      if (!hit) return;
      const pts = SIGNAL_WEIGHTS[hit.kind != null ? hit.kind : 'name'];
      if (pts > 0) {
        score += pts;
        signals.push({ text: detail, kind: hit.kind || 'name' });
      } else {
        // ignore-tier: still record it as context so the card can say "also: Apple"
        signals.push({ text: detail, kind: 'context' });
      }
      // prefer a "specific" or name match for the headline label
      const rank = { specific: 3, name: 3, socVendor: 2, broad: 1, ignore: 0 };
      if (!best || (rank[hit.kind || 'name'] || 0) > (rank[best.kind || 'name'] || 0)) {
        if (hit.category !== 'other' || !best) best = hit;
      }
    };

    adv.companyIds.forEach((cid) => {
      const hit = COMPANY_IDS[cid];
      if (hit) consider(hit, hit.kind, `company id 0x${cid.toString(16).toUpperCase()} → ${hit.product}`);
    });

    adv.serviceUuids.forEach((u) => {
      const hit = SERVICE_UUIDS[u];
      if (hit) consider(hit, hit.kind, `service uuid ${u.slice(0, 8)}… → ${hit.product}`);
    });

    if (adv.name) {
      NAME_PATTERNS.forEach((p) => {
        if (p.re.test(adv.name)) {
          consider({ ...p, kind: 'name' }, 'name', `name “${adv.name}” → ${p.product}`);
        }
      });
    }

    let confidence = 'none';
    if (score >= CONFIDENCE.high) confidence = 'high';
    else if (score >= CONFIDENCE.medium) confidence = 'medium';
    else if (score > 0) confidence = 'low';

    return {
      score,
      confidence,
      brand: best ? best.brand : null,
      product: best ? best.product : null,
      category: best ? best.category : null,
      risk: best ? best.risk : null,
      signals,
    };
  }

  // ---- device store + the alert decision ----------------------------------

  function ingest(adv) {
    if (adv.id === 'unknown' && !adv.name && adv.companyIds.length === 0) return;

    const verdict = classify(adv);
    const isThreat = verdict.confidence === 'high' || verdict.confidence === 'medium';

    let rec = state.devices.get(adv.id);
    if (!rec) {
      rec = {
        id: adv.id,
        firstSeen: now(),
        bestRssi: adv.rssi,
        count: 0,
      };
      state.devices.set(adv.id, rec);
    }

    rec.name = adv.name || rec.name || '';
    rec.rssi = adv.rssi;
    if (adv.rssi != null && (rec.bestRssi == null || adv.rssi > rec.bestRssi)) rec.bestRssi = adv.rssi;
    rec.lastSeen = now();
    rec.count += 1;
    rec.verdict = verdict;
    rec.isThreat = isThreat;

    if (isThreat) maybeAlert(rec);
  }

  function withinThreshold(rec) {
    return rec.rssi == null || rec.rssi >= settings.rssiThreshold;
  }

  function maybeAlert(rec) {
    if (state.mode === 'paused') return;         // the whole point of pause
    if (!withinThreshold(rec)) return;           // too faint, don't cry wolf
    if (state.alertedRecently.has(rec.id)) return;

    state.alertedRecently.add(rec.id);
    // let the same device alert again if it disappears and comes back later
    setTimeout(() => state.alertedRecently.delete(rec.id), 60000);

    pushLog(rec);
    fireAlert(rec);
  }

  function pushLog(rec) {
    state.log.unshift({
      time: now(),
      brand: rec.verdict.brand,
      product: rec.verdict.product,
      confidence: rec.verdict.confidence,
      rssi: rec.rssi,
      range: rssiToRange(rec.rssi),
    });
    if (state.log.length > 500) state.log.length = 500;
    renderLog();
  }

  // ---- the actual alert: buzz, beep, flash --------------------------------

  function fireAlert(rec) {
    flashScreen();
    if (settings.vibrate && navigator.vibrate) navigator.vibrate([120, 60, 120]);
    if (settings.sound) beep();
    // nudge the live region for screen readers
    const live = $('#live-region');
    if (live) live.textContent = `Recording device detected: ${rec.verdict.product}, ${rssiToRange(rec.rssi)}`;
  }

  function flashScreen() {
    const el = $('#flash');
    if (!el) return;
    el.classList.remove('flash-go');
    // force reflow so re-adding the class actually replays the animation
    void el.offsetWidth;
    el.classList.add('flash-go');
  }

  function beep() {
    try {
      if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = state.audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const t = ctx.currentTime;
      // two quick chirps, the universal "hey, look" sound
      [0, 0.18].forEach((offset) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(880, t + offset);
        gain.gain.setValueAtTime(0.0001, t + offset);
        gain.gain.exponentialRampToValueAtTime(0.25, t + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.14);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t + offset);
        osc.stop(t + offset + 0.16);
      });
    } catch (_) { /* audio just won't play, no big deal */ }
  }

  // ---- scanning lifecycle -------------------------------------------------

  async function startScan() {
    // unlock audio inside the user gesture so beeps work later
    try {
      if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (state.audioCtx.state === 'suspended') await state.audioCtx.resume();
    } catch (_) {}

    if (!supportsLEScan()) { startDemo(); return; }

    try {
      state.scan = await navigator.bluetooth.requestLEScan({
        acceptAllAdvertisements: true,
        keepRepeatedDevices: true, // we WANT repeats — that's how rssi updates
      });
      navigator.bluetooth.addEventListener('advertisementreceived', onAdvertisement);
      setMode('scanning');
    } catch (err) {
      // most common: user denied the permission, or the flag isn't on
      showScanError(err);
    }
  }

  function onAdvertisement(event) {
    if (state.mode !== 'scanning') return;
    ingest(readAdvertisement(event));
  }

  function stopScan() {
    try {
      if (state.scan && state.scan.stop) state.scan.stop();
    } catch (_) {}
    state.scan = null;
    if (navigator.bluetooth && navigator.bluetooth.removeEventListener) {
      navigator.bluetooth.removeEventListener('advertisementreceived', onAdvertisement);
    }
  }

  function pauseScan() {
    if (state.mode === 'demo') { stopDemo(); }
    else { stopScan(); }
    setMode('paused');

    if (settings.autoResumeMin > 0) {
      clearTimeout(state.resumeTimer);
      state.resumeTimer = setTimeout(resumeScan, settings.autoResumeMin * 60000);
    }
    updateResumeCountdown();
  }

  function resumeScan() {
    clearTimeout(state.resumeTimer);
    state.resumeTimer = null;
    startScan();
  }

  function fullStop() {
    if (state.mode === 'demo') stopDemo();
    else stopScan();
    clearTimeout(state.resumeTimer);
    state.resumeTimer = null;
    state.devices.clear();
    state.alertedRecently.clear();
    setMode('idle');
    render();
  }

  // ---- demo mode: fake adverts so the UI isn't dead on unsupported phones --

  const DEMO_SCRIPT = [
    { id: 'demo-rayban', name: '', companyIds: [0x01ab], serviceUuids: [DB.uuid16(0xfd5f)], rssi: -58 },
    { id: 'demo-phone',  name: '', companyIds: [0x004c], serviceUuids: [], rssi: -47 },
    { id: 'demo-snap',   name: 'Spectacles 3', companyIds: [0x03c2], serviceUuids: [], rssi: -72 },
    { id: 'demo-buds',   name: '', companyIds: [0x05d6], serviceUuids: [], rssi: -80 },
    { id: 'demo-plaud',  name: 'PLAUD-NotePin', companyIds: [], serviceUuids: [], rssi: -66 },
  ];

  function startDemo() {
    setMode('demo');
    let i = 0;
    const tick = () => {
      // jitter the rssi a little so the bars wiggle like real life
      const base = DEMO_SCRIPT[i % DEMO_SCRIPT.length];
      const jitter = Math.round((((i * 37) % 11) - 5)); // deterministic-ish wobble
      ingest({ ...base, rssi: base.rssi + jitter, txPower: null });
      i += 1;
    };
    tick();
    state.demoTimer = setInterval(tick, 900);
  }

  function stopDemo() {
    clearInterval(state.demoTimer);
    state.demoTimer = null;
  }

  // ---- feature detection --------------------------------------------------

  function hasWebBluetooth() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  function supportsLEScan() {
    return hasWebBluetooth() && typeof navigator.bluetooth.requestLEScan === 'function';
  }

  function platformNote() {
    const ua = navigator.userAgent || '';
    const isiOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isiOS) {
      return {
        can: false,
        title: 'iPhone & iPad can’t do this',
        body: 'Apple doesn’t allow Web Bluetooth in any iOS browser (Safari, Chrome, all of them use WebKit). ' +
              'There is genuinely no web workaround. Use an Android phone with Chrome, or build the ESP32 detector — it doesn’t care what phone you have.',
      };
    }
    if (!hasWebBluetooth()) {
      return {
        can: false,
        title: 'This browser has no Web Bluetooth',
        body: 'Firefox and Safari don’t ship it. Use Chrome or Edge (desktop or Android).',
      };
    }
    if (!supportsLEScan()) {
      return {
        can: false,
        title: 'One flag away',
        body: 'You have Web Bluetooth but not the scanning API. Open chrome://flags, enable ' +
              '“Experimental Web Platform features”, and restart the browser. On Android that’s the whole unlock.',
      };
    }
    return { can: true };
  }

  function showScanError(err) {
    const box = $('#scan-error');
    const msg = (err && err.message) ? err.message : String(err);
    let human = msg;
    if (/user cancelled|cancelled|denied|NotAllowed/i.test(msg)) {
      human = 'Permission was declined. Tap Start again and allow Bluetooth scanning.';
    } else if (/not supported|requestLEScan/i.test(msg)) {
      human = 'Your browser blocked the scan API. Enable chrome://flags → “Experimental Web Platform features” and restart.';
    } else if (/globally disabled|adapter|off/i.test(msg)) {
      human = 'Bluetooth looks turned off. Switch it on and try again.';
    }
    box.textContent = human;
    box.hidden = false;
    setMode('idle');
  }

  // ---- rendering ----------------------------------------------------------

  function setMode(mode) {
    state.mode = mode;
    document.body.dataset.mode = mode;
    renderControls();
    renderStatus();
  }

  function renderStatus() {
    const dot = $('#status-dot');
    const label = $('#status-label');
    const map = {
      idle:        ['idle', 'Idle — not scanning'],
      scanning:    ['live', 'Scanning live'],
      paused:      ['paused', 'Paused'],
      demo:        ['demo', 'DEMO MODE — fake data'],
      unsupported: ['idle', 'Not supported here'],
    };
    const [cls, text] = map[state.mode] || map.idle;
    dot.className = 'dot dot-' + cls;
    label.textContent = text;
  }

  function renderControls() {
    const primary = $('#btn-primary');
    const stop = $('#btn-stop');
    const banner = $('#demo-banner');

    banner.hidden = state.mode !== 'demo';

    if (state.mode === 'scanning' || state.mode === 'demo') {
      primary.textContent = 'Pause';
      primary.dataset.action = 'pause';
      primary.className = 'btn btn-pause';
      stop.hidden = false;
    } else if (state.mode === 'paused') {
      primary.textContent = 'Resume';
      primary.dataset.action = 'resume';
      primary.className = 'btn btn-primary';
      stop.hidden = false;
    } else {
      primary.textContent = 'Start scanning';
      primary.dataset.action = 'start';
      primary.className = 'btn btn-primary';
      stop.hidden = true;
    }
  }

  function updateResumeCountdown() {
    const el = $('#resume-note');
    if (state.mode === 'paused' && settings.autoResumeMin > 0 && state.resumeTimer) {
      el.hidden = false;
      el.textContent = `Auto-resumes in ~${settings.autoResumeMin} min. Tap Resume to go now.`;
    } else if (state.mode === 'paused') {
      el.hidden = false;
      el.textContent = 'Paused. Nothing is being scanned or logged until you resume.';
    } else {
      el.hidden = true;
    }
  }

  function activeDevices() {
    const cutoff = now() - PRUNE_AFTER_MS;
    return Array.from(state.devices.values()).filter((d) => d.lastSeen >= cutoff);
  }

  function render() {
    const devices = activeDevices();
    const threats = devices
      .filter((d) => d.isThreat && withinThreshold(d))
      .sort((a, b) => (b.rssi || -999) - (a.rssi || -999));

    renderThreats(threats);
    renderSummary(devices, threats);
    if (state.mode === 'paused') updateResumeCountdown();
  }

  function renderSummary(devices, threats) {
    $('#count-threats').textContent = String(threats.length);
    $('#count-all').textContent = String(devices.length);
    const sum = $('#summary-line');
    if (state.mode === 'idle') {
      sum.textContent = 'Hit start and I’ll watch the airwaves.';
    } else if (state.mode === 'paused') {
      sum.textContent = 'Paused.';
    } else if (threats.length === 0) {
      sum.textContent = devices.length
        ? `${devices.length} Bluetooth device${devices.length === 1 ? '' : 's'} around, none flagged as recorders right now.`
        : 'Listening… nothing yet.';
    } else {
      sum.textContent = `${threats.length} possible recording device${threats.length === 1 ? '' : 's'} nearby.`;
    }
  }

  function renderThreats(threats) {
    const wrap = $('#threats');
    const empty = $('#threats-empty');
    wrap.innerHTML = '';

    if (threats.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    threats.forEach((d) => {
      const v = d.verdict;
      const card = document.createElement('div');
      card.className = `card conf-${v.confidence} cat-${v.category || 'other'}`;

      const pct = rssiToPct(d.rssi);
      const signalsHtml = v.signals
        .map((s) => `<li class="sig sig-${s.kind}">${escapeHtml(s.text)}</li>`)
        .join('');

      card.innerHTML = `
        <div class="card-top">
          <div class="card-id">
            <span class="badge badge-${v.confidence}">${v.confidence}</span>
            <span class="card-name">${escapeHtml(v.product || v.brand || 'Unknown recorder')}</span>
          </div>
          <div class="card-range">${escapeHtml(rssiToRange(d.rssi))}${d.rssi != null ? ` · ${d.rssi} dBm` : ''}</div>
        </div>
        <div class="meter"><div class="meter-fill" style="width:${pct}%"></div></div>
        <div class="card-risk">${escapeHtml(v.risk || '')}</div>
        <details class="card-why">
          <summary>Why flagged</summary>
          <ul class="sigs">${signalsHtml}</ul>
          <div class="card-meta">first seen ${fmtClock(d.firstSeen)} · ${d.count} adverts · last ${fmtAgo(d.lastSeen)}</div>
        </details>`;
      wrap.appendChild(card);
    });
  }

  function renderLog() {
    const wrap = $('#log');
    if (!wrap) return;
    if (state.log.length === 0) {
      wrap.innerHTML = '<li class="log-empty">Nothing logged yet.</li>';
      return;
    }
    wrap.innerHTML = state.log
      .slice(0, 100)
      .map((e) => `<li class="log-row conf-${e.confidence}">
        <span class="log-time">${fmtClock(e.time)}</span>
        <span class="log-name">${escapeHtml(e.product || e.brand || 'device')}</span>
        <span class="log-range">${escapeHtml(e.range)}</span>
      </li>`)
      .join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  // ---- log export ---------------------------------------------------------

  function exportLog() {
    if (state.log.length === 0) return;
    const rows = [['time', 'brand', 'product', 'confidence', 'rssi_dBm', 'range']];
    state.log.forEach((e) => rows.push([
      new Date(e.time).toISOString(),
      e.brand || '', e.product || '', e.confidence, e.rssi == null ? '' : e.rssi, e.range,
    ]));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `metadetect-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- settings UI --------------------------------------------------------

  function syncSettingsUI() {
    $('#set-sound').checked = settings.sound;
    $('#set-vibrate').checked = settings.vibrate;
    $('#set-showall').checked = settings.showAll;
    $('#set-rssi').value = settings.rssiThreshold;
    $('#set-rssi-val').textContent = `${settings.rssiThreshold} dBm`;
    $('#set-autoresume').value = String(settings.autoResumeMin);
    document.body.classList.toggle('show-all', settings.showAll);
  }

  function wireSettings() {
    $('#set-sound').addEventListener('change', (e) => { settings.sound = e.target.checked; saveSettings(); });
    $('#set-vibrate').addEventListener('change', (e) => { settings.vibrate = e.target.checked; saveSettings(); });
    $('#set-showall').addEventListener('change', (e) => {
      settings.showAll = e.target.checked; saveSettings();
      document.body.classList.toggle('show-all', settings.showAll);
    });
    $('#set-rssi').addEventListener('input', (e) => {
      settings.rssiThreshold = Number(e.target.value);
      $('#set-rssi-val').textContent = `${settings.rssiThreshold} dBm`;
      saveSettings();
    });
    $('#set-autoresume').addEventListener('change', (e) => {
      settings.autoResumeMin = Number(e.target.value); saveSettings();
    });
  }

  // ---- modal plumbing -----------------------------------------------------

  function openSheet(id) { $(id).classList.add('open'); $(id).setAttribute('aria-hidden', 'false'); }
  function closeSheet(id) { $(id).classList.remove('open'); $(id).setAttribute('aria-hidden', 'true'); }

  // ---- wire up ------------------------------------------------------------

  function init() {
    // primary button does start/pause/resume depending on state
    $('#btn-primary').addEventListener('click', () => {
      const action = $('#btn-primary').dataset.action;
      $('#scan-error').hidden = true;
      if (action === 'start') startScan();
      else if (action === 'pause') pauseScan();
      else if (action === 'resume') resumeScan();
    });

    $('#btn-stop').addEventListener('click', fullStop);

    $('#btn-settings').addEventListener('click', () => { syncSettingsUI(); openSheet('#sheet-settings'); });
    $('#btn-info').addEventListener('click', () => openSheet('#sheet-info'));
    $$('[data-close]').forEach((b) => b.addEventListener('click', (e) => closeSheet('#' + e.target.dataset.close)));
    $$('.sheet-backdrop').forEach((b) => b.addEventListener('click', (e) => {
      if (e.target === b) closeSheet('#' + b.parentElement.id);
    }));

    $('#btn-export').addEventListener('click', exportLog);
    $('#btn-clearlog').addEventListener('click', () => { state.log = []; renderLog(); });

    wireSettings();
    syncSettingsUI();
    renderLog();

    // check the platform and either arm the button or explain why we can't
    const note = platformNote();
    if (!note.can) {
      $('#unsupported-title').textContent = note.title;
      $('#unsupported-body').textContent = note.body;
      $('#unsupported').hidden = false;
    }

    // keep the "nearby now" view honest — prune stale devices and re-render
    state.pruneTimer = setInterval(() => {
      // clean up the map so it doesn't grow forever
      const cutoff = now() - PRUNE_AFTER_MS * 4;
      state.devices.forEach((d, id) => { if (d.lastSeen < cutoff) state.devices.delete(id); });
    }, 10000);
    state.renderTimer = setInterval(render, 1000);

    setMode('idle');
    render();

    // register the service worker so it works offline (built the file already)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
