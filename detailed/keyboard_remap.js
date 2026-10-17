/* ============================================================================
   KEYBOARD REMAP v1.0 — user-customizable keyboard controls for the DEV
   build (Joshua 2026-10-16). The controller got remappable buttons
   (gamepad_input.js v2.0); this is the same idea for the keyboard, built
   as a backup control scheme: if a key stops working, the player can move
   the job to another key instead of being stuck.

   HOW IT INTEGRATES (same contract as the gamepad module):
   The game's main keydown/keyup handlers (index.html) write the LIVE
   objects window.keys (lowercase e.key strings) and window.drive
   ({gas, brake, hb, left, right}); sim_core.js Input.sample() snapshots
   them per tick and all game logic reads the snapshots. This module sits
   in the CAPTURE phase in front of those handlers:

     * A key that is NOT part of the remap system passes through
       completely untouched — the game handler sees it exactly as before.
     * A key that IS remapped is swallowed (stopImmediatePropagation +
       preventDefault, so the game handler never double-processes the
       physical key) and this module performs, itself, EXACTLY what the
       game handler would have done for the action's DEFAULT key:
         - keys[<default>] is held true / released false,
         - the Action key clicks #action-btn on the press edge (when the
           button is on screen) and the Inventory key clicks #inv-btn —
           the same DOM clicks the handler itself performs,
         - while driving, the movement keys also set/clear the same
           window.drive fields the handler sets (W=gas, S=brake,
           A=steer left, D=steer right, Space=handbrake).
     * A default key whose action has been moved elsewhere (or
       unassigned) is swallowed and does nothing — so after remapping
       Forward from W to I, pressing W no longer moves the player.
     * Typing is sacred: events whose target is an INPUT, TEXTAREA,
       SELECT or contentEditable element are NEVER intercepted, captured
       or swallowed, remap or no remap.

   HELD-STATE TRACKING:
   Every intercepted press is recorded (physical key -> the logical key
   and drive field it produced). The matching keyup clears exactly what
   the press set — even if the mapping was changed mid-hold — so a key
   can never stick down because the player remapped while holding it.

   DRIVING DETECTION:
   Same test gamepad_input.js uses: the game's `car` object when it is
   reachable, else the on-screen gas pedal (#gas-btn), which the game
   only displays while driving. Outside code cannot always reach `car`
   (it lives in index.html's main block), so the DOM fallback is the
   practical path — identical to the gamepad module's behavior.

   THE REMAP TABLE — actions and their DEFAULT keys (e.key strings, the
   same lowercase form the game's handler computes):
     Forward .... 'w'   (on foot: move forward; driving: gas)
     Back ....... 's'   (on foot: move back;    driving: brake)
     Left ....... 'a'   (on foot: strafe left;  driving: steer left)
     Right ...... 'd'   (on foot: strafe right; driving: steer right)
     Action ..... 'e'   (universal action button — clicks #action-btn)
     Handbrake .. ' '   (Space, driving only)
     Inventory .. 'i'   (toggles the inventory panel — clicks #inv-btn)
   The arrow keys are NOT in the table: they keep their built-in driving
   role in the game handler (and do nothing on foot), remapped or not.

   CUSTOMIZING:
   Settings (gear button) -> "Keyboard Keys" section. Each row shows the
   action, its current key, and a Change button: tap Change, then press
   any key to assign it (Esc cancels; 10 s timeout cancels). The mapping
   is saved in localStorage (key 'sa.keys.map.v1') and survives
   restarts. If the key you press already belongs to another action,
   that action becomes unassigned ("—") — last assignment wins. An
   unassigned action does nothing. "Reset keyboard keys" restores the
   defaults above.

   DEPENDENCIES: none. Loaded via the deferred data-dsrc queue right
   after gamepad_input.js. Every game access is typeof/try guarded (the
   sim_core.js pattern) so load order can never throw, and with the
   default mapping the module is invisible: it intercepts nothing.
   ============================================================================ */
