/* ============================================================================
   GAMEPAD INPUT v2.0 — Bluetooth / USB controller support (Joshua 2026-10-16)
   v2.0 adds USER-REMAPPABLE BUTTONS (Settings -> "Controller Buttons").

   PURPOSE:
   Lets a standard game controller (Bluetooth HID or USB — Android pairs it
   at the system level; this module only reads the browser Gamepad API)
   drive Surviving Adamsville exactly the way the touch controls and the
   physical keyboard already do.

   HOW IT INTEGRATES (same contract as touch, per the sim_core.js design):
   The game's keydown/keyup handlers and the touch controls write two LIVE
   objects — window.keys (lowercase e.key strings: 'w', 'a', 's', 'd', 'e')
   and window.drive ({gas, brake, hb, left, right}). sim_core.js
   Input.sample() copies those into per-tick snapshots and ALL game logic
   reads the snapshots. This module is just one more writer of the live
   objects: every frame it polls the first connected gamepad and holds /
   releases the same fields the keyboard and pedals would. It changes no
   game logic, reads no game state except the driving check below, and
   every access is typeof/try guarded (the sim_core.js pattern) so load
   order can never throw.

   WHY KEYS AND NOT THE TOUCH JOYSTICK OBJECT:
   The on-screen joystick writes an analog vector into a `joy` object that
   lives inside index.html's main code block and is NOT exposed on window,
   so no external script can write it without editing game code. The keys
   pathway IS exposed (window.keys), is exactly what a physical keyboard
   uses, and the game's movement code sums keys and joystick together — so
   writing keys is the faithful equivalent: left stick up = holding W, etc.
   (Movement speed is then keyboard-style full speed past the threshold
   instead of the touch stick's analog curve — noted for Joshua.)

   DRIVING GATE:
   drive.* fields are only written while the player is actually driving,
   detected the same way engine_sounds.js / gps_system.js detect it
   (typeof car !== 'undefined' && car.driving), with a DOM fallback (the
   on-screen gas pedal is only displayed while driving — setDrivingUI).
   On foot, the triggers / d-pad / stick-X steer nothing, exactly like the
   keyboard scheme where WASD only becomes pedals inside the car.

   CAMERA:
   The orbit camera's yaw variables (camYaw / look.yawOff / fpLookYaw)
   also live inside index.html's main block and are not exposed on window,
   and the game has NO keyboard camera keys to fall back to (verified:
   camera moves by touch/mouse drag only). So the right stick is
   intentionally unmapped rather than faking drag events.

   OWNERSHIP RULE (never fight the physical keyboard):
   The module only ever releases a key/field that IT pressed. If a field
   was already true when the module first grabbed it (e.g. Joshua is
   holding W on a real keyboard while tapping the stick), the field is
   marked "borrowed" and the module leaves it alone on release — the real
   owner's own release clears it. On controller disconnect, everything the
   module holds is released, so nothing can stick.

   CONTROLLER MAP — the six button-backed actions are REMAPPABLE:
   Open Settings (gear button) -> "Controller Buttons" section. Each row
   shows the action, its current button, and a Change button: tap Change,
   then press any controller button to assign it. The mapping is saved in
   localStorage (key 'sa.gamepad.map.v1') and survives restarts. If the
   button you press already belongs to another action, that action becomes
   unassigned ("—") — last assignment wins. "Reset controller buttons"
   restores the defaults below. An action set to "—" (unassigned) does
   nothing when playing. The sticks and the D-pad are NOT remappable.
   Defaults (standard mapping indices):
     A (0) ........ ACTION — Joshua's universal action button: mirrors the
                    'e' key exactly (holds keys['e'] and clicks #action-btn
                    on the press edge when the button is on screen)
     RT (7) ....... drive.gas      (analog value > 0.35 while driving)
     LT (6) ....... drive.brake    (analog value > 0.35 while driving)
     LB (4) ....... drive.hb       (handbrake, while driving)
     Start (9) .... settings menu (clicks the #help-btn gear, which
                    toggles the #settings panel)
     B (1) ........ back — closes the topmost open panel (#help, then
                    #settings, then the full map)
   Fixed (not remappable):
     Left stick .......... movement (keys w/a/s/d; 8-way past threshold)
     Left stick X (driving)  steer (drive.left / drive.right)
     D-pad up / down ..... drive.gas / drive.brake (while driving)
     D-pad left / right .. drive.left / drive.right (while driving)
     Right stick ......... unmapped (see CAMERA note above)

   DEPENDENCIES: none. Loaded via the deferred data-dsrc queue right after
   sim_core.js. Runs one lightweight poll per animation frame and does
   nothing at all until a gamepad is connected. The remap UI is built and
   injected by this module at runtime (index.html is untouched): it lives
   in the game's own Settings panel when that panel is found, otherwise a
   floating "🎮 Buttons" button opens the module's own overlay panel.
   ============================================================================ */
