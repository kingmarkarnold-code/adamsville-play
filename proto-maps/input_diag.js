/* ============================================================================
   INPUT DIAGNOSTICS v1.0 — dev-build input log that reports itself
   (Joshua 2026-10-16).

   WHY THIS EXISTS:
   The dev build is not directly linked to Mollie, so when keyboard
   movement broke there (the missing window.keys exposure, fixed
   2026-10-16), the only evidence was "it doesn't move". This module
   keeps a rolling log of INPUT-LEVEL facts — which keys went down/up,
   what the per-tick Input snapshot actually contains, whether the
   player position changes while movement keys are held, controller
   connect/disconnect, and uncaught errors — and sends it to the same
   GitHub reports folder the game's other diagnostics already use, so
   the next "can't move" arrives WITH its evidence attached.

   HOW IT SENDS:
   It rides the game's existing report pipe (github_reports.js):
   GitHubReports.queue('input-diag', payload) + flush(). The pipe's own
   file naming (reports/<YYYY-MM-DD-HHMMSS>-<type>.json) produces
   exactly:  reports/<YYYY-MM-DD-HHMMSS>-input-diag.json
   in kingmarkarnold-code/adamsville-play. No new credentials, no new
   endpoints — if the pipe has no token, sending silently does nothing
   and the log stays on the device (localStorage) for manual review.

   WHEN IT SENDS:
   * Automatically when a HELD-NO-MOVE marker fires (below), throttled
     to at most one auto-send per 10 minutes.
   * Manually: Settings -> "Input Diagnostics" -> "Send input log now".

   THE HELD-NO-MOVE MARKER (the core diagnostic):
   A sampler runs every 2 s. While movement keys (W/A/S/D) are held it
   records a sample: the live keys object, the Input snapshot (what
   game logic actually reads), the drive state, the player position
   when reachable, and how far the position moved since the last
   sample. If movement keys have been held >= 1.5 s and either
     (a) the position is reachable and has NOT changed (< 0.05 units
         since the hold began) — the player is genuinely stuck, or
     (b) the position is unreachable but the LIVE keys show the hold
         while the Input SNAPSHOT does not — the input pipeline itself
         is broken (exactly the dev bug this module was built for) —
   a HELD-NO-MOVE marker is written (once per hold) and the log
   auto-sends. If the position is unreachable AND the snapshot does
   contain the keys, no marker fires: movement is probably fine and
   this module cannot prove otherwise, so it stays quiet.

   PRIVACY — HARD RULES:
   * Only input/game-state diagnostics: key names + codes, snapshot
     contents, positions, versions, user agent, error messages.
   * Key events from text fields (INPUT / TEXTAREA / SELECT /
     contentEditable targets) are skipped ENTIRELY — text the player
     types is never logged, in whole or in part.
   * No personal data of any kind is collected or sent.

   STORAGE:
   The log lives in memory and is mirrored to localStorage
   ('sa.inputdiag.v1'), capped at ~400 entries (oldest dropped), so it
   survives reloads and can be inspected after the fact. Sent payloads
   carry the most recent 250 entries (the report pipe truncates files
   at 50k characters; 250 entries stays safely under that).

   DEPENDENCIES: github_reports.js for sending (guarded — the module
   logs fine without it). Every game access is typeof/try guarded (the
   sim_core.js pattern) so load order can never throw. This module
   NEVER intercepts input: its listeners only observe.
   ============================================================================ */
