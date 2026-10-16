/* ============================================================================
   GAMEPAD INPUT v2.1 — Bluetooth / USB controller support (Joshua 2026-10-16)
   v2.0 added USER-REMAPPABLE BUTTONS (Settings -> "Controller Buttons").
   v2.1 adds RIGHT-STICK CAMERA (the stick rotates the player's view via
   window.LookInput, exposed by index.html) and replaces the remap
   press-capture flow with a PER-BUTTON PICKER: every assignable button
   is listed by name, shows its action (or "None"), and tapping a row
   lets the player pick that button's action from a list.

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

   CAMERA (v2.1):
   The look state (camYaw / look.yawOff / fpLookYaw / fpPitch) lives
   inside index.html's main block. index.html exposes it through a tiny
   window.LookInput.add(dYaw, dPitch) API (placed beside the look state,
   the same window-exposure pattern as window.keys): add() applies the
   EXACT branch logic of the touch drag handler — driving -> look.yawOff,
   first-person indoors -> fpLookYaw + clamped fpPitch (including the
   v1.12.2 half-sensitivity indoors), on foot -> camYaw — so the right
   stick rotates the view precisely the way a drag does, with no
   synthetic drag events. The module feature-detects window.LookInput
   every frame: on a build without it (older index.html) the stick is
   simply unmapped and everything else works as before. The game has no
   look-sensitivity or invert setting (verified), so the stick uses the
   fixed speeds named in the Tunables below.

   OWNERSHIP RULE (never fight the physical keyboard):
   The module only ever releases a key/field that IT pressed. If a field
   was already true when the module first grabbed it (e.g. Joshua is
   holding W on a real keyboard while tapping the stick), the field is
   marked "borrowed" and the module leaves it alone on release — the real
   owner's own release clears it. On controller disconnect, everything the
   module holds is released, so nothing can stick.

   CONTROLLER MAP — six actions, assigned PER BUTTON:
   Open Settings (gear button) -> "Controller Buttons" section. The
   section lists EVERY assignable button as its own row — A, B, X, Y,
   L1, R1, L2, R2, Select, Start, Home — showing the action it currently
   performs, or the word "None". Tap a row's Set button and pick the
   action for that button from the list (Action, Gas, Brake, Handbrake,
   Settings, Back — or None to clear it). One button per action still
   holds: giving an action to a button takes it away from whichever
   button had it (that button drops to None). The mapping is saved in
   localStorage (key 'sa.gamepad.map.v1', stored action -> button) and
   survives restarts. "Reset controller buttons" restores the defaults
   below. A button set to None does nothing in play. The sticks and the
   D-pad are NOT remappable. (Home is listed like any other button and
   its assignment saves normally — but note the browser/OS commonly
   intercepts the Home button, so a press may never reach the page.)
   Defaults (standard mapping indices):
     A (0) ........ Action — Joshua's universal action button: mirrors
                    the 'e' key exactly (holds keys['e'] and clicks
                    #action-btn on the press edge when it is on screen)
     R2 (7) ....... Gas      (analog value > 0.35 while driving)
     L2 (6) ....... Brake    (analog value > 0.35 while driving)
     L1 (4) ....... Handbrake (while driving)
     Start (9) .... Settings menu (clicks the #help-btn gear, which
                    toggles the #settings panel)
     B (1) ........ Back — closes the topmost open panel (#help, then
                    #settings, then the full map)
     X (2), Y (3), R1 (5), Select (8), Home (16) ... None by default
   Fixed (not remappable):
     Left stick .......... movement (keys w/a/s/d; 8-way past threshold)
     Left stick X (driving)  steer (drive.left / drive.right)
     Right stick ......... camera: rotates the view (see CAMERA above)
     D-pad up / down ..... drive.gas / drive.brake (while driving)
     D-pad left / right .. drive.left / drive.right (while driving)

   DEPENDENCIES: none required. Loaded via the deferred data-dsrc queue
   right after sim_core.js. Runs one lightweight poll per animation frame
   and does nothing at all until a gamepad is connected. The remap UI is
   built and injected by this module at runtime: it lives in the game's
   own Settings panel when that panel is found, otherwise a floating
   "🎮 Buttons" button opens the module's own overlay panel. The right
   stick additionally uses window.LookInput when index.html provides it
   (v2.1+) and is silently unmapped when it does not.
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

/* Right-stick camera speeds: rotation rate at FULL deflection, scaled by
   the stick's actual (deadzone-rescaled) deflection each frame. 2.4 rad/s
   of yaw is a full turn in about 2.6 s — normal third-person game feel;
   pitch runs slower because the first-person pitch range is only
   +/-1.1 rad end to end. */