(function gamepadInput(){
'use strict';

/* ---------------------------------------------------------------------------
   Tunables — kept as named constants so Joshua can ask for a feel change
   (e.g. a bigger deadzone) without hunting through the logic.
   ------------------------------------------------------------------------- */
var DEADZONE   = 0.18;  // radial deadzone: stick drift below this is ignored
var AXIS_ON    = 0.40;  // per-axis push needed to count as a movement key
var STEER_ON   = 0.35;  // stick-X push needed to steer while driving
var TRIGGER_ON = 0.35;  // analog trigger travel that counts as pedal down

/* ---------------------------------------------------------------------------
   The remappable actions and their DEFAULT standard-mapping button
   indices. This table is the ONLY place those six indices appear: the
   runtime reads the live mapping (btnMap, loaded from localStorage) for
   every one of these actions, never a hardcoded index. The sticks and
   the D-pad are fixed by design and are not part of this table.
   ------------------------------------------------------------------------- */
var ACTIONS = [
  { id: 'action',    label: 'Action (interact / enter)', def: 0 },  // A
  { id: 'gas',       label: 'Gas (driving)',             def: 7 },  // RT
  { id: 'brake',     label: 'Brake (driving)',           def: 6 },  // LT
  { id: 'handbrake', label: 'Handbrake (driving)',       def: 4 },  // LB
  { id: 'settings',  label: 'Settings menu',             def: 9 },  // Start
  { id: 'back',      label: 'Back / close panel',         def: 1 }   // B
];

/* Human-readable names for standard-mapping button indices, used by the
   remap UI so the player sees "RT" instead of "7". Anything past the
   named range falls back to "Button N". */
var BTN_NAMES = {
  0: 'A', 1: 'B', 2: 'X', 3: 'Y',
  4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
  8: 'Select', 9: 'Start',
  10: 'L3 (stick click)', 11: 'R3 (stick click)',
  12: 'D-pad Up', 13: 'D-pad Down', 14: 'D-pad Left', 15: 'D-pad Right',
  16: 'Home', 17: 'Share'
};
function btnLabel(idx){
  if (idx === null || typeof idx === 'undefined') return '—';  // unassigned
  return BTN_NAMES[idx] || ('Button ' + idx);
}

/* ---------------------------------------------------------------------------
   Mapping persistence — localStorage key 'sa.gamepad.map.v1' (JSON object
   {actionId: buttonIndexOrNull}). Loading is defensive: bad JSON, wrong
   shapes, out-of-range values and duplicate indices all fall back to the
   defaults for the affected actions instead of breaking the module.
   ------------------------------------------------------------------------- */
var MAP_STORAGE_KEY = 'sa.gamepad.map.v1';

/* Defensive localStorage reach (typeof-guarded; private-mode browsers can
   throw on access, and a storage failure must never kill input). */
function storage(){
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch(e){}
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch(e){}
  return null;
}

/* A stored/assigned button value is valid only as null (unassigned) or an
   integer in a sane gamepad range. */
function validBtn(v){
  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0 && v <= 63;
}

/* Load the mapping: start from defaults, overlay any valid stored values.
   If two stored actions claim the same button, the earlier action in the
   ACTIONS table keeps it and the later one becomes unassigned — matching
   the "one button, one action" rule the capture flow enforces. */
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
        else if (validBtn(v)) map[id] = v;
      }
    }
  }
  /* Resolve duplicate claims deterministically (defaults cannot collide,
     but a hand-edited or API-written store could). */
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
  try { st.setItem(MAP_STORAGE_KEY, JSON.stringify(btnMap)); } catch(e){}
}