(function inputDiag(){
'use strict';

/* ---------------------------------------------------------------------------
   Constants.
   ------------------------------------------------------------------------- */
var LS_KEY = 'sa.inputdiag.v1';   // localStorage key for the rolling log
var MAX_ENTRIES = 400;            // hard cap on the stored log
var SEND_ENTRIES = 250;           // entries included per sent payload
var SAMPLE_MS = 2000;             // sampler period while keys are held
var HOLD_MARK_MS = 1500;          // held-this-long before a marker can fire
var STUCK_EPS = 0.05;             // position change below this = no movement
var AUTO_SEND_MIN_MS = 10 * 60 * 1000;  // auto-send throttle: 10 minutes
var MOVE_KEYS = ['w', 'a', 's', 'd'];   // the logical movement keys

/* ---------------------------------------------------------------------------
   Defensive localStorage reach (same pattern as the sibling modules:
   private-mode browsers can throw, and diagnostics must never break
   the game).
   ------------------------------------------------------------------------- */
function storage(){
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch(e){}
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch(e){}
  return null;
}

/* ---------------------------------------------------------------------------
   The rolling log. Loaded from storage at boot (defensively — a
   corrupt store just starts a fresh log), capped on every push, and
   written back on a 1 s dirty-flag flush plus page-hide, so a burst of
   auto-repeat key events cannot hammer localStorage.
   ------------------------------------------------------------------------- */
var entries = [];
var storeDirty = false;

(function loadLog(){
  var st = storage(); if (!st) return;
  try {
    var raw = st.getItem(LS_KEY);
    if (!raw) return;
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.length === 'number'){
      for (var i = 0; i < parsed.length; i++){
        if (parsed[i] && typeof parsed[i] === 'object') entries.push(parsed[i]);
      }
      while (entries.length > MAX_ENTRIES) entries.shift();
    }
  } catch(e){ entries = []; }
})();

function persistLog(){
  var st = storage(); if (!st) return;
  try { st.setItem(LS_KEY, JSON.stringify(entries)); storeDirty = false; }
  catch(e){}
}

/* Append one entry. `fields` is a small plain object merged over
   {ts, kind}. Never throws. */
function push(kind, fields){
  try {
    var e = { ts: Date.now(), kind: kind };
    if (fields){
      for (var k in fields){
        if (Object.prototype.hasOwnProperty.call(fields, k)) e[k] = fields[k];
      }
    }
    entries.push(e);
    while (entries.length > MAX_ENTRIES) entries.shift();
    storeDirty = true;
  } catch(err){}
}

/* ---------------------------------------------------------------------------
   Small guarded readers of game state. Each returns null / {} when the
   thing it reads is not reachable, and NONE of them can throw.
   ------------------------------------------------------------------------- */

/* Live build versions, as stamped by the deferred loader from the
   manifests (window.__UIVER / window.__MAPVER). */
function versions(){
  var v = { ui: null, map: null };
  try { if (typeof window.__UIVER === 'string' && window.__UIVER) v.ui = window.__UIVER; } catch(e){}
  try { if (typeof window.__MAPVER === 'string' && window.__MAPVER) v.map = window.__MAPVER; } catch(e){}
  return v;
}

/* Browser/user-agent string (diagnostics context only). */
function userAgent(){
  try {
    if (typeof navigator !== 'undefined' && navigator.userAgent)
      return String(navigator.userAgent).slice(0, 160);
  } catch(e){}
  return null;
}

/* Player position, using the exact guarded pattern github_reports.js
   established (bare `player` when reachable, else window.player). */
function playerPos(){
  try {
    if (typeof player !== 'undefined' && player &&
        typeof player.x === 'number' && typeof player.z === 'number')
      return { x: Math.round(player.x * 10) / 10, z: Math.round(player.z * 10) / 10 };
    if (typeof window !== 'undefined' && window.player &&
        typeof window.player.x === 'number' && typeof window.player.z === 'number')
      return { x: Math.round(window.player.x * 10) / 10,
               z: Math.round(window.player.z * 10) / 10 };
  } catch(e){}
  return null;
}

/* A compact {w,a,s,d} readout from any keys-like object (null-safe). */
function moveReadout(src){
  if (!src) return null;
  var out = {};
  for (var i = 0; i < MOVE_KEYS.length; i++) out[MOVE_KEYS[i]] = !!src[MOVE_KEYS[i]];
  return out;
}
function anyMove(ro){ return !!(ro && (ro.w || ro.a || ro.s || ro.d)); }

/* The full input picture at one instant: live objects + the per-tick
   snapshot the game logic actually reads. The live-vs-snapshot
   comparison is the whole point of this module. */
function inputState(){
  var live = null, snap = null, drive = null;
  try { live = moveReadout(window.keys); } catch(e){}
  try {
    if (typeof window !== 'undefined' && window.Input && window.Input.sampled){
      snap = moveReadout(window.Input.keys);
      var d = window.Input.drive || {};
      drive = { gas: !!d.gas, brake: !!d.brake, hb: !!d.hb,
                left: !!d.left, right: !!d.right };
    }
  } catch(e){}
  if (!drive){
    try {
      var ld = window.drive;
      if (ld) drive = { gas: !!ld.gas, brake: !!ld.brake, hb: !!ld.hb,
                        left: !!ld.left, right: !!ld.right };
    } catch(e){}
  }
  return { live: live, snap: snap, drive: drive };
}

/* ---------------------------------------------------------------------------
   Typing guard — key events from text entry are NEVER logged (privacy
   rule; see header). Same helper shape as keyboard_remap.js.
   ------------------------------------------------------------------------- */
function isTextTarget(e){
  try {
    var t = e && e.target;
    if (!t) return false;
    if (t.isContentEditable) return true;
    var tag = (typeof t.tagName === 'string') ? t.tagName.toUpperCase() : '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  } catch(err){ return false; }
}

/* ---------------------------------------------------------------------------
   Event listeners — OBSERVE ONLY. Nothing here ever calls
   preventDefault or stopPropagation: the game must not feel this
   module's presence.
   ------------------------------------------------------------------------- */
function onKey(e, dir){
  if (isTextTarget(e)) return;      // typed text is never logged
  if (dir === 'down' && e.repeat) return;  // auto-repeat adds no signal
  push('key', {
    dir: dir,
    key: String((e && e.key) || ''),
    code: String((e && e.code) || '')
  });
}

if (typeof window !== 'undefined' && window.addEventListener){
  window.addEventListener('keydown', function(e){ onKey(e, 'down'); }, false);
  window.addEventListener('keyup',   function(e){ onKey(e, 'up'); }, false);

  window.addEventListener('gamepadconnected', function(e){
    push('gamepad', { ev: 'connected',
      id: String((e && e.gamepad && e.gamepad.id) || '').slice(0, 48) });
  }, false);
  window.addEventListener('gamepaddisconnected', function(e){
    push('gamepad', { ev: 'disconnected',
      id: String((e && e.gamepad && e.gamepad.id) || '').slice(0, 48) });
  }, false);

  /* Uncaught errors: message + source only. (github_reports.js runs a
     parallel listener for its own crash reports — both coexist.) */
  window.addEventListener('error', function(ev){
    push('error', {
      message: String((ev && ev.message) || 'unknown').slice(0, 200),
      source: String((ev && ev.filename) || '') + ':' + ((ev && ev.lineno) || '')
    });
  }, false);
  window.addEventListener('unhandledrejection', function(ev){
    var r = ev && ev.reason;
    push('error', {
      message: String((r && r.message) || r || 'unhandled rejection').slice(0, 200),
      source: 'unhandledrejection'
    });
  }, false);
}

/* ---------------------------------------------------------------------------
   Sending. Rides the existing GitHubReports pipe: queue type
   'input-diag' makes the pipe write
   reports/<YYYY-MM-DD-HHMMSS>-input-diag.json — the established path
   convention. lastSendAt drives the auto-send throttle (manual sends
   are never throttled but DO reset the clock, so a manual send is not
   immediately followed by a duplicate auto-send).
   ------------------------------------------------------------------------- */
var lastSendAt = 0;

function reportSys(status, note){
  try {
    if (typeof Report !== 'undefined' && Report.setSys)
      Report.setSys('inputDiag', {status: status, version: '1.0', note: note});
  } catch(e){}
  refreshDiagUI();
}

function doSend(how){
  var pipe = null;
  try {
    if (typeof window !== 'undefined' && window.GitHubReports &&
        typeof window.GitHubReports.queue === 'function' &&
        typeof window.GitHubReports.flush === 'function')
      pipe = window.GitHubReports;
  } catch(e){}
  if (!pipe){
    reportSys('warn', 'input log NOT sent — GitHub report pipe unavailable (' + how + ')');
    return false;
  }
  var v = versions();
  var payload = {
    type: 'input-diag',
    created: new Date().toISOString(),
    versions: v,
    ua: userAgent(),
    entries: entries.slice(-SEND_ENTRIES)
  };
  try {
    pipe.queue('input-diag', payload);
    pipe.flush();
  } catch(e){
    reportSys('warn', 'input log send failed (' + how + ')');
    return false;
  }
  lastSendAt = Date.now();
  push('sent', { how: how, count: payload.entries.length });
  reportSys('ok', 'input log sent (' + how + ') — reports/*-input-diag.json');
  return true;
}

/* Auto-send on a HELD-NO-MOVE marker, at most once per 10 minutes. A
   throttled attempt is recorded in the log (so the NEXT successful
   send explains the gap) but never recurses into another send. */
function autoSend(){
  if (Date.now() - lastSendAt < AUTO_SEND_MIN_MS){
    push('send-throttled', { retryAfterMs: AUTO_SEND_MIN_MS - (Date.now() - lastSendAt) });
    return;
  }
  doSend('auto');
}

/* ---------------------------------------------------------------------------
   The sampler + HELD-NO-MOVE detection (see header for the rules).
   holdSince / posAtStart / markerFired describe the CURRENT hold
   episode; they reset the moment no movement key is held.
   ------------------------------------------------------------------------- */
var holdSince = 0;
var posAtStart = null;
var markerFired = false;
var lastPos = null;

function dist(a, b){
  if (!a || !b) return null;
  var dx = a.x - b.x, dz = a.z - b.z;
  return Math.round(Math.sqrt(dx * dx + dz * dz) * 100) / 100;
}

function sampleTick(){
  var st = inputState();
  var heldLive = anyMove(st.live);
  var heldSnap = anyMove(st.snap);
  var held = heldLive || heldSnap;
  var pos = playerPos();
  var now = Date.now();

  if (held){
    if (!holdSince){ holdSince = now; posAtStart = pos; markerFired = false; }
    push('sample', {
      heldMs: now - holdSince,
      live: st.live, snap: st.snap, drive: st.drive,
      pos: pos, dPos: dist(pos, lastPos)
    });
    if (!markerFired && (now - holdSince) >= HOLD_MARK_MS){
      var dStart = dist(pos, posAtStart);
      if (pos && posAtStart && dStart !== null && dStart < STUCK_EPS){
        /* (a) Position reachable and unchanged: genuinely stuck. */
        markerFired = true;
        push('HELD-NO-MOVE', {
          reason: 'no-position-change', heldMs: now - holdSince,
          live: st.live, snap: st.snap, drive: st.drive, pos: pos
        });
        reportSys('warn', 'HELD-NO-MOVE detected — auto-sending input log');
        autoSend();
      } else if (!pos && st.snap && heldLive && !heldSnap){
        /* (b) Position unreachable, and the snapshot never saw the
           held keys: the input pipeline is broken (the dev bug). */
        markerFired = true;
        push('HELD-NO-MOVE', {
          reason: 'snapshot-missing-keys', heldMs: now - holdSince,
          live: st.live, snap: st.snap, drive: st.drive, pos: null
        });
        reportSys('warn', 'HELD-NO-MOVE (snapshot missing keys) — auto-sending input log');
        autoSend();
      }
      /* Position unreachable AND snapshot has the keys: cannot prove
         stuck — no marker (samples above still record the state). */
    }
  } else {
    holdSince = 0;
    posAtStart = null;
    markerFired = false;
  }
  if (pos) lastPos = pos;
}

/* ---------------------------------------------------------------------------
   Settings UI — a small "Input Diagnostics" section injected beside
   the keyboard/controller sections (same #settings .card home, same
   injection pattern, ids prefixed 'diag-'). It shows the log size and
   last-send time and carries the manual send button. Fallback, if the
   Settings card never appears (~5 s of retries): a floating "🩺 Log"
   button opening this module's own overlay. Injection is idempotent.
   ------------------------------------------------------------------------- */
var uiMode = '';        // '' = not injected yet, 'settings', or 'overlay'
var statusEl = null;    // the status line inside the section/overlay
var overlayEl = null;   // fallback overlay element (overlay mode only)
var uiTries = 0;
var uiTimer = null;

function findSettingsCard(){
  try {
    var s = document.getElementById('settings');
    if (!s || !s.children) return null;
    for (var i = 0; i < s.children.length; i++){
      var c = s.children[i];
      if (c && c.className && String(c.className).split(/\s+/).indexOf('card') !== -1) return c;
    }
    return null;
  } catch(e){ return null; }
}

function mkEl(tag, cssText, text){
  var el = document.createElement(tag);
  if (cssText) el.style.cssText = cssText;
  if (typeof text === 'string') el.textContent = text;
  return el;
}

/* The shared section contents, used by both homes. */
function buildDiagPanel(host){
  var h = mkEl('h3', 'margin:14px 0 4px 0;color:#ffd75e;font-size:clamp(17px,5vw,22px);',
               'Input Diagnostics');
  host.appendChild(h);
  statusEl = mkEl('div',
    'font-size:12px;color:#9fb3c8;margin:6px 0 2px 0;line-height:1.45;', '');
  statusEl.id = 'diag-status';
  host.appendChild(statusEl);
  var send = mkEl('button',
    'display:block;width:100%;margin:8px 0;padding:10px 14px;font-size:14px;' +
    'font-weight:bold;border-radius:10px;border:2px solid #444;background:#222836;' +
    'color:#fff;text-align:left;box-sizing:border-box;',
    'Send input log now');
  send.id = 'diag-send';
  send.addEventListener('click', function(){ doSend('manual'); });
  host.appendChild(send);
  refreshDiagUI();
}

/* Keep the status line honest: entries held + when the last send was. */
function refreshDiagUI(){
  if (!statusEl) return;
  try {
    var when = lastSendAt
      ? ('last send ' + new Date(lastSendAt).toLocaleTimeString())
      : 'not sent yet this session';
    statusEl.textContent =
      'Input log: ' + entries.length + ' entries (' + when + '). It ' +
      'auto-sends if movement keys are held but the player does not ' +
      'move. Keys typed into text fields are never logged.';
  } catch(e){}
}

function ensureDiagUI(){
  if (uiMode) return true;
  uiTries++;
  try {
    var card = findSettingsCard();
    if (card){
      var existing = document.getElementById('input-diag');
      if (existing){
        statusEl = document.getElementById('diag-status');
        uiMode = 'settings';
        refreshDiagUI();
        return true;
      }
      var sec = mkEl('div', '', null);
      sec.id = 'input-diag';
      buildDiagPanel(sec);
      var closeBtn = document.getElementById('set-close');
      if (closeBtn && closeBtn.parentNode === card) card.insertBefore(sec, closeBtn);
      else card.appendChild(sec);
      uiMode = 'settings';
      return true;
    }
    if (uiTries >= 20){
      var fab = mkEl('button',
        'position:fixed;left:12px;top:172px;z-index:35;padding:10px 14px;' +
        'font-size:14px;font-weight:bold;border-radius:10px;border:2px solid #444;' +
        'background:#222836;color:#fff;',
        '🩺 Log');
      fab.id = 'diag-fab';
      fab.addEventListener('click', function(){ openDiagUI(); });
      document.body.appendChild(fab);
      overlayEl = mkEl('div',
        'position:fixed;inset:0;z-index:65;display:none;align-items:center;' +
        'justify-content:center;background:rgba(0,0,0,.78);', null);
      overlayEl.id = 'diag-overlay';
      var cardEl = mkEl('div',
        'background:#161b26;border-radius:14px;padding:20px 22px;max-width:420px;' +
        'width:86%;border:2px solid #ffd75e;max-height:86vh;overflow-y:auto;', null);
      buildDiagPanel(cardEl);
      var done = mkEl('button',
        'display:block;width:100%;margin-top:12px;padding:10px 18px;font-size:15px;' +
        'border-radius:10px;border:none;background:#ffd75e;color:#111;font-weight:bold;',
        'Done');
      done.addEventListener('click', function(){ overlayEl.style.display = 'none'; });
      cardEl.appendChild(done);
      overlayEl.appendChild(cardEl);
      document.body.appendChild(overlayEl);
      uiMode = 'overlay';
      return true;
    }
  } catch(e){}
  return false;
}

function panelShown(id){
  try {
    var el = document.getElementById(id);
    return !!(el && el.classList && el.classList.contains('show'));
  } catch(e){ return false; }
}
function openDiagUI(){
  ensureDiagUI();
  if (uiMode === 'overlay' && overlayEl){
    overlayEl.style.display = 'flex';
  } else if (uiMode === 'settings'){
    if (!panelShown('settings')){
      try {
        var hb = document.getElementById('help-btn');
        if (hb && typeof hb.click === 'function') hb.click();
      } catch(e){}
    }
  }
  refreshDiagUI();
}

/* ---------------------------------------------------------------------------
   Public API — window.InputDiag: send the log now, inspect its size,
   or clear it (log + storage) when a fresh start is wanted.
   ------------------------------------------------------------------------- */
var api = {
  sendNow: function(){ return doSend('api'); },
  status: function(){
    return {
      entries: entries.length,
      lastSendAt: lastSendAt ? new Date(lastSendAt).toISOString() : null,
      versions: versions(),
      uiMode: uiMode || 'pending'
    };
  },
  log: function(kind, fields){ push(String(kind || 'note'), fields || null); },
  clear: function(){
    entries = [];
    persistLog();
    refreshDiagUI();
  }
};
try { window.InputDiag = api; } catch(e){}

/* ---------------------------------------------------------------------------
   Boot: record the boot entry, announce ourselves, start the sampler
   and the storage flusher, and inject the Settings section (retrying
   until it lands, like the sibling modules).
   ------------------------------------------------------------------------- */
(function boot(){
  var v = versions();
  var path = null;
  try { if (typeof location !== 'undefined' && location.pathname) path = String(location.pathname); }
  catch(e){}
  push('boot', { ui: v.ui, map: v.map, ua: userAgent(), path: path });
  reportSys('ok', 'input diagnostics live — auto-sends on HELD-NO-MOVE' +
    ' (ui ' + (v.ui || '?') + ', map ' + (v.map || '?') + ')');

  try { setInterval(sampleTick, SAMPLE_MS); } catch(e){}
  try {
    setInterval(function(){ if (storeDirty) persistLog(); }, 1000);
  } catch(e){}
  try {
    window.addEventListener('pagehide', persistLog);
    document.addEventListener('visibilitychange', function(){
      if (document.visibilityState === 'hidden') persistLog();
    });
  } catch(e){}

  if (!ensureDiagUI()){
    try {
      uiTimer = setInterval(function(){
        if (ensureDiagUI() && uiTimer){ clearInterval(uiTimer); uiTimer = null; }
      }, 250);
    } catch(e){}
  }
})();

})();
