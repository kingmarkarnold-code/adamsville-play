/* ============================================================================
   MOVABLE HUD CONTROLS v1.0 — the player arranges the controls for
   THEIR screen (Joshua 2026-10-17, live-testing the web player on his
   phone: "The web player has the UI control overlapping, making it
   unable to drive in web mobile — allow the user to be able to move
   the controls on the main UI for the game so they can position them
   for their screen").

   THE DESIGN IN ONE PARAGRAPH:
   ui_layout.json (edited in the UI Editor) stays the source of the
   DESIGNED layout — the defaults every fresh install starts from.
   This module is the player's own adjustment layer ON TOP of it: in
   "move mode" the gameplay controls get dashed outlines and can be
   dragged (touch or mouse) anywhere on screen; where the player
   drops one is saved per layout face (mobile / desktop) in
   localStorage and re-applied at every launch, after the designed
   layout lands. A Reset restores the designed positions for the
   current face. Because the overrides live only on the device,
   they survive the game's UI auto-update channel untouched — an
   update can improve the designed defaults without ever moving a
   control the player placed by hand.

   HOW POSITIONS COMPOSE (the choice, and why):
   An override stores the element's visual top-left corner as
   FRACTIONS of the viewport ({fx, fy} — left = fx * viewport width).
   Fractions were picked over canonical layout pixels because the
   designed layout's anchor math hugs screen edges non-uniformly
   (top-left elements scale from the left, bottom-right ones from
   the right), so a canonical offset means different screen spots
   on different aspect ratios. A fraction means "this share of the
   way across MY screen" on any screen, and it survives rotation
   and resize. Overrides are applied with inline !important style
   priority, because they must beat two things that are themselves
   strong: the layout pass's inline styles AND the mobile media
   queries in index.html that pin controls with stylesheet
   !important rules (those hardcoded pins are exactly the overlap
   Joshua hit). Sizes are NOT overridden — the designed size stays;
   only the position is the player's.

   MOVE MODE:
     * Entered from Settings ("Move controls") or from the PAUSED
       overlay ("Move controls"). Entering AUTO-PAUSES via
       GamePause (a drag must never drive the car), closes the
       settings panel, and hides the PAUSED card while arranging.
       Exiting with Done restores the pause state the player came
       from (from pause: still paused; from settings: back to play).
     * While active, controls that are normally hidden until needed
       (pedals, the ACTION button, the stick) are force-shown so
       they can be placed before they're needed; their previous
       visibility is restored exactly on exit. All clicks/taps on a
       draggable are swallowed (capture phase), so dragging can
       never fire the control's real action — the gas pedal
       included (its handler lives on pointerdown, which the
       capture-phase drag handler intercepts first).
     * The walk stick is a PAIR: #joy-base is the drag target and
       #joy-knob follows it by the same delta (they are saved
       together). In play the stick materialises under the thumb,
       so the pair's saved spot is its resting frame. The knob has
       pointer-events:none by design and is never a target itself.
     * Text inputs are NEVER draggable (typing is sacred — the
       zone-unlock password box can never end up in this set; the
       set below is a fixed allow-list of HUD element ids).
     * Escape exits move mode (capture phase, so the pause system
       never sees it and doesn't unpause by accident).

   NOT DRAGGABLE, AND WHY:
     gas-bar (rides inside #dmg-wrap — the cluster moves as one),
     satview-btn / gps-nav-btn (full-map overlay controls, not the
     gameplay HUD), radio (hidden-by-design panel), toast and
     npc-dialog (transient sheets), rec-ind (status indicator),
     adm-sendreports (a settings row, not a HUD control), and the
     look area — on touch it is the right side of the game canvas
     itself, not an element, so there is nothing to grab; the
     camera button (cam-btn) IS draggable.

   DEPENDENCIES: none at load beyond the DOM. GamePause,
   UILayoutApply and Report are all typeof/try guarded in the
   sim_core.js pattern, so load order can never throw.
   ============================================================================ */