/* The live mapping. Runtime code reads ONLY this table for the six
   remappable actions. */
var btnMap = loadMap();

/* True when the live mapping differs from the shipped defaults (used for
   the Report note so Joshua can tell a custom layout is active). */
function isCustomMap(){
  for (var i = 0; i < ACTIONS.length; i++){
    if (btnMap[ACTIONS[i].id] !== ACTIONS[i].def) return true;
  }
  return false;
}
function customSuffix(){
  return isCustomMap() ? ' — custom button mapping active' : '';
}

/* A plain copy of the live mapping (callers must not mutate our table). */
function mappingCopy(){
  var out = {};
  for (var i = 0; i < ACTIONS.length; i++) out[ACTIONS[i].id] = btnMap[ACTIONS[i].id];
  return out;
}

/* ---------------------------------------------------------------------------
   Module state.
   ------------------------------------------------------------------------- */
var padIndex = -1;      // navigator.getGamepads() index we are reading (-1 = none)
var padId = '';         // controller id string from the browser (for the Report)
var prevBtn = [];       // last frame's button-down states, for press-edge detection

/* Ownership bookkeeping: name -> bool. The bool records whether the field
   was ALREADY true when we first grabbed it ("borrowed" from the keyboard
   or touch pedals). We only clear fields whose entry is false. */
var myKeys = {};        // entries for window.keys we currently hold
var myDrive = {};       // entries for window.drive we currently hold

/* Capture state for the remap UI: while non-null, the player is assigning
   a button — { action: <actionId>, deadline: <ms timestamp> }. During
   capture the poll suppresses ALL writes to the game (and anything held
   was released when capture started), so pressing buttons to assign them
   can never drive the car or trigger the action being assigned. */
var capture = null;
var CAPTURE_MS = 10000; // capture auto-cancels after 10 s

/* ---------------------------------------------------------------------------
   Public API — window.GamepadInput. The status fields (connected, index,
   id, driving, capturing) are refreshed by the poll; the functions let the
   player (or a future UI) read/change the mapping programmatically.
   getMapping returns a copy; setMapping validates like the loader does
   and applies the same "one button, one action" steal rule; resetMapping
   restores the defaults; openRemapUI shows the remap panel. Every change
   is saved to localStorage immediately.
   ------------------------------------------------------------------------- */
var api = {
  connected: false,
  index: -1,
  id: '',
  driving: false,
  capturing: null,
  getMapping: function(){ return mappingCopy(); },
  setMapping: function(next){
    if (next && typeof next === 'object'){
      for (var i = 0; i < ACTIONS.length; i++){
        var id = ACTIONS[i].id;
        if (Object.prototype.hasOwnProperty.call(next, id)){
          var v = next[id];
          if (v === null) assignBtn(id, null);
          else if (validBtn(v)) assignBtn(id, v);
        }
      }
      saveMap();
      refreshRemapUI();
    }
    return mappingCopy();
  },
  resetMapping: function(){
    cancelCapture();
    for (var i = 0; i < ACTIONS.length; i++) btnMap[ACTIONS[i].id] = ACTIONS[i].def;
    saveMap();
    refreshRemapUI();
    reportSys('ok', 'controller buttons reset to defaults');
    return mappingCopy();
  },
  openRemapUI: function(){ openRemapUI(); }
};
try { window.GamepadInput = api; } catch(e){}

/* Keep the public status fields in step with the poll. */
function exposeStatus(driving){
  api.connected = (padIndex !== -1);
  api.index = padIndex;
  api.id = padId;
  api.driving = !!driving;
  api.capturing = capture ? capture.action : null;
}

/* ---------------------------------------------------------------------------
   Reporting — same pattern sim_core.js uses: tell Joshua's in-game Report
   panel the module is alive and when a controller connects/disconnects.
   ------------------------------------------------------------------------- */