var LOOK_YAW_SPEED   = 2.4;  // rad/s at full right-stick X deflection
var LOOK_PITCH_SPEED = 1.8;  // rad/s at full right-stick Y deflection

/* ---------------------------------------------------------------------------
   The remappable actions and their DEFAULT standard-mapping button
   indices. This table is the ONLY place those six indices appear: the
   runtime reads the live mapping (btnMap, loaded from localStorage) for
   every one of these actions, never a hardcoded index. The sticks and
   the D-pad are fixed by design and are not part of this table. The
   picker UI works the other way around (button -> action) but derives
   everything from this same btnMap, so the two views can never disagree.
   ------------------------------------------------------------------------- */
var ACTIONS = [
  { id: 'action',    short: 'Action',    label: 'Action (interact / enter)', def: 0 },  // A
  { id: 'gas',       short: 'Gas',       label: 'Gas (driving)',             def: 7 },  // R2
  { id: 'brake',     short: 'Brake',     label: 'Brake (driving)',           def: 6 },  // L2
  { id: 'handbrake', short: 'Handbrake', label: 'Handbrake (driving)',       def: 4 },  // L1
  { id: 'settings',  short: 'Settings',  label: 'Settings menu',             def: 9 },  // Start
  { id: 'back',      short: 'Back',      label: 'Back / close panel',        def: 1 }   // B
];

/* Short display name for an action id (used by the per-button rows and
   the picker options), or null when the id is not a real action. */
function actionShort(id){
  for (var i = 0; i < ACTIONS.length; i++) if (ACTIONS[i].id === id) return ACTIONS[i].short;
  return null;
}

/* Human-readable names for standard-mapping button indices (Joshua's
   labels: L1/R1/L2/R2 for the shoulders and triggers), used by the
   remap UI so the player sees "R2" instead of "7". Anything past the
   named range falls back to "Button N". An unassigned button or action
   always displays as the word "None". */
var BTN_NAMES = {
  0: 'A', 1: 'B', 2: 'X', 3: 'Y',
  4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2',
  8: 'Select', 9: 'Start',
  10: 'L3 (stick click)', 11: 'R3 (stick click)',
  12: 'D-pad Up', 13: 'D-pad Down', 14: 'D-pad Left', 15: 'D-pad Right',
  16: 'Home', 17: 'Share'
};
function btnLabel(idx){
  if (idx === null || typeof idx === 'undefined') return 'None';  // unassigned
  return BTN_NAMES[idx] || ('Button ' + idx);
}

/* The buttons the remap section lists, in display order — every
   assignable button gets its own row (the D-pad is fixed and unlisted,
   as are the stick clicks). The rows are DERIVED from btnMap
   (action -> button) at render time: a row's action is whichever
   action currently claims that button. */
var BUTTON_ROWS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 16];

