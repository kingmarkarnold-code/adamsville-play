/* ============================================================================
   GAMEPAD INPUT v1.0 — Bluetooth / USB controller support (Joshua 2026-10-16)

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
   intentionally unmapped in v1.0 rather than faking drag events.

   OWNERSHIP RULE (never fight the physical keyboard):
   The module only ever releases a key/field that IT pressed. If a field
   was already true when the module first grabbed it (e.g. Joshua is
   holding W on a real keyboard while tapping the stick), the field is
   marked "borrowed" and the module leaves it alone on release — the real
   owner's own release clears it. On controller disconnect, everything the
   module holds is released, so nothing can stick.

   CONTROLLER MAP (standard mapping):
     Left stick .......... movement (keys w/a/s/d; 8-way past threshold)
     Left stick X (driving)  steer (drive.left / drive.right)
     RT (button 7) ....... drive.gas      (analog value > 0.35)
     LT (button 6) ....... drive.brake    (analog value > 0.35)
     LB (button 4) ....... drive.hb       (handbrake)
     D-pad up / down ..... drive.gas / drive.brake (while driving)
     D-pad left / right .. drive.left / drive.right (while driving)
     A (button 0) ........ ACTION — Joshua's universal action button:
                           mirrors the 'e' key exactly (holds keys['e']
                           and clicks #action-btn on the press edge when
                           the button is on screen)
     Start (button 9) .... settings menu (clicks the #help-btn gear,
                           which toggles the #settings panel)
     B (button 1) ........ back — closes the topmost open panel
                           (#help, then #settings, then the full map)
     Right stick / X / Y . unmapped (see CAMERA note above)

   DEPENDENCIES: none. Loaded via the deferred data-dsrc queue right after
   sim_core.js. Runs one lightweight poll per animation frame and does
   nothing at all until a gamepad is connected.
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

/* Menu/action buttons we edge-trigger, by standard-mapping index. */
var BTN_ACTION = 0;     // A
var BTN_BACK   = 1;     // B
var BTN_START  = 9;     // Start / Menu

/* ---------------------------------------------------------------------------
   Reporting — same pattern sim_core.js uses: tell Joshua's in-game Report
   panel the module is alive and when a controller connects/disconnects.
   ------------------------------------------------------------------------- */
function reportSys(status, note){
  try{
    if (typeof Report !== 'undefined' && Report.setSys)
      Report.setSys('gamepad', {status: status, version: '1.0', note: note});
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

/* Release everything this module holds (disconnect / pad lost). Iterates
   over a snapshot of names because release* mutates the books. */
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
   The per-frame poll. Writes ONLY the live input objects (plus the DOM
   clicks for action/menu/back) — never any game state.
   ------------------------------------------------------------------------- */
function poll(){
  var gp = getPad();

  /* No pad: if we thought one was connected, it vanished without a
     disconnect event — release everything we hold so nothing sticks. */
  if (!gp){
    if (padIndex !== -1){
      padIndex = -1; padId = '';
      clearMine();
      reportSys('ok', 'controller lost — all gamepad inputs released');
      exposeStatus();
    }
    return;
  }
  padId = gp.id || padId;

  var ax = (typeof gp.axes[0] === 'number') ? gp.axes[0] : 0;  // left stick X
  var ay = (typeof gp.axes[1] === 'number') ? gp.axes[1] : 0;  // left stick Y
  /* (axes 2/3 = right stick: unmapped in v1.0 — see CAMERA note in header.) */

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
     When not driving, `dwant` stays all-false, which releases any drive
     fields we were holding (e.g. Joshua stepped out mid-press). */
  var driving = isDriving();
  var dwant = { gas: false, brake: false, hb: false, left: false, right: false };
  if (driving){
    if (btnVal(gp, 7) > TRIGGER_ON) dwant.gas = true;        // RT
    if (btnVal(gp, 6) > TRIGGER_ON) dwant.brake = true;      // LT
    if (btnDown(gp, 4)) dwant.hb = true;                     // LB = handbrake
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

  /* --- A: the universal ACTION button. ----------------------------------
     Mirrors the game's 'e' key: keys['e'] is held while A is held, and
     the on-screen action button is clicked once per press (edge), which
     is what the keydown handler does (it ignores auto-repeat). */
  if (btnDown(gp, BTN_ACTION)) holdKey('e'); else releaseKey('e');
  if (btnEdge(gp, BTN_ACTION)) clickActionBtn();

  /* --- Start: settings menu (the gear button toggles #settings). ------ */
  if (btnEdge(gp, BTN_START)) clickEl('help-btn');

  /* --- B: back — close whichever panel is on top. ---------------------- */
  if (btnEdge(gp, BTN_BACK)){
    if (panelShown('help')) clickEl('help-close');
    else if (panelShown('settings')) clickEl('set-close');
    else if (panelShown('fullmap')) clickEl('fullmap-close');
  }

  /* Snapshot button states for next frame's edge detection. */
  var snap = [];
  for (i = 0; i < (gp.buttons ? gp.buttons.length : 0); i++) snap[i] = btnDown(gp, i);
  prevBtn = snap;

  exposeStatus(driving);
}

/* Tiny public status for diagnostics / future UI: window.GamepadInput. */
function exposeStatus(driving){
  try {
    window.GamepadInput = {
      connected: padIndex !== -1,
      index: padIndex,
      id: padId,
      driving: !!driving
    };
  } catch(e){}
}

/* ---------------------------------------------------------------------------
   Connect / disconnect events. Connect is reported so Joshua can see in
   the Report panel that the controller registered; disconnect releases
   everything we hold (nothing may stick when the pad goes away).
   ------------------------------------------------------------------------- */
if (typeof window !== 'undefined' && window.addEventListener){
  window.addEventListener('gamepadconnected', function(e){
    try {
      padIndex = e.gamepad.index;
      padId = e.gamepad.id || '';
      prevBtn = [];
      reportSys('ok', 'controller connected: ' + String(padId).slice(0, 48));
      exposeStatus();
    } catch(err){}
  });
  window.addEventListener('gamepaddisconnected', function(e){
    try {
      if (e.gamepad.index === padIndex || padIndex === -1){
        padIndex = -1; padId = '';
        clearMine();
        reportSys('ok', 'controller disconnected — all gamepad inputs released');
        exposeStatus();
      }
    } catch(err){}
  });
}

/* ---------------------------------------------------------------------------
   Boot: announce ourselves, then poll once per animation frame (falling
   back to a 50 ms interval where requestAnimationFrame is unavailable).
   The poll is a no-op until a controller is connected, so this costs
   nothing for touch/keyboard players.
   ------------------------------------------------------------------------- */
var supported = false;
try { supported = (typeof navigator !== 'undefined' && !!navigator.getGamepads); }
catch(e){ supported = false; }

if (!supported){
  reportSys('unsupported', 'Gamepad API not available in this browser/WebView — controller support inactive');
} else {
  reportSys('ok', 'controller support live — connect a Bluetooth/USB gamepad and press any button');
  exposeStatus();
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