function reportSys(status, note){
  try{
    if (typeof Report !== 'undefined' && Report.setSys)
      Report.setSys('gamepad', {status: status, version: '2.0', note: note});
  }catch(e){}
}

/* ---------------------------------------------------------------------------
   Defensive accessors for the game's live input objects. These are fetched
   fresh on every use: hot-reload can replace window.keys / window.drive
   with new objects, and a stale reference would silently write nowhere.
   ------------------------------------------------------------------------- */
function liveKeys(){
  try { return (typeof window.keys !== 'undefined' && window.keys) ? window.keys : null; }
  catch(e){ return null; }
}
function liveDrive(){
  try { return (typeof window.drive !== 'undefined' && window.drive) ? window.drive : null; }
  catch(e){ return null; }
}

/* True while the player is driving a vehicle. Primary test is the same one
   engine_sounds.js and gps_system.js use; the fallback watches the gas
   pedal element, which setDrivingUI() only displays while driving. */
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
   Hold / release with ownership tracking.
   hold*: set the field true; if this is the first frame we touch it,
     remember whether it was already true (borrowed).
   release*: if we own the field (not borrowed), set it false; drop the
     bookkeeping entry either way.
   ------------------------------------------------------------------------- */
function holdKey(k){
  var lk = liveKeys(); if (!lk) return;
  if (!Object.prototype.hasOwnProperty.call(myKeys, k)) myKeys[k] = !!lk[k];
  lk[k] = true;
}
function releaseKey(k){
  if (!Object.prototype.hasOwnProperty.call(myKeys, k)) return;
  var borrowed = myKeys[k];
  delete myKeys[k];
  if (!borrowed){
    var lk = liveKeys(); if (lk) lk[k] = false;
  }
}
function holdDrive(f){
  var ld = liveDrive(); if (!ld) return;
  if (!Object.prototype.hasOwnProperty.call(myDrive, f)) myDrive[f] = !!ld[f];
  ld[f] = true;
}
function releaseDrive(f){
  if (!Object.prototype.hasOwnProperty.call(myDrive, f)) return;
  var borrowed = myDrive[f];
  delete myDrive[f];
  if (!borrowed){
    var ld = liveDrive(); if (ld) ld[f] = false;
  }
}

/* Release everything this module holds (disconnect / pad lost / capture
   starting). Iterates over a snapshot of names because release* mutates
   the books. */
function clearMine(){
  var ks = Object.keys(myKeys), fs = Object.keys(myDrive), i;
  for (i = 0; i < ks.length; i++) releaseKey(ks[i]);
  for (i = 0; i < fs.length; i++) releaseDrive(fs[i]);
  prevBtn = [];
}

/* ---------------------------------------------------------------------------
   Small DOM helpers for the button mappings. All guarded: if the element
   is missing (different build / menu closed) the press simply does nothing.
   ------------------------------------------------------------------------- */
function clickEl(id){
  try {
    var el = document.getElementById(id);
    if (el && typeof el.click === 'function') el.click();
  } catch(e){}
}
function panelShown(id){
  try {
    var el = document.getElementById(id);
    return !!(el && el.classList && el.classList.contains('show'));
  } catch(e){ return false; }
}
/* Mirrors the game's own 'e' keydown handler: it clicks #action-btn only
   when the button is on screen (its inline display is not 'none'). */
function clickActionBtn(){
  try {
    var ab = document.getElementById('action-btn');
    if (ab && ab.style.display !== 'none') ab.click();
  } catch(e){}
}

/* ---------------------------------------------------------------------------
   Gamepad reading helpers. Buttons can be objects ({pressed, value}) in
   the standard mapping or plain numbers on very old implementations.
   The mapBtn* variants read through the REMAP TABLE and treat an
   unassigned (null) index as "never pressed" — they are the only readers
   the six remappable actions use.
   ------------------------------------------------------------------------- */