(function keyboardRemap(){
'use strict';

/* ---------------------------------------------------------------------------
   The remappable actions and their DEFAULT physical keys. This table is
   the ONLY place those defaults appear: at runtime every decision goes
   through keyMap (loaded from localStorage), never a hardcoded key.
   `def` doubles as the LOGICAL key the module writes when the action
   fires — pressing the player's chosen key must feel exactly like
   pressing the default key, because the module reproduces the game
   handler's behavior for the default key, not for the physical one.
   ------------------------------------------------------------------------- */
var ACTIONS = [
  { id: 'forward',   label: 'Move forward (gas when driving)',  def: 'w' },
  { id: 'back',      label: 'Move back (brake when driving)',   def: 's' },
  { id: 'left',      label: 'Move left (steer left)',           def: 'a' },
  { id: 'right',     label: 'Move right (steer right)',         def: 'd' },
  { id: 'action',    label: 'Action (interact / enter)',        def: 'e' },
  { id: 'handbrake', label: 'Handbrake (driving)',              def: ' ' },
  { id: 'inventory', label: 'Inventory',                        def: 'i' }
];

/* Which window.drive field each LOGICAL key drives while driving —
   copied from the game handler's driving branch (W/S/A/D/Space). The
   Action and Inventory keys are absent on purpose: in the handler their
   branches come BEFORE the driving branch, so they never touch drive. */
var DRIVE_FOR = { 'w': 'gas', 's': 'brake', 'a': 'left', 'd': 'right', ' ': 'hb' };

/* Human-readable labels for the remap UI, so the player sees "Space"
   instead of a blank and "↑" style names for special keys. Single
   characters are shown uppercased; anything else falls back to the raw
   key string with its first letter capitalized. */
var KEY_NAMES = {
  ' ': 'Space', 'escape': 'Esc',
  'arrowup': '↑', 'arrowdown': '↓', 'arrowleft': '←', 'arrowright': '→',
  'shift': 'Shift', 'control': 'Ctrl', 'alt': 'Alt', 'meta': 'Meta/Win',
  'capslock': 'Caps Lock', 'tab': 'Tab', 'enter': 'Enter',
  'backspace': 'Backspace', 'delete': 'Delete', 'insert': 'Insert',
  'home': 'Home', 'end': 'End', 'pageup': 'Page Up', 'pagedown': 'Page Down',
  'printscreen': 'Print Screen', 'scrolllock': 'Scroll Lock', 'pause': 'Pause'
};
function keyLabel(k){
  if (k === null || typeof k === 'undefined') return '—';  // unassigned
  if (Object.prototype.hasOwnProperty.call(KEY_NAMES, k)) return KEY_NAMES[k];
  if (k.length === 1) return k.toUpperCase();
  return k.charAt(0).toUpperCase() + k.slice(1);
}

/* ---------------------------------------------------------------------------
   Mapping persistence — localStorage key 'sa.keys.map.v1' (JSON object
   {actionId: physicalKeyStringOrNull}). Physical keys are stored in the
   same normalized form the game handler computes: e.key.toLowerCase().
   Loading is defensive (same pattern as gamepad_input.js): bad JSON,
   wrong shapes, implausible values and duplicate claims all fall back
   to the defaults for the affected actions instead of breaking input.
   ------------------------------------------------------------------------- */
var MAP_STORAGE_KEY = 'sa.keys.map.v1';

/* Defensive localStorage reach (typeof-guarded; private-mode browsers
   can throw on access, and a storage failure must never kill input). */
function storage(){
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch(e){}
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch(e){}
  return null;
}

/* A stored key value is plausible only as a short string (real e.key
   values: 'w', ' ', 'arrowup', 'escape', 'f5', ...). Long junk rejected. */
function validKey(v){
  return typeof v === 'string' && v.length >= 1 && v.length <= 24;
}

/* Load the mapping: start from defaults, overlay any valid stored
   values. If two stored actions claim the same physical key, the
   earlier action in the ACTIONS table keeps it and the later one
   becomes unassigned — the same "one key, one action" rule the capture
   flow enforces. */
function loadMap(){
  var map = {}, used = {}, i, id;
  for (i = 0; i < ACTIONS.length; i++) map[ACTIONS[i].id] = ACTIONS[i].def;
  var raw = null, parsed = null, st = storage();
  if (st){ try { raw = st.getItem(MAP_STORAGE_KEY); } catch(e){ raw = null; } }
  if (raw){ try { parsed = JSON.parse(raw); } catch(e){ parsed = null; } }
  if (parsed && typeof parsed === 'object'){
    for (i = 0; i < ACTIONS.length; i++){
      id = ACTIONS[i].id;
      if (Object.prototype.hasOwnProperty.call(parsed, id)){
        var v = parsed[id];
        if (v === null) map[id] = null;
        else if (validKey(v)) map[id] = String(v).toLowerCase();
      }
    }
  }
  /* Resolve duplicate claims deterministically. */
  for (i = 0; i < ACTIONS.length; i++){
    id = ACTIONS[i].id;
    if (map[id] !== null){
      if (used[map[id]]) map[id] = null; else used[map[id]] = true;
    }
  }
  return map;
}

/* Save immediately — every remap change is persisted the moment it is
   made, so a crash or battery pull never loses the player's layout. */
function saveMap(){
  var st = storage(); if (!st) return;
  try { st.setItem(MAP_STORAGE_KEY, JSON.stringify(keyMap)); } catch(e){}
}

/* The live mapping. Runtime code reads ONLY this table. */
var keyMap = loadMap();

/* True when the live mapping differs from the shipped defaults (used
   for the Report note so a custom layout is visible at a glance). */
function isCustomMap(){
  for (var i = 0; i < ACTIONS.length; i++){
    if (keyMap[ACTIONS[i].id] !== ACTIONS[i].def) return true;
  }
  return false;
}
function customSuffix(){
  return isCustomMap() ? ' — custom key mapping active' : '';
}

/* A plain copy of the live mapping (callers must not mutate our table). */
function mappingCopy(){
  var out = {};
  for (var i = 0; i < ACTIONS.length; i++) out[ACTIONS[i].id] = keyMap[ACTIONS[i].id];
  return out;
}

/* ---------------------------------------------------------------------------
   Reverse lookups over the live mapping.
   actionForPhysical(k): the action currently assigned to physical key k,
   or null. isOrphanedDefault(k): k is some action's DEFAULT key but that
   action now lives on a different key (or is unassigned) — pressing it
   must do nothing (the player moved the job away), so it is swallowed.
   ------------------------------------------------------------------------- */
function actionForPhysical(k){
  for (var i = 0; i < ACTIONS.length; i++){
    if (keyMap[ACTIONS[i].id] === k) return ACTIONS[i];
  }
  return null;
}
function isOrphanedDefault(k){
  for (var i = 0; i < ACTIONS.length; i++){
    if (ACTIONS[i].def === k && keyMap[ACTIONS[i].id] !== k) return true;
  }
  return false;
}

/* ---------------------------------------------------------------------------
   Held-state bookkeeping: physical key -> what its press produced.
     { logical: <default key written, or null for a swallowed orphan>,
       drive:   <window.drive field set on press, or null> }
   Keyup replays the record, NOT the current mapping, so a mid-hold
   remap can never leave a logical key or pedal stuck down.
   ------------------------------------------------------------------------- */
var held = {};

/* Capture state for the remap UI: while non-null the player is
   assigning a key — { action: <actionId>, timer: <timeout id> }. During
   capture ALL non-typing key events are swallowed and the next fresh
   keydown assigns (Esc cancels instead). Nothing reaches the game. */
var capture = null;
var CAPTURE_MS = 10000; // capture auto-cancels after 10 s

/* ---------------------------------------------------------------------------
   Public API — window.KeyboardRemap. getMapping returns a copy;
   setMapping validates like the loader and applies the same steal rule;
   resetMapping restores the defaults; openRemapUI shows the panel.
   Every change is saved to localStorage immediately.
   ------------------------------------------------------------------------- */
var api = {
  capturing: null,
  getMapping: function(){ return mappingCopy(); },
  setMapping: function(next){
    if (next && typeof next === 'object'){
      for (var i = 0; i < ACTIONS.length; i++){
        var id = ACTIONS[i].id;
        if (Object.prototype.hasOwnProperty.call(next, id)){
          var v = next[id];
          if (v === null) assignKey(id, null);
          else if (validKey(v)) assignKey(id, String(v).toLowerCase());
        }
      }
      saveMap();
      refreshRemapUI();
    }
    return mappingCopy();
  },
  resetMapping: function(){
    cancelCapture();
    for (var i = 0; i < ACTIONS.length; i++) keyMap[ACTIONS[i].id] = ACTIONS[i].def;
    saveMap();
    refreshRemapUI();
    reportSys('ok', 'keyboard keys reset to defaults');
    return mappingCopy();
  },
  openRemapUI: function(){ openRemapUI(); }
};
try { window.KeyboardRemap = api; } catch(e){}

/* Keep the public capture field in step with the capture state. */
function exposeStatus(){
  api.capturing = capture ? capture.action : null;
}

/* ---------------------------------------------------------------------------
   Reporting — same pattern sim_core.js / gamepad_input.js use: tell the
   in-game Report panel the module is alive and what changed.
   ------------------------------------------------------------------------- */
function reportSys(status, note){
  try{
    if (typeof Report !== 'undefined' && Report.setSys)
      Report.setSys('keyboardRemap', {status: status, version: '1.0', note: note});
  }catch(e){}
}

/* ---------------------------------------------------------------------------
   Defensive accessors for the game's live input objects. Fetched fresh
   on every use: hot-reload can replace window.keys / window.drive with
   new objects, and a stale reference would silently write nowhere.
   ------------------------------------------------------------------------- */
function liveKeys(){
  try { return (typeof window.keys !== 'undefined' && window.keys) ? window.keys : null; }
  catch(e){ return null; }
}
function liveDrive(){
  try { return (typeof window.drive !== 'undefined' && window.drive) ? window.drive : null; }
  catch(e){ return null; }
}

/* True while the player is driving a vehicle. Same detection the
   gamepad module uses (the game's `car` object when reachable, else
   the gas pedal element, which the game only displays while driving). */
function isDriving(){
  try { if (typeof car !== 'undefined' && car && car.driving) return true; }
  catch(e){}
  try {
    var g = document.getElementById('gas-btn');
    if (g && g.style && g.style.display === 'block') return true;
  } catch(e){}
  return false;
}

/* ---------------------------------------------------------------------------
   The logical writes — a line-for-line mirror of what the game's own
   keydown/keyup handlers do for a DEFAULT key:
     keydown: keys[k]=true; if repeat, nothing more. 'i' clicks the
       inventory path (handler calls toggleInv(); the on-screen
       #inv-btn's own click handler calls the same toggleInv(), so
       clicking the button is the identical effect). 'e' clicks
       #action-btn when it is on screen. Otherwise, while driving, the
       key sets its drive field.
     keyup: keys[k]=false; the key's drive field (if any) clears
       unconditionally — driving or not, exactly like the handler.
   ------------------------------------------------------------------------- */
function clickEl(id){
  try {
    var el = document.getElementById(id);
    if (el && typeof el.click === 'function') el.click();
  } catch(e){}
}
/* Mirrors the handler's 'e' branch: click only when on screen. */
function clickActionBtn(){
  try {
    var ab = document.getElementById('action-btn');
    if (ab && ab.style.display !== 'none') ab.click();
  } catch(e){}
}

function logicalDown(logical, repeat){
  var lk = liveKeys(); if (lk) lk[logical] = true;
  if (repeat) return null;      // handler: auto-repeat does nothing more
  if (logical === 'i'){ clickEl('inv-btn'); return null; }
  if (logical === 'e'){ clickActionBtn(); return null; }
  var field = Object.prototype.hasOwnProperty.call(DRIVE_FOR, logical)
    ? DRIVE_FOR[logical] : null;
  if (field && isDriving()){
    var ld = liveDrive(); if (ld) ld[field] = true;
    return field;
  }
  return null;
}

function logicalUp(logical){
  var lk = liveKeys(); if (lk) lk[logical] = false;
  if (Object.prototype.hasOwnProperty.call(DRIVE_FOR, logical)){
    var ld = liveDrive(); if (ld) ld[DRIVE_FOR[logical]] = false;
  }
}

/* Release every logical state this module currently holds (capture is
   starting, so the game must be fully hands-off). Safe because for
   remapped keys this module is the ONLY writer of that logical state —
   the game handler never saw the physical key. (The gamepad module
   re-asserts its own holds every frame, so even a shared field like
   keys['w'] heals itself next frame.) */
function releaseAllHeld(){
  for (var k in held){
    if (Object.prototype.hasOwnProperty.call(held, k) && held[k].logical)
      logicalUp(held[k].logical);
  }
  held = {};
}

/* ---------------------------------------------------------------------------
   Typing guard: events aimed at text entry are never intercepted —
   not for remapping, not during capture. (SELECT included beyond the
   strict spec: arrow/letter keys there belong to the form control.)
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

/* The physical key identity, normalized exactly like the game handler
   (e.key.toLowerCase()), so 'W' and 'w' are the same key, Space is ' ',
   and arrows are 'arrowup' etc. */
function physKey(e){
  try { return String((e && e.key) || '').toLowerCase(); } catch(err){ return ''; }
}

/* ---------------------------------------------------------------------------
   The interception handlers (capture phase on window, so they run
   BEFORE the game's own bubble-phase window handlers and can stop a
   remapped key from ever reaching them).

   keydown decision order:
     1. typing target        -> pass through, always.
     2. capture active       -> swallow; Esc cancels, a fresh (non-
                                repeat) press assigns and ends capture.
     3. key is assigned to   -> swallow; reproduce the handler's
        an action on a NON-     behavior for the action's default key;
        default key             record the hold (repeats only re-affirm
                                keys[logical], like the handler does).
     4. key is an orphaned   -> swallow; record an empty hold so the
        default                 keyup is swallowed too; write nothing.
     5. anything else —      -> pass through untouched. NOTE: an action
        including an action     still sitting on its DEFAULT key is
        on its default key      case 5 by design: the game handler
                                must process its own default keys
                                exactly as if this module did not exist
                                (that is what makes the default layout
                                a true pass-through, not a re-route).
   keyup decision order:
     1. typing target        -> pass through.
     2. capture active       -> swallow (the assigning press's own keyup
                                must not leak into the game either).
     3. a hold is recorded   -> swallow; clear exactly what the press
                                set (record, not current mapping).
     4. key is assigned on   -> swallow; clear the action's logical key
        a non-default key,      as a safety net (covers a press that
        or is an orphaned       predates this module).
        default              -> for the orphaned default ALSO run
                                logicalUp(k): the game handler may have
                                set that key's state before the action
                                was remapped mid-hold, and since we
                                swallow this keyup it would never get
                                to clear it — so we clear it for it.
     5. anything else        -> pass through untouched.
   ------------------------------------------------------------------------- */
function onKeyDown(e){
  if (isTextTarget(e)) return;
  var k = physKey(e);
  if (!k) return;

  if (capture){
    try { e.preventDefault(); } catch(err){}
    try { e.stopImmediatePropagation(); } catch(err){}
    if (k === 'escape'){ cancelCapture(); return; }
    if (!e.repeat) finishCapture(k);
    return;
  }

  var act = actionForPhysical(k);
  if (act && act.def !== k){
    /* A genuinely remapped binding: the physical key is ours. (An
       action still on its default key falls through to the game
       handler untouched — see decision order note 5.) */
    try { e.preventDefault(); } catch(err){}
    try { e.stopImmediatePropagation(); } catch(err){}
    if (held[k]){
      /* Auto-repeat of a key we already hold: the handler would set
         keys[k]=true again and nothing more — mirror exactly that. */
      var lk = liveKeys(); if (lk) lk[act.def] = true;
      return;
    }
    var field = logicalDown(act.def, !!e.repeat);
    held[k] = { logical: act.def, drive: field };
    return;
  }

  if (!act && isOrphanedDefault(k)){
    try { e.preventDefault(); } catch(err){}
    try { e.stopImmediatePropagation(); } catch(err){}
    held[k] = { logical: null, drive: null };
    return;
  }
  /* Not ours: pass through untouched. */
}

function onKeyUp(e){
  if (isTextTarget(e)) return;
  var k = physKey(e);
  if (!k) return;

  if (capture){
    try { e.preventDefault(); } catch(err){}
    try { e.stopImmediatePropagation(); } catch(err){}
    return;
  }

  if (held[k]){
    try { e.preventDefault(); } catch(err){}
    try { e.stopImmediatePropagation(); } catch(err){}
    var rec = held[k];
    delete held[k];
    if (rec.logical) logicalUp(rec.logical);
    return;
  }

  var act = actionForPhysical(k);
  if (act && act.def !== k){
    try { e.preventDefault(); } catch(err){}
    try { e.stopImmediatePropagation(); } catch(err){}
    logicalUp(act.def);   // safety net (see decision order note 4)
    return;
  }

  if (!act && isOrphanedDefault(k)){
    try { e.preventDefault(); } catch(err){}
    try { e.stopImmediatePropagation(); } catch(err){}
    /* The game handler may hold state for this key from BEFORE the
       remap (pressed at defaults, remapped mid-hold). Its keyup will
       never arrive now — clear the state on its behalf. */
    logicalUp(k);
    return;
  }
  /* Not ours: pass through untouched. */
}

/* ---------------------------------------------------------------------------
   Capture flow (remapping).
   assignKey is the single writer of the live table used by BOTH the
   capture flow and the setMapping API: it applies the steal rule — if
   the key already belongs to another action, that action becomes
   unassigned (last assignment wins) — so the table can never hold a
   duplicate key. (It deliberately does NOT save or refresh; callers do,
   so setMapping can batch several assignments into one save.)
   ------------------------------------------------------------------------- */
function assignKey(actionId, k){
  if (k !== null){
    for (var i = 0; i < ACTIONS.length; i++){
      var other = ACTIONS[i].id;
      if (other !== actionId && keyMap[other] === k) keyMap[other] = null;
    }
  }
  keyMap[actionId] = k;
}

/* Begin capturing for one action (or cancel if that same action is
   already capturing — the Change button toggles). Anything this module
   currently holds is released first, so the game is fully hands-off
   while the player picks a key. A key already held at this moment can
   only produce auto-repeat events, which the capture branch ignores —
   so it can never assign itself; only a fresh press assigns. */
function startCapture(actionId){
  if (capture && capture.action === actionId){ cancelCapture(); return; }
  cancelCapture();           // end any other action's capture first
  releaseAllHeld();
  capture = { action: actionId, timer: null };
  try {
    capture.timer = setTimeout(function(){ cancelCapture(); }, CAPTURE_MS);
  } catch(e){}
  refreshRemapUI();
  exposeStatus();
}

/* End capture without assigning (toggle-cancel, Esc, timeout). */
function cancelCapture(){
  if (!capture) return;
  try { if (capture.timer) clearTimeout(capture.timer); } catch(e){}
  capture = null;
  refreshRemapUI();
  exposeStatus();
}

/* A fresh key press landed during capture: assign it, steal if needed,
   save immediately, end capture, and refresh the panel. */
function finishCapture(k){
  var actionId = capture.action;
  try { if (capture.timer) clearTimeout(capture.timer); } catch(e){}
  capture = null;
  assignKey(actionId, k);
  saveMap();
  refreshRemapUI();
  exposeStatus();
  reportSys('ok', 'keyboard key assigned: ' + actionId + ' -> ' + keyLabel(k) + customSuffix());
}

/* ---------------------------------------------------------------------------
   Remap UI — built and injected by this module (index.html only gains
   this module's script tag). Preferred home: a "Keyboard Keys" section
   appended to the game's own Settings panel (#settings .card, just
   above its Close button) — the same home gamepad_input.js uses for
   "Controller Buttons", so both sections sit side by side in Settings.
   Fallback (Settings card not found): a floating "⌨ Keys" button opens
   this module's own overlay panel with the same rows. Injection is
   idempotent (a hot reload re-running this module finds the existing
   section and reuses it) and is retried on a timer until it lands,
   since the deferred loader's timing vs. DOM parsing is not ours to
   assume. (Unlike the gamepad module there is no per-frame poll here,
   so the retry runs on a 250 ms interval that stops once injected —
   and gives up to the fallback after ~5 s.)
   ------------------------------------------------------------------------- */
var uiMode = '';        // '' = not injected yet, 'settings', or 'overlay'
var rowsEl = null;      // container the action rows are rendered into
var hintEl = null;      // hint line under the rows
var overlayEl = null;   // fallback overlay panel element (overlay mode only)
var uiTries = 0;        // injection attempts so far (fallback timing)
var uiTimer = null;     // retry timer; cleared once injected

/* Locate the Settings card element without querySelector (older
   WebViews are happier with plain child walks — same helper shape as
   gamepad_input.js). */
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

/* Small element builder: tag + optional inline style + optional text. */
function mkEl(tag, cssText, text){
  var el = document.createElement(tag);
  if (cssText) el.style.cssText = cssText;
  if (typeof text === 'string') el.textContent = text;
  return el;
}

/* Build the shared panel contents (heading, rows box, hint, reset)
   into the given host element. Used by both the Settings section and
   the fallback overlay, so the two can never drift apart. */
function buildRemapPanel(host){
  var h = mkEl('h3', 'margin:14px 0 4px 0;color:#ffd75e;font-size:clamp(17px,5vw,22px);',
               'Keyboard Keys');
  host.appendChild(h);
  rowsEl = mkEl('div', '', null);
  host.appendChild(rowsEl);
  hintEl = mkEl('div',
    'font-size:12px;color:#9fb3c8;margin:6px 0 2px 0;line-height:1.45;',
    '');
  host.appendChild(hintEl);
  var reset = mkEl('button',
    'display:block;width:100%;margin:8px 0;padding:10px 14px;font-size:14px;' +
    'font-weight:bold;border-radius:10px;border:2px solid #444;background:#222836;' +
    'color:#fff;text-align:left;box-sizing:border-box;',
    'Reset keyboard keys');
  reset.id = 'kb-remap-reset';
  reset.addEventListener('click', function(){ api.resetMapping(); });
  host.appendChild(reset);
}

/* Try to inject the UI once. Returns true once injected (either mode),
   which stops the retry timer. */
function ensureRemapUI(){
  if (uiMode) return true;
  uiTries++;
  try {
    var card = findSettingsCard();
    if (card){
      /* Reuse an existing section after a hot reload instead of adding
         a second one. */
      var existing = document.getElementById('kb-remap');
      if (existing){
        rowsEl = document.getElementById('kb-remap-rows');
        hintEl = document.getElementById('kb-remap-hint');
        uiMode = 'settings';
        refreshRemapUI();
        return true;
      }
      var sec = mkEl('div', '', null);
      sec.id = 'kb-remap';
      /* Rows/hint get stable ids in this mode so a hot reload can find
         them again (the overlay mode keeps its own references instead). */
      buildRemapPanel(sec);
      rowsEl.id = 'kb-remap-rows';
      hintEl.id = 'kb-remap-hint';
      /* Sit just above the panel's Close button when it is a direct
         child of the card, else simply at the end of the card. */
      var closeBtn = document.getElementById('set-close');
      if (closeBtn && closeBtn.parentNode === card) card.insertBefore(sec, closeBtn);
      else card.appendChild(sec);
      uiMode = 'settings';
      refreshRemapUI();
      return true;
    }
    /* Settings card still missing: keep retrying for ~5 s (the retry
       timer drives us), then fall back to our own floating button +
       overlay panel. */
    if (uiTries >= 20){
      var fab = mkEl('button',
        'position:fixed;left:12px;top:118px;z-index:35;padding:10px 14px;' +
        'font-size:14px;font-weight:bold;border-radius:10px;border:2px solid #444;' +
        'background:#222836;color:#fff;',
        '⌨ Keys');
      fab.id = 'kb-remap-fab';
      fab.addEventListener('click', function(){ openRemapUI(); });
      document.body.appendChild(fab);
      overlayEl = mkEl('div',
        'position:fixed;inset:0;z-index:65;display:none;align-items:center;' +
        'justify-content:center;background:rgba(0,0,0,.78);', null);
      overlayEl.id = 'kb-remap-overlay';
      var cardEl = mkEl('div',
        'background:#161b26;border-radius:14px;padding:20px 22px;max-width:420px;' +
        'width:86%;border:2px solid #ffd75e;max-height:86vh;overflow-y:auto;', null);
      buildRemapPanel(cardEl);
      var done = mkEl('button',
        'display:block;width:100%;margin-top:12px;padding:10px 18px;font-size:15px;' +
        'border-radius:10px;border:none;background:#ffd75e;color:#111;font-weight:bold;',
        'Done');
      done.addEventListener('click', function(){ overlayEl.style.display = 'none'; });
      cardEl.appendChild(done);
      overlayEl.appendChild(cardEl);
      document.body.appendChild(overlayEl);
      uiMode = 'overlay';
      refreshRemapUI();
      return true;
    }
  } catch(e){}
  return false;
}

/* Show the remap UI: in Settings mode that means opening the Settings
   panel (the gear button toggles it); in overlay mode, show the
   overlay. Mirrors gamepad_input.js. */
function panelShown(id){
  try {
    var el = document.getElementById(id);
    return !!(el && el.classList && el.classList.contains('show'));
  } catch(e){ return false; }
}
function openRemapUI(){
  ensureRemapUI();
  if (uiMode === 'overlay' && overlayEl){
    overlayEl.style.display = 'flex';
  } else if (uiMode === 'settings'){
    if (!panelShown('settings')) clickEl('help-btn');
  }
  refreshRemapUI();
}

/* Re-render the rows from the live mapping + capture state. Each row:
   action name | current key label | Change/Cancel button. While an
   action is capturing, its label slot shows "press a key…" instead. */
function refreshRemapUI(){
  if (!rowsEl) return;
  try {
    rowsEl.textContent = '';  // clear previous rows (drops their children)
    for (var i = 0; i < ACTIONS.length; i++){
      (function(act){
        var capturing = !!(capture && capture.action === act.id);
        var row = mkEl('div',
          'display:flex;align-items:center;gap:8px;background:#222836;' +
          'border:2px solid #444;border-radius:10px;padding:8px 10px;margin:8px 0;' +
          'box-sizing:border-box;', null);
        var name = mkEl('span',
          'flex:1;color:#fff;font-weight:bold;font-size:14px;', act.label);
        var cur = mkEl('span',
          'color:' + (capturing ? '#39ff6a' : '#ffd75e') + ';font-weight:bold;' +
          'font-size:14px;min-width:44px;text-align:right;',
          capturing ? 'press a key…' : keyLabel(keyMap[act.id]));
        var btn = mkEl('button',
          'padding:8px 12px;border-radius:8px;border:2px solid #555;' +
          'background:#2d3547;color:#fff;font-weight:bold;font-size:13px;',
          capturing ? 'Cancel' : 'Change');
        btn.addEventListener('click', function(){ startCapture(act.id); });
        row.appendChild(name);
        row.appendChild(cur);
        row.appendChild(btn);
        rowsEl.appendChild(row);
      })(ACTIONS[i]);
    }
    if (hintEl){
      hintEl.textContent =
        'Tap Change, then press the key you want for that action. Giving ' +
        'a key to one action takes it away from any other. A moved action ' +
        'leaves its old key doing nothing. The arrow keys always keep ' +
        'their built-in driving role.';
    }
  } catch(e){}
}

/* ---------------------------------------------------------------------------
   Boot: register the capture-phase interception FIRST (input must work
   even if the UI injection below has trouble), announce ourselves to
   the Report panel, then inject the remap UI (best effort — the retry
   timer keeps trying until it lands, then stops).
   ------------------------------------------------------------------------- */
if (typeof window !== 'undefined' && window.addEventListener){
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
}
reportSys('ok', 'keyboard remap live — Settings -> "Keyboard Keys"' + customSuffix());
exposeStatus();
if (!ensureRemapUI()){
  try {
    uiTimer = setInterval(function(){
      if (ensureRemapUI() && uiTimer){ clearInterval(uiTimer); uiTimer = null; }
    }, 250);
  } catch(e){}
}

})();