(function hudMove(){
'use strict';

/* ---------------------------------------------------------------------------
   Storage — localStorage, per face. Shape:
     { mobile: { "<element-id>": {fx: 0.0-1, fy: 0.0-1}, ... },
       desktop: { ... } }
   fx/fy = the element's visual top-left corner as fractions of the
   viewport at drop time (see the header for why fractions).
   --------------------------------------------------------------------------- */
var STORE_KEY = 'sa.hud.overrides.v1';

function emptyStore(){ return { mobile: {}, desktop: {} }; }

function loadStore(){
  try {
    var raw = null;
    if (window.localStorage) raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return emptyStore();
    var s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return emptyStore();
    if (!s.mobile || typeof s.mobile !== 'object') s.mobile = {};
    if (!s.desktop || typeof s.desktop !== 'object') s.desktop = {};
    return s;
  } catch (e) { return emptyStore(); }
}

var store = loadStore();

function saveStore(){
  try {
    if (window.localStorage) window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (e) { /* private mode / quota — the session keeps the in-memory copy */ }
}

/* ---------------------------------------------------------------------------
   The draggable set. APPLY_IDS get positions from overrides;
   TARGET_IDS can be grabbed (joy-knob follows joy-base instead of
   being grabbed). Names are what the floating tag shows mid-drag.
   --------------------------------------------------------------------------- */
var NAMES = {
  'hud-title': 'Title', 'hud-sub': 'Subtitle',
  'help-btn': 'Settings gear', 'pause-btn': 'Pause button',
  'music-btn': 'Music button', 'street-name': 'Street name',
  'ver-tag': 'Version tag', 'inv-btn': 'Inventory button',
  'action-btn': 'Action button', 'minimap': 'Minimap',
  'mode-tag': 'Mode tag', 'speedo': 'Speedometer',
  'dmg-wrap': 'Damage + gas', 'joy-base': 'Walk stick',
  'joy-knob': 'Walk stick knob',
  'steer-left': 'Steer left', 'steer-right': 'Steer right',
  'gas-btn': 'Gas pedal', 'brake-btn': 'Brake pedal',
  'handbrake-btn': 'Handbrake', 'cam-btn': 'Camera button'
};
var APPLY_IDS = Object.keys(NAMES);
var TARGET_IDS = APPLY_IDS.filter(function (id) { return id !== 'joy-knob'; });

/* Element ids this module has given inline !important positions to,
   so Reset knows exactly what to strip. */
var importantSet = {};

/* ---------------------------------------------------------------------------
   Small helpers
   --------------------------------------------------------------------------- */
/* Clamp a proposed top-left so the element stays fully on screen. */
function clampPos(left, top, w, h, vw, vh){
  var maxL = Math.max(0, vw - (w || 0));
  var maxT = Math.max(0, vh - (h || 0));
  return {
    left: Math.min(Math.max(0, left), maxL),
    top: Math.min(Math.max(0, top), maxT)
  };
}

/* Mirror of ui_layout_apply.js's viewport heuristic — which layout
   face this screen is showing. (Kept in step deliberately: the
   override face must match the layout face, always.) */
function isMobileViewport(){
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
    if (Math.min(window.innerWidth, window.innerHeight) < 600) return true;
  } catch (e) { /* ignore — default to desktop */ }
  return false;
}

/* The face the layout pass most recently applied (it tells us via
   onLayoutApplied); before the first pass, guess from the screen. */
var lastFace = null;
function currentFace(){
  if (lastFace) return lastFace;
  return isMobileViewport() ? 'mobile' : 'desktop';
}

function round4(n){ return Math.round(n * 10000) / 10000; }

/* ---------------------------------------------------------------------------
   Applying overrides — called by ui_layout_apply.js after EVERY
   designed-layout pass (startup, resize, hot-reload), so the
   player's positions always land on top of the current design.
   --------------------------------------------------------------------------- */
function applyOverride(el, id, face, vw, vh){
  if (!el || !id) return false;
  var ov = store[face] && store[face][id];
  if (!ov || typeof ov.fx !== 'number' || typeof ov.fy !== 'number') return false;
  var w = 0, h = 0;
  try { w = el.offsetWidth || 0; h = el.offsetHeight || 0; } catch (e) {}
  var want = clampPos(ov.fx * vw, ov.fy * vh, w, h, vw, vh);
  el.style.setProperty('left', want.left + 'px', 'important');
  el.style.setProperty('top', want.top + 'px', 'important');
  el.style.setProperty('right', 'auto', 'important');
  el.style.setProperty('bottom', 'auto', 'important');
  importantSet[id] = true;
  /* Transform compensation: a few HUD elements centre themselves
     with translateX(-50%) (e.g. #ver-tag on mobile), so the style
     left is NOT the visual left the player saved. Measure the
     visual corner once and correct, so the saved spot is the spot
     they see. A hidden element measures all-zero and is skipped
     (the next layout pass while it's visible corrects it). */
  try {
    var r = el.getBoundingClientRect();
    if (r && (r.width || r.height)){
      var dx = want.left - r.left, dy = want.top - r.top;
      if (dx || dy){
        el.style.setProperty('left', (want.left + dx) + 'px', 'important');
        el.style.setProperty('top', (want.top + dy) + 'px', 'important');
      }
    }
  } catch (e) {}
  return true;
}

function onLayoutApplied(mobile){
  var face = mobile ? 'mobile' : 'desktop';
  lastFace = face;
  var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
  if (!vw || !vh || !document.getElementById) return;
  for (var i = 0; i < APPLY_IDS.length; i++){
    var el = document.getElementById(APPLY_IDS[i]);
    if (el) applyOverride(el, APPLY_IDS[i], face, vw, vh);
  }
}

/* ---------------------------------------------------------------------------
   Move mode
   --------------------------------------------------------------------------- */
var inMove = false;
var wasPausedOnEntry = false;
var ovPrevVisibility = '';
var forcedShown = [];   /* elements force-shown for arranging */
var drag = null;        /* the live drag, or null */

function naturalDisplay(el){
  var tag = (el.tagName || '').toUpperCase();
  if (tag === 'BUTTON') return 'inline-block';
  return 'block'; /* divs + the minimap canvas */
}

function showTag(){
  var tag = document.getElementById('hud-move-tag');
  if (!tag || !drag) return;
  tag.textContent = NAMES[drag.id] || drag.id;
  tag.classList.add('show');
  positionTag();
}
function positionTag(){
  var tag = document.getElementById('hud-move-tag');
  if (!tag || !drag) return;
  try {
    var r = drag.el.getBoundingClientRect();
    /* Above the control when there's room, below it otherwise. */
    var top = r.top - 34;
    if (top < 4) top = r.bottom + 6;
    tag.style.left = Math.max(4, Math.min(r.left, (window.innerWidth || 0) - 90)) + 'px';
    tag.style.top = top + 'px';
  } catch (e) {}
}
function hideTag(){
  var tag = document.getElementById('hud-move-tag');
  if (tag) tag.classList.remove('show');
}

function enterMoveMode(){
  if (inMove) return;
  inMove = true;
  /* Auto-pause: arranging must never drive the car. Remember the
     state we came from so Done can restore it exactly. */
  wasPausedOnEntry = false;
  try {
    if (window.GamePause && GamePause.isPaused) wasPausedOnEntry = !!GamePause.isPaused();
    if (!wasPausedOnEntry && window.GamePause && GamePause.setPaused) GamePause.setPaused(true);
  } catch (e) {}
  /* If we came from Settings, close it — the panel would cover
     the controls being arranged. */
  try {
    var st = document.getElementById('settings');
    if (st && st.classList) st.classList.remove('show');
  } catch (e) {}
  /* Hide the PAUSED card while arranging (restored on exit). Game
     stays paused either way — only the card gets out of the way. */
  try {
    var ov = document.getElementById('pause-overlay');
    if (ov){ ovPrevVisibility = ov.style.visibility || ''; ov.style.visibility = 'hidden'; }
  } catch (e) {}
  try { document.body.classList.add('hud-move-mode'); } catch (e) {}
  /* Mark the controls, wake the hidden ones, and make every one of
     them grabbable (some are pointer-events:none in play — the
     stick pair above all — which is exactly backwards here). */
  forcedShown = [];
  for (var i = 0; i < APPLY_IDS.length; i++){
    var el = document.getElementById(APPLY_IDS[i]);
    if (!el) continue;
    if (TARGET_IDS.indexOf(el.id) !== -1) el.setAttribute('data-hud-drag', '1');
    el.__hudPrevTouchAction = el.style.touchAction || '';
    el.style.touchAction = 'none';
    el.__hudPrevPointerEvents = el.style.pointerEvents || '';
    el.style.pointerEvents = 'auto';
    var hidden = false;
    try {
      var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
      hidden = !!cs && cs.display === 'none';
    } catch (e) {}
    if (hidden){
      forcedShown.push(el);
      el.style.setProperty('display', naturalDisplay(el), 'important');
    }
  }
  var bar = document.getElementById('hud-move-bar');
  if (bar) bar.classList.add('show');
  try {
    if (window.Report && Report.note) Report.note('hudmove', {event: 'enter', face: currentFace()});
  } catch (e) {}
}

function exitMoveMode(){
  if (!inMove) return;
  inMove = false;
  drag = null;
  hideTag();
  try { document.body.classList.remove('hud-move-mode'); } catch (e) {}
  for (var i = 0; i < APPLY_IDS.length; i++){
    var el = document.getElementById(APPLY_IDS[i]);
    if (!el) continue;
    el.removeAttribute('data-hud-drag');
    el.style.touchAction = el.__hudPrevTouchAction || '';
    el.style.pointerEvents = el.__hudPrevPointerEvents || '';
    delete el.__hudPrevTouchAction;
    delete el.__hudPrevPointerEvents;
  }
  /* Un-show exactly the elements move mode force-showed; the game
     re-shows them itself when they're next needed. */
  for (var j = 0; j < forcedShown.length; j++){
    try { forcedShown[j].style.removeProperty('display'); } catch (e) {}
  }
  forcedShown = [];
  try {
    var ov = document.getElementById('pause-overlay');
    if (ov) ov.style.visibility = ovPrevVisibility;
  } catch (e) {}
  ovPrevVisibility = '';
  var bar = document.getElementById('hud-move-bar');
  if (bar) bar.classList.remove('show');
  /* Restore the pause state the player came from. */
  try {
    if (window.GamePause && GamePause.setPaused) GamePause.setPaused(wasPausedOnEntry);
  } catch (e) {}
  /* Settle: one layout pass so designed positions + the overrides
     saved during arranging compose through the one choke point,
     and so elements are immediately usable in their final spots. */
  try {
    if (window.UILayoutApply && UILayoutApply.apply) UILayoutApply.apply();
  } catch (e) {}
}

/* Reset — the ACTIVE FACE ONLY goes back to the designed layout.
   The other face keeps the player's arrangement untouched. */
function resetFace(){
  var face = currentFace();
  store[face] = {};
  saveStore();
  /* Strip this module's !important position props so the designed
     layout (and the media queries) own the controls again... */
  for (var i = 0; i < APPLY_IDS.length; i++){
    var id = APPLY_IDS[i];
    if (!importantSet[id]) continue;
    var el = document.getElementById(id);
    if (el){
      el.style.removeProperty('left');
      el.style.removeProperty('top');
      el.style.removeProperty('right');
      el.style.removeProperty('bottom');
    }
    importantSet[id] = false;
  }
  /* ...then re-run the layout pass to put the designed positions
     back on (the pass finds no overrides for this face now). */
  try {
    if (window.UILayoutApply && UILayoutApply.apply) UILayoutApply.apply();
  } catch (e) {}
  try {
    if (window.Report && Report.note) Report.note('hudmove', {event: 'reset', face: face});
  } catch (e) {}
}

/* ---------------------------------------------------------------------------
   Dragging — Pointer Events (touch + mouse through one path).
   All listeners are document-level CAPTURE phase and only act in
   move mode: capture + stopPropagation is what guarantees a drag
   can never fire the control's own action (the pedals act on
   pointerdown itself; ordinary buttons on click — both swallowed).
   --------------------------------------------------------------------------- */
function dragTargetOf(e){
  try {
    var t = e && e.target;
    if (t && t.closest) return t.closest('[data-hud-drag]');
  } catch (err) {}
  return null;
}

function moveDragged(d, dx, dy, vw, vh){
  var p = clampPos(d.left + dx, d.top + dy, d.w, d.h, vw, vh);
  d.el.style.setProperty('left', p.left + 'px', 'important');
  d.el.style.setProperty('top', p.top + 'px', 'important');
  d.el.style.setProperty('right', 'auto', 'important');
  d.el.style.setProperty('bottom', 'auto', 'important');
  d.curLeft = p.left;
  d.curTop = p.top;
}

function onPointerDown(e){
  if (!inMove) return;
  var t = dragTargetOf(e);
  if (!t) return; /* the Done/Reset bar and everything else still work */
  e.preventDefault();
  e.stopPropagation();
  var r = t.getBoundingClientRect();
  drag = {
    id: t.id, el: t, pid: e.pointerId,
    sx: e.clientX, sy: e.clientY,
    left: r.left, top: r.top, w: r.width, h: r.height,
    curLeft: r.left, curTop: r.top,
    prevZ: t.style.zIndex || '', knob: null
  };
  t.style.zIndex = '70'; /* the control being placed rides on top */
  try { t.setPointerCapture(e.pointerId); } catch (err) {}
  /* The stick knob follows its base — grab the pair's other half. */
  if (t.id === 'joy-base'){
    var k = document.getElementById('joy-knob');
    if (k){
      var kr = k.getBoundingClientRect();
      drag.knob = { id: 'joy-knob', el: k, left: kr.left, top: kr.top,
                    w: kr.width, h: kr.height, curLeft: kr.left, curTop: kr.top };
    }
  }
  showTag();
}

function onPointerMove(e){
  if (!inMove || !drag || e.pointerId !== drag.pid) return;
  e.preventDefault();
  var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
  var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  moveDragged(drag, dx, dy, vw, vh);
  if (drag.knob) moveDragged(drag.knob, dx, dy, vw, vh);
  positionTag();
}

function endDrag(e){
  if (!drag || (e && e.pointerId !== drag.pid)) return;
  var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
  var face = currentFace();
  /* Save as viewport fractions of the VISUAL corner — the spot
     the player actually sees the control in. */
  store[face][drag.id] = {
    fx: round4((drag.curLeft != null ? drag.curLeft : drag.left) / vw),
    fy: round4((drag.curTop != null ? drag.curTop : drag.top) / vh)
  };
  importantSet[drag.id] = true;
  if (drag.knob){
    store[face][drag.knob.id] = {
      fx: round4(drag.knob.curLeft / vw),
      fy: round4(drag.knob.curTop / vh)
    };
    importantSet[drag.knob.id] = true;
  }
  saveStore();
  try { drag.el.style.zIndex = drag.prevZ; } catch (err) {}
  drag = null;
  hideTag();
}

/* Any click that lands on a draggable while arranging is a drag
   that didn't move — swallow it so the control never fires. */
function onClickCapture(e){
  if (!inMove) return;
  if (dragTargetOf(e)){
    e.preventDefault();
    e.stopPropagation();
  }
}

/* Escape leaves move mode. CAPTURE phase, so pause_system.js's own
   Escape (bubble phase) never sees it and can't unpause by
   accident — Done/Escape semantics stay: we're arranging, not
   resuming. */
function onKeyDown(e){
  if (!inMove) return;
  var k = (e && e.key || '').toLowerCase();
  if (k !== 'escape' && k !== 'esc') return;
  e.preventDefault();
  e.stopPropagation();
  exitMoveMode();
}

try {
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', endDrag, true);
  document.addEventListener('pointercancel', endDrag, true);
  document.addEventListener('click', onClickCapture, true);
  window.addEventListener('keydown', onKeyDown, true);
} catch (e) { /* extremely old engine — move mode simply stays off */ }

/* ---------------------------------------------------------------------------
   Entry points — Settings row + the PAUSED overlay button, wired
   here (this module owns its buttons, like pause_system.js does).
   --------------------------------------------------------------------------- */
function bindClick(id, fn){
  var el = document.getElementById(id);
  if (el && !el.__hudMoveWired){
    el.__hudMoveWired = true;
    el.addEventListener('click', fn);
  }
}

function init(){
  bindClick('set-movecontrols', function(){ enterMoveMode(); });
  bindClick('pause-move', function(){ enterMoveMode(); });
  bindClick('hud-move-done', function(){ exitMoveMode(); });
  bindClick('hud-move-reset', function(){ resetFace(); });
  /* Scripts load in deferred-queue order (this module right after
     ui_layout_apply.js), but the layout's fetch may have resolved
     either side of us — ask for one more pass so any saved
     overrides land regardless of who won the race. */
  try {
    if (window.UILayoutApply && UILayoutApply.apply) UILayoutApply.apply();
  } catch (e) {}
  try {
    if (typeof Report !== 'undefined' && Report.setSys){
      Report.setSys('hudmove', { status: 'ok', version: '1.0',
        note: 'Player-movable HUD controls; per-face overrides in localStorage (Joshua 2026-10-17)' });
    }
  } catch (e) {}
}

if (document.readyState === 'loading' && document.addEventListener)
  document.addEventListener('DOMContentLoaded', init);
else init();

/* Public API. onLayoutApplied is the layout pass's hook; the rest
   is for the entry-point buttons (already wired), debugging, and
   the verification harness. */
window.HudMove = {
  onLayoutApplied: onLayoutApplied,
  applyOverride: applyOverride,
  enter: enterMoveMode,
  exit: exitMoveMode,
  reset: resetFace,
  isActive: function(){ return inMove; },
  currentFace: currentFace,
  overrides: function(){
    /* A copy — callers may inspect but not mutate the store. */
    return JSON.parse(JSON.stringify(store));
  },
  clamp: clampPos,
  TARGET_IDS: TARGET_IDS.slice(),
  APPLY_IDS: APPLY_IDS.slice()
};

})();