function btnDown(gp, i){
  var b = gp.buttons && gp.buttons[i];
  if (!b) return false;
  if (typeof b === 'number') return b > 0.5;
  return !!b.pressed || (typeof b.value === 'number' && b.value > 0.5);
}
function btnVal(gp, i){
  var b = gp.buttons && gp.buttons[i];
  if (!b) return 0;
  if (typeof b === 'number') return b;
  if (typeof b.value === 'number') return b.value;
  return b.pressed ? 1 : 0;
}
/* Rising edge: down this frame, up last frame. */
function btnEdge(gp, i){
  return btnDown(gp, i) && !prevBtn[i];
}
function mapBtnDown(gp, idx){
  return (idx === null || typeof idx === 'undefined') ? false : btnDown(gp, idx);
}
function mapBtnVal(gp, idx){
  return (idx === null || typeof idx === 'undefined') ? 0 : btnVal(gp, idx);
}
function mapBtnEdge(gp, idx){
  return (idx === null || typeof idx === 'undefined') ? false : btnEdge(gp, idx);
}

/* Find the pad to read: the one that announced itself via
   'gamepadconnected' if it is still there, else the first connected pad
   (some browsers only reveal a pad after its first button press). */
function getPad(){
  var list = null;
  try {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    list = navigator.getGamepads();
  } catch(e){ return null; }
  if (!list) return null;
  if (padIndex >= 0 && list[padIndex]) return list[padIndex];
  for (var i = 0; i < list.length; i++){
    if (list[i]){ padIndex = list[i].index; padId = list[i].id || ''; return list[i]; }
  }
  return null;
}

/* ---------------------------------------------------------------------------
   Capture flow (remapping).
   assignBtn is the single writer of the live table used by BOTH the
   capture flow and the setMapping API: it applies the steal rule — if the
   button already belongs to another action, that action becomes
   unassigned (last assignment wins) — so the table can never hold a
   duplicate index. (It deliberately does NOT save or refresh; callers do,
   so setMapping can batch several assignments into one save.)
   ------------------------------------------------------------------------- */
function assignBtn(actionId, idx){
  if (idx !== null){
    for (var i = 0; i < ACTIONS.length; i++){
      var other = ACTIONS[i].id;
      if (other !== actionId && btnMap[other] === idx) btnMap[other] = null;
    }
  }
  btnMap[actionId] = idx;
}

/* Begin capturing for one action (or cancel if that same action is
   already capturing — the Change button toggles). Anything the module is
   currently holding is released first, so the game is fully hands-off
   while the player picks a button. */
function startCapture(actionId){
  if (capture && capture.action === actionId){ cancelCapture(); return; }
  capture = { action: actionId, deadline: Date.now() + CAPTURE_MS };
  clearMine();
  /* clearMine reset the edge snapshot; re-snapshot the pad's CURRENT
     state so a button the player happens to be holding at this moment
     does not count as the assigning press — only a fresh press does. */
  var gp0 = getPad();
  if (gp0) snapshotButtons(gp0);
  refreshRemapUI();
  exposeStatus();
}

/* End capture without assigning (toggle-cancel, timeout, disconnect). */
function cancelCapture(){
  if (!capture) return;
  capture = null;
  refreshRemapUI();
  exposeStatus();
}

/* A button press landed during capture: assign it, steal if needed, save
   immediately, end capture, and refresh the panel. */
function finishCapture(idx){
  var actionId = capture.action;
  assignBtn(actionId, idx);
  capture = null;
  saveMap();
  refreshRemapUI();
  exposeStatus();
  reportSys('ok', 'controller button assigned: ' + actionId + ' -> ' + btnLabel(idx) + customSuffix());
}

/* ---------------------------------------------------------------------------
   Remap UI — built and injected by this module (index.html untouched).
   Preferred home: a "Controller Buttons" section appended to the game's
   own Settings panel (#settings .card, just above its Close button), so
   it inherits the panel's look and opens with the gear like every other
   setting. Fallback (Settings card not found): a floating "🎮 Buttons"
   button opens the module's own overlay panel with the same rows.
   Injection is idempotent (a hot reload re-running this module finds the
   existing section and reuses it) and is retried from the poll until it
   lands, since the deferred loader's timing vs. DOM parsing is not ours
   to assume.
   ------------------------------------------------------------------------- */