/* Which action (id) currently owns a button index, or null. */
function actionForButton(idx){
  for (var i = 0; i < ACTIONS.length; i++){
    if (btnMap[ACTIONS[i].id] === idx) return ACTIONS[i].id;
  }
  return null;
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
   the "one button, one action" rule the picker enforces. */
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

/* Picker state for the remap UI: while non-null, this is the button
   index whose action picker is open in the panel. The picker is pure
   DOM (taps/clicks) — unlike the v2.0 press-capture it needs no gamepad
   input, so the poll never has to suppress anything for it. */
var pickIdx = null;

/* Frame-timing state for the right-stick look: the timestamp of the
   previous poll (ms, from requestAnimationFrame), used to turn stick
   deflection into a per-frame rotation delta. */
var lastPollTs = 0;

/* ---------------------------------------------------------------------------
   Public API — window.GamepadInput. The status fields (connected, index,
   id, driving, picking) are refreshed by the poll; the functions let the
   player (or a future UI) read/change the mapping programmatically.
   getMapping returns a copy; setMapping validates like the loader does
   and applies the same "one button, one action" steal rule;
   setButtonAction assigns a single button (the picker's twin);
   resetMapping restores the defaults; openRemapUI shows the remap
   panel. Every change is saved to localStorage immediately.
   ------------------------------------------------------------------------- */
var api = {
  connected: false,
  index: -1,
  id: '',
  driving: false,
  picking: null,
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
    pickIdx = null;
    for (var i = 0; i < ACTIONS.length; i++) btnMap[ACTIONS[i].id] = ACTIONS[i].def;
    saveMap();
    refreshRemapUI();
    reportSys('ok', 'controller buttons reset to defaults');
    return mappingCopy();
  },
  /* Per-button assignment, the programmatic twin of the picker:
     setButtonAction(buttonIndex, actionIdOrNull). Giving an action to
     this button takes it away from whichever button had it; passing
     null (or an unknown action id) clears the button instead. */
  setButtonAction: function(idx, actionId){
    if (!validBtn(idx)) return mappingCopy();
    chooseButtonAction(idx, actionId);
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
  api.picking = pickIdx;
}

/* ---------------------------------------------------------------------------
   Reporting — same pattern sim_core.js uses: tell Joshua's in-game Report
   panel the module is alive and when a controller connects/disconnects.
   ------------------------------------------------------------------------- */
function reportSys(status, note){
  try{
    if (typeof Report !== 'undefined' && Report.setSys)
      Report.setSys('gamepad', {status: status, version: '2.1', note: note});
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
/* The look API index.html exposes for the right stick (v2.1), or null on
   builds without it. Fetched fresh each poll like the other live
   objects, so a hot reload swapping either side can never strand us. */
function lookInput(){
  try {
    var li = (typeof window !== 'undefined') ? window.LookInput : null;
    return (li && typeof li.add === 'function') ? li : null;
  } catch(e){ return null; }
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

/* Release everything this module holds (disconnect / pad lost).
   Iterates over a snapshot of names because release* mutates the
   books. */
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
   Assignment logic (per-button picker).
   assignBtn is the single writer of the live table used by the picker,
   setButtonAction and setMapping: it applies the steal rule — if the
   button already belongs to another action, that action becomes
   unassigned (last assignment wins) — so the table can never hold a
   duplicate index. (It deliberately does NOT save or refresh; callers
   do, so setMapping can batch several assignments into one save.)
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

/* The picker chose an action (or None) for one button: apply it with
   the steal rule, save immediately, close the picker, refresh the
   panel, and note it in the Report panel. actionId null clears the
   button (its action, if any, becomes unassigned); an unknown action
   id is ignored but still closes the picker. */
function chooseButtonAction(idx, actionId){
  pickIdx = null;
  if (actionId !== null && !actionShort(actionId)) actionId = null;
  if (actionId === null){
    var cur = actionForButton(idx);
    if (cur !== null) btnMap[cur] = null;
  } else {
    assignBtn(actionId, idx);
  }
  saveMap();
  refreshRemapUI();
  exposeStatus();
  reportSys('ok', 'controller: ' + btnLabel(idx) + ' -> ' +
    (actionId === null ? 'None' : actionShort(actionId)) + customSuffix());
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
var rowsEl = null;      // container the button rows / picker render into
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

/* Re-render the remap section from the live mapping. Two views:
   - Button list (default): one row per assignable button — the button's
     name (Joshua's labels), the action it currently performs (or
     "None"), and a Set button.
   - Picker (while pickIdx is set): a title naming the button, one
     option per action plus "None" (clear), and a Cancel option.
     Picking an option assigns it via chooseButtonAction and returns
     to the list; Cancel just returns. */
function refreshRemapUI(){
  if (!rowsEl) return;
  try {
    rowsEl.textContent = '';  // clear previous render (drops its children)
    var i, j;
    if (pickIdx !== null){
      var title = mkEl('div',
        'color:#fff;font-weight:bold;font-size:14px;margin:8px 0;',
        'Button ' + btnLabel(pickIdx) + ' does…');
      rowsEl.appendChild(title);
      var opts = [];
      for (i = 0; i < ACTIONS.length; i++) opts.push(ACTIONS[i].id);
      opts.push(null);  // the "None" (clear) option, always last
      for (j = 0; j < opts.length; j++){
        (function(opt){
          var b = mkEl('button',
            'display:block;width:100%;margin:6px 0;padding:10px 14px;font-size:14px;' +
            'font-weight:bold;border-radius:10px;border:2px solid #444;' +
            'background:#222836;color:#fff;text-align:left;box-sizing:border-box;',
            opt === null ? 'None' : actionShort(opt));
          b.addEventListener('click', function(){ chooseButtonAction(pickIdx, opt); });
          rowsEl.appendChild(b);
        })(opts[j]);
      }
      var cancel = mkEl('button',
        'display:block;width:100%;margin:6px 0;padding:10px 14px;font-size:14px;' +
        'border-radius:10px;border:2px solid #555;background:#2d3547;color:#fff;' +
        'text-align:left;box-sizing:border-box;',
        'Cancel');
      cancel.addEventListener('click', function(){
        pickIdx = null;
        refreshRemapUI();
        exposeStatus();
      });
      rowsEl.appendChild(cancel);
    } else {
      for (i = 0; i < BUTTON_ROWS.length; i++){
        (function(bidx){
          var act = actionForButton(bidx);
          var row = mkEl('div',
            'display:flex;align-items:center;gap:8px;background:#222836;' +
            'border:2px solid #444;border-radius:10px;padding:8px 10px;margin:8px 0;' +
            'box-sizing:border-box;', null);
          var name = mkEl('span',
            'flex:1;color:#fff;font-weight:bold;font-size:14px;', btnLabel(bidx));
          var cur = mkEl('span',
            'color:#ffd75e;font-weight:bold;font-size:14px;min-width:44px;text-align:right;',
            act === null ? 'None' : actionShort(act));
          var btn = mkEl('button',
            'padding:8px 12px;border-radius:8px;border:2px solid #555;' +
            'background:#2d3547;color:#fff;font-weight:bold;font-size:13px;',
            'Set');
          btn.addEventListener('click', function(){
            pickIdx = bidx;
            refreshRemapUI();
            exposeStatus();
          });
          row.appendChild(name);
          row.appendChild(cur);
          row.appendChild(btn);
          rowsEl.appendChild(row);
        })(BUTTON_ROWS[i]);
      }
    }
    if (hintEl){
      hintEl.textContent = (padIndex === -1)
        ? 'No controller connected — connect one (Bluetooth or USB) and press ' +
          'any button on it so the game can see it. You can set up the ' +
          'buttons and reset to defaults right now.'
        : 'Tap Set on a button row, then pick what that button does. Giving ' +
          'an action to a button takes it away from any other button. ' +
          'Sticks and D-pad are fixed: left stick moves (and steers), ' +
          'right stick rotates the view.';
    }
  } catch(e){}
}

/* ---------------------------------------------------------------------------
   The per-frame poll. Writes ONLY the live input objects (plus the DOM
   clicks for action/menu/back, and window.LookInput deltas for the
   right stick) — never any game state. ts is the requestAnimationFrame
   timestamp (undefined on the setInterval fallback path, where the look
   delta simply assumes a 60 fps step).
   ------------------------------------------------------------------------- */
function snapshotButtons(gp){
  var snap = [];
  for (var i = 0; i < (gp.buttons ? gp.buttons.length : 0); i++) snap[i] = btnDown(gp, i);
  prevBtn = snap;
}

function poll(ts){
  /* The remap UI injects lazily (the Settings card may not exist on the
     very first frames); keep retrying until it lands. */
  if (!uiMode) ensureRemapUI();

  /* Frame delta for the right-stick look, clamped so a backgrounded tab
     or a long hitch cannot whip the camera around on the next frame. */
  var dt = 1 / 60;
  if (typeof ts === 'number' && isFinite(ts)){
    if (lastPollTs > 0){
      dt = (ts - lastPollTs) / 1000;
      if (dt < 0) dt = 0;
      if (dt > 0.1) dt = 0.1;
    }
    lastPollTs = ts;
  }

  var gp = getPad();

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
  var rx = (typeof gp.axes[2] === 'number') ? gp.axes[2] : 0;  // right stick X
  var ry = (typeof gp.axes[3] === 'number') ? gp.axes[3] : 0;  // right stick Y

  /* --- Right stick -> camera (v2.1): rotate the player's view. --------
     Radial deadzone first (kills idle drift); the remaining travel is
     rescaled so full deflection still reaches full speed. The deltas
     handed to window.LookInput.add() are DRAG-EQUIVALENT radians: add()
     applies the drag handler's own branch logic and subtraction
     convention, so pushing right looks right exactly like dragging
     right, and pushing down pitches the first-person view down. add()
     is called ONLY while the stick is deflected — centered means zero
     calls, so the camera can never creep — and disconnecting
     mid-deflection stops the calls with the polls themselves (deltas
     hold no state, so there is nothing to release). */
  var lookAPI = lookInput();
  if (lookAPI){
    var rmag = Math.hypot(rx, ry);
    if (rmag >= DEADZONE){
      var rscale = (rmag - DEADZONE) / (1 - DEADZONE);
      if (rscale > 1) rscale = 1;
      var dYaw = (rx / rmag) * rscale * LOOK_YAW_SPEED * dt;
      var dPitch = (ry / rmag) * rscale * LOOK_PITCH_SPEED * dt;
      try { lookAPI.add(dYaw, dPitch); } catch(e){}
    }
  }

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
   everything we hold (nothing may stick when the pad goes away). The
   right stick needs no disconnect handling: its deltas are stateless.
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
  var loop = function(ts){
    poll(ts);
    window.requestAnimationFrame(loop);
  };
  if (typeof window !== 'undefined' && window.requestAnimationFrame){
    window.requestAnimationFrame(loop);
  } else if (typeof window !== 'undefined'){
    window.setInterval(poll, 50);
  }
}

})();