var uiMode = '';        // '' = not injected yet, 'settings', or 'overlay'
var rowsEl = null;      // container the six action rows are rendered into
var hintEl = null;      // hint line under the rows (e.g. "connect a controller")
var overlayEl = null;   // fallback overlay panel element (overlay mode only)
var uiTries = 0;        // injection attempts so far (fallback timing)

/* Locate the Settings card element without querySelector (older WebViews
   are happier with plain child walks, and the harness stubs less). */
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

/* Build the shared panel contents (heading, rows box, hint, reset) into
   the given host element. Used by both the Settings section and the
   fallback overlay, so the two can never drift apart. */
function buildRemapPanel(host){
  var h = mkEl('h3', 'margin:14px 0 4px 0;color:#ffd75e;font-size:clamp(17px,5vw,22px);',
               'Controller Buttons');
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
    'Reset controller buttons');
  reset.id = 'gp-remap-reset';
  reset.addEventListener('click', function(){ api.resetMapping(); });
  host.appendChild(reset);
}

/* Try to inject the UI once. Returns true once injected (either mode). */
function ensureRemapUI(){
  if (uiMode) return true;
  uiTries++;
  try {
    var card = findSettingsCard();
    if (card){
      /* Reuse an existing section after a hot reload instead of adding a
         second one. */
      var existing = document.getElementById('gp-remap');
      if (existing){
        rowsEl = document.getElementById('gp-remap-rows');
        hintEl = document.getElementById('gp-remap-hint');
        uiMode = 'settings';
        refreshRemapUI();
        return true;
      }
      var sec = mkEl('div', '', null);
      sec.id = 'gp-remap';
      /* Rows/hint get stable ids in this mode so a hot reload can find
         them again (the overlay mode keeps its own references instead). */
      buildRemapPanel(sec);
      rowsEl.id = 'gp-remap-rows';
      hintEl.id = 'gp-remap-hint';
      /* Sit just above the panel's Close button when it is a direct
         child of the card, else simply at the end of the card. */
      var closeBtn = document.getElementById('set-close');
      if (closeBtn && closeBtn.parentNode === card) card.insertBefore(sec, closeBtn);
      else card.appendChild(sec);
      uiMode = 'settings';
      refreshRemapUI();
      return true;
    }
    /* Settings card still missing: give the deferred DOM a few seconds,
       then fall back to our own floating button + overlay panel. */
    if (uiTries >= 300){
      var fab = mkEl('button',
        'position:fixed;left:12px;top:64px;z-index:35;padding:10px 14px;' +
        'font-size:14px;font-weight:bold;border-radius:10px;border:2px solid #444;' +
        'background:#222836;color:#fff;',
        '🎮 Buttons');
      fab.id = 'gp-remap-fab';
      fab.addEventListener('click', function(){ openRemapUI(); });
      document.body.appendChild(fab);
      overlayEl = mkEl('div',
        'position:fixed;inset:0;z-index:65;display:none;align-items:center;' +
        'justify-content:center;background:rgba(0,0,0,.78);', null);
      overlayEl.id = 'gp-remap-overlay';
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
   panel (the gear button toggles it); in overlay mode, show the overlay. */
function openRemapUI(){
  ensureRemapUI();
  if (uiMode === 'overlay' && overlayEl){
    overlayEl.style.display = 'flex';
  } else if (uiMode === 'settings'){
    if (!panelShown('settings')) clickEl('help-btn');
  }
  refreshRemapUI();
}

/* Re-render the six rows from the live mapping + capture state. Each row:
   action name | current button label | Change/Cancel button. While an
   action is capturing, its label slot shows "Press a button…" instead. */
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
          capturing ? 'Press a button…' : btnLabel(btnMap[act.id]));
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
      hintEl.textContent = (padIndex === -1)
        ? 'No controller connected — connect one (Bluetooth or USB), press any ' +
          'button on it so the game can see it, then tap Change and press the ' +
          'button you want. You can still reset to defaults now.'
        : 'Tap Change, then press the controller button you want for that ' +
          'action. Giving a button to one action takes it away from any ' +
          'other. Sticks and D-pad are fixed.';
    }
  } catch(e){}
}

/* ---------------------------------------------------------------------------
   The per-frame poll. Writes ONLY the live input objects (plus the DOM
   clicks for action/menu/back) — never any game state. While a remap
   capture is active it writes NOTHING to the game at all: it only watches
   for the assigning press (or the timeout) and keeps the edge-detection
   snapshot fresh so a still-held button cannot fire an edge afterwards.
   ------------------------------------------------------------------------- */
function snapshotButtons(gp){
  var snap = [];
  for (var i = 0; i < (gp.buttons ? gp.buttons.length : 0); i++) snap[i] = btnDown(gp, i);
  prevBtn = snap;
}

function poll(){
  /* The remap UI injects lazily (the Settings card may not exist on the
     very first frames); keep retrying until it lands. */
  if (!uiMode) ensureRemapUI();

  var gp = getPad();

  /* --- Capture mode: suppress everything, watch for the assignment. --- */
  if (capture){
    if (Date.now() > capture.deadline){
      cancelCapture();  // 10 s with no press: give up quietly
    } else if (gp){
      for (var ci = 0; ci < (gp.buttons ? gp.buttons.length : 0); ci++){
        if (btnDown(gp, ci) && !prevBtn[ci]){ finishCapture(ci); break; }
      }
    }
    /* If capture just ended (assigned or timed out), still do not write
       this frame: snapshot the buttons so held buttons produce no edge
       next frame, and let normal play resume on the following frame. */
    if (gp) snapshotButtons(gp);
    exposeStatus(isDriving());
    return;
  }

  /* No pad: if we thought one was connected, it vanished without a
     disconnect event — release everything we hold so nothing sticks. */
  if (!gp){
    if (padIndex !== -1){
      padIndex = -1; padId = '';
      clearMine();
      reportSys('ok', 'controller lost — all gamepad inputs released');
      exposeStatus();
      refreshRemapUI();
    }
    return;
  }
  padId = gp.id || padId;

  var ax = (typeof gp.axes[0] === 'number') ? gp.axes[0] : 0;  // left stick X
  var ay = (typeof gp.axes[1] === 'number') ? gp.axes[1] : 0;  // left stick Y
  /* (axes 2/3 = right stick: unmapped — see CAMERA note in the header.) */

  /* --- Left stick -> movement keys, exactly like holding WASD. ---------
     Radial deadzone first (kills idle drift), then a per-axis threshold
     so diagonals are deliberate: up+right holds 'w'+'d' together and the
     game's own movement code sums them, same as two keys at once. */
  var want = { w: false, a: false, s: false, d: false };
  if (Math.hypot(ax, ay) >= DEADZONE){
    if (ay <= -AXIS_ON) want.w = true;   // stick up
    if (ay >=  AXIS_ON) want.s = true;   // stick down
    if (ax <= -AXIS_ON) want.a = true;   // stick left
    if (ax >=  AXIS_ON) want.d = true;   // stick right
  }
  var moveKeys = ['w', 'a', 's', 'd'], i, k;
  for (i = 0; i < moveKeys.length; i++){
    k = moveKeys[i];
    if (want[k]) holdKey(k); else releaseKey(k);
  }

  /* --- Vehicle pedals / steering, driving only. ------------------------
     Pedals read through the REMAP TABLE (gas/brake/handbrake indices);
     the analog check works for triggers (value rises past 0.35) and for
     digital buttons alike (a pressed digital button reads value 1).
     The D-pad stays fixed. When not driving, `dwant` stays all-false,
     which releases any drive fields we were holding (e.g. Joshua stepped
     out mid-press). */
  var driving = isDriving();
  var dwant = { gas: false, brake: false, hb: false, left: false, right: false };
  if (driving){
    if (mapBtnVal(gp, btnMap.gas) > TRIGGER_ON) dwant.gas = true;
    if (mapBtnVal(gp, btnMap.brake) > TRIGGER_ON) dwant.brake = true;
    if (mapBtnDown(gp, btnMap.handbrake)) dwant.hb = true;
    if (btnDown(gp, 14) || ax <= -STEER_ON) dwant.left = true;   // d-pad L / stick X
    if (btnDown(gp, 15) || ax >= STEER_ON) dwant.right = true;   // d-pad R / stick X
    if (btnDown(gp, 12)) dwant.gas = true;                   // d-pad up = gas
    if (btnDown(gp, 13)) dwant.brake = true;                 // d-pad down = brake
  }
  var driveFields = ['gas', 'brake', 'hb', 'left', 'right'];
  for (i = 0; i < driveFields.length; i++){
    k = driveFields[i];
    if (dwant[k]) holdDrive(k); else releaseDrive(k);
  }

  /* --- ACTION (remappable): Joshua's universal action button. ----------
     Mirrors the game's 'e' key: keys['e'] is held while the assigned
     button is held, and the on-screen action button is clicked once per
     press (edge), which is what the keydown handler does (it ignores
     auto-repeat). Unassigned (null) = the action does nothing. */
  if (mapBtnDown(gp, btnMap.action)) holdKey('e'); else releaseKey('e');
  if (mapBtnEdge(gp, btnMap.action)) clickActionBtn();

  /* --- Settings (remappable): the gear button toggles #settings. ------ */
  if (mapBtnEdge(gp, btnMap.settings)) clickEl('help-btn');

  /* --- Back (remappable): close whichever panel is on top. ------------ */
  if (mapBtnEdge(gp, btnMap.back)){
    if (panelShown('help')) clickEl('help-close');
    else if (panelShown('settings')) clickEl('set-close');
    else if (panelShown('fullmap')) clickEl('fullmap-close');
  }

  /* Snapshot button states for next frame's edge detection. */
  snapshotButtons(gp);

  exposeStatus(driving);
}

/* ---------------------------------------------------------------------------
   Connect / disconnect events. Connect is reported so Joshua can see in
   the Report panel that the controller registered; disconnect releases
   everything we hold (nothing may stick when the pad goes away) and
   cancels any in-progress remap capture.
   ------------------------------------------------------------------------- */
if (typeof window !== 'undefined' && window.addEventListener){
  window.addEventListener('gamepadconnected', function(e){
    try {
      padIndex = e.gamepad.index;
      padId = e.gamepad.id || '';
      prevBtn = [];
      reportSys('ok', 'controller connected: ' + String(padId).slice(0, 48) + customSuffix());
      exposeStatus();
      refreshRemapUI();
    } catch(err){}
  });
  window.addEventListener('gamepaddisconnected', function(e){
    try {
      if (e.gamepad.index === padIndex || padIndex === -1){
        padIndex = -1; padId = '';
        cancelCapture();
        clearMine();
        reportSys('ok', 'controller disconnected — all gamepad inputs released');
        exposeStatus();
        refreshRemapUI();
      }
    } catch(err){}
  });
}

/* ---------------------------------------------------------------------------
   Boot: announce ourselves, inject the remap UI (best effort — the poll
   keeps retrying until it lands), then poll once per animation frame
   (falling back to a 50 ms interval where requestAnimationFrame is
   unavailable). The poll is a no-op until a gamepad is connected, so this
   costs nothing for touch/keyboard players.
   ------------------------------------------------------------------------- */
var supported = false;
try { supported = (typeof navigator !== 'undefined' && !!navigator.getGamepads); }
catch(e){ supported = false; }

if (!supported){
  reportSys('unsupported', 'Gamepad API not available in this browser/WebView — controller support inactive');
} else {
  reportSys('ok', 'controller support live — connect a Bluetooth/USB gamepad and press any button' + customSuffix());
  exposeStatus();
  ensureRemapUI();
  var loop = function(){
    poll();
    window.requestAnimationFrame(loop);
  };
  if (typeof window !== 'undefined' && window.requestAnimationFrame){
    window.requestAnimationFrame(loop);
  } else if (typeof window !== 'undefined'){
    window.setInterval(poll, 50);
  }
}

})();
