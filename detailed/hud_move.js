/* ============================================================================
   MOVABLE HUD CONTROLS v2.0 — the player arranges the controls for
   THEIR screen (Joshua 2026-10-17, live-testing the web player on
   his phone: "The web player has the UI control overlapping, making
   it unable to drive in web mobile — allow the user to be able to
   move the controls on the main UI for the game so they can position
   them for their screen").

   v2.0 (Joshua 2026-10-17 21:39): "if some of the controls are
   unvisible or you can't see them because of the screen there's no
   way to move them, there's no way to tap on them" — plus his yield
   rule (21:42): "if I select a control that I want to move it
   should move the menu so I can move the control around the
   viewport." Three answers, all in this file:
     1. SELECT BY LIST — the move bar carries a "Select control"
        button opening a panel that lists EVERY movable control by
        name. Picking one selects it (outline + name tag); if it is
        off-screen or hidden it is BROUGHT BACK to screen centre
        first, so it can always be reached and then dragged home.
        Each row also has "Centre it" — the same bring-back as a
        one-tap rescue, without selecting.
     2. EDGE LAW — at EVERY layout pass (launch, face switch,
        resize, rotation), any movable control whose box extends
        past a screen edge is pulled back inside, override or not.
        A control can never be lost off-screen on any screen class.
     3. MENUS YIELD — picking from the list closes the list AND
        collapses the move bar to a slim edge tab in the same tap,
        leaving the whole viewport clear for dragging. The tab (one
        tap) reopens the bar for Done / Reset / Select. Expanded,
        the bar parks against the top edge as before.

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

   WHY THE v2 UI IS BUILT BY THIS FILE: the Select button, the
   collapse tab, the list panel and their styles are created at
   runtime by buildMoveUI() below instead of living in index.html,
   so the whole feature stays in one file (and one manifest entry)
   and can never be half-merged away from its behaviour.

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
   being grabbed). Names are what the floating tag shows mid-drag
   and what the Select list offers (v2).
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

function rectOf(el){
  try { return el.getBoundingClientRect(); } catch (e) { return null; }
}

/* Is this box fully inside the viewport (half-pixel tolerance for
   sub-pixel rounding at the edges)? */
function fullyInside(r, vw, vh){
  return !!r && r.left >= -0.5 && r.top >= -0.5 &&
         r.right <= vw + 0.5 && r.bottom <= vh + 0.5;
}

/* Does the element currently need rescuing? True when it has no
   measurable box (hidden / not placed) or any part of it sits
   outside the viewport. */
function needsRescue(el, vw, vh){
  var r = rectOf(el);
  if (!r || (!r.width && !r.height)) return true;
  return !fullyInside(r, vw, vh);
}

/* ---------------------------------------------------------------------------
   Placing — the one writer of !important positions. Sets left/top
   (right/bottom cleared to auto), records the id for Reset, then
   corrects for self-centring transforms: a few HUD elements centre
   themselves with translateX(-50%) (e.g. #ver-tag on mobile), so the
   style left is NOT the visual left. Measure the visual corner once
   and correct, so the placed spot is the spot the player sees. A
   hidden element measures all-zero and is skipped (the next layout
   pass while it's visible corrects it).
   --------------------------------------------------------------------------- */
function placeVisual(el, id, wantLeft, wantTop){
  el.style.setProperty('left', wantLeft + 'px', 'important');
  el.style.setProperty('top', wantTop + 'px', 'important');
  el.style.setProperty('right', 'auto', 'important');
  el.style.setProperty('bottom', 'auto', 'important');
  if (id) importantSet[id] = true;
  try {
    var r = el.getBoundingClientRect();
    if (r && (r.width || r.height)){
      var dx = wantLeft - r.left, dy = wantTop - r.top;
      if (dx || dy){
        el.style.setProperty('left', (wantLeft + dx) + 'px', 'important');
        el.style.setProperty('top', (wantTop + dy) + 'px', 'important');
      }
    }
  } catch (e) {}
}

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
  placeVisual(el, id, want.left, want.top);
  return true;
}

/* EDGE LAW (v2): an element with NO override sits wherever the
   designed layout (or a media-query pin) put it — and on a screen
   the design didn't foresee, that can be partly or wholly off the
   edge, unreachable. Whenever a layout pass lands, measure every
   movable control and pull any overflowing box back inside
   (clamped, never re-centred: as much of the intended position as
   possible is preserved). Elements the layout pass repositions get
   their fresh designed styles each pass (its plain assignments
   supersede these !important ones), so this judges the CURRENT
   design every time — resize to a smaller screen re-clamps.
   Hidden elements measure zero and are left alone: there is
   nothing to lose until they exist on screen. */
function edgeClamp(el, id, vw, vh){
  if (!el) return false;
  var r = rectOf(el);
  if (!r || (!r.width && !r.height)) return false;
  if (fullyInside(r, vw, vh)) return false;
  var p = clampPos(r.left, r.top, r.width, r.height, vw, vh);
  placeVisual(el, id, p.left, p.top);
  return true;
}

function onLayoutApplied(mobile){
  var face = mobile ? 'mobile' : 'desktop';
  lastFace = face;
  var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
  if (!vw || !vh || !document.getElementById) return;
  for (var i = 0; i < APPLY_IDS.length; i++){
    var el = document.getElementById(APPLY_IDS[i]);
    if (!el) continue;
    /* The player's own spot wins; everything else answers to the
       edge law so no designed position can strand a control. */
    if (!applyOverride(el, APPLY_IDS[i], face, vw, vh)){
      edgeClamp(el, APPLY_IDS[i], vw, vh);
    }
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

/* ---------------------------------------------------------------------------
   The name tag — one floating label, three jobs: it names the
   control being dragged (v1), and in v2 it also names the control
   the Select list picked, parked at that control until the player
   drags or picks another.
   --------------------------------------------------------------------------- */
function positionTagAt(el){
  var tag = document.getElementById('hud-move-tag');
  if (!tag || !el) return;
  try {
    var r = el.getBoundingClientRect();
    /* Above the control when there's room, below it otherwise. */
    var top = r.top - 34;
    if (top < 4) top = r.bottom + 6;
    tag.style.left = Math.max(4, Math.min(r.left, (window.innerWidth || 0) - 90)) + 'px';
    tag.style.top = top + 'px';
  } catch (e) {}
}
function showTagFor(el, name){
  var tag = document.getElementById('hud-move-tag');
  if (!tag || !el) return;
  tag.textContent = name || el.id;
  tag.classList.add('show');
  positionTagAt(el);
}
function showTag(){
  if (!drag) return;
  showTagFor(drag.el, NAMES[drag.id] || drag.id);
}
function positionTag(){
  if (drag) positionTagAt(drag.el);
}
function hideTag(){
  var tag = document.getElementById('hud-move-tag');
  if (tag) tag.classList.remove('show');
}

/* ---------------------------------------------------------------------------
   Selection (v2) — the control the player is acting on. It wears a
   solid outline (the dashed outline means "draggable"; solid means
   "this one") and keeps the name tag until another takes over.
   --------------------------------------------------------------------------- */
var selectedId = null;

function setSelected(id){
  if (selectedId === id) { if (id) { var cur = document.getElementById(id); if (cur) showTagFor(cur, NAMES[id] || id); } return; }
  if (selectedId){
    var prev = document.getElementById(selectedId);
    if (prev){
      try { prev.style.removeProperty('outline'); prev.style.removeProperty('outline-offset'); } catch (e) {}
    }
  }
  selectedId = id || null;
  if (selectedId){
    var el = document.getElementById(selectedId);
    if (el){
      try {
        el.style.setProperty('outline', '3px solid #ffd75e', 'important');
        el.style.setProperty('outline-offset', '2px', 'important');
      } catch (e) {}
      showTagFor(el, NAMES[selectedId] || selectedId);
    }
  } else {
    hideTag();
  }
}

function clearSelected(){
  setSelected(null);
}

/* ---------------------------------------------------------------------------
   Bring-back / rescue (v2) — put a control at screen centre, as a
   saved override for the active face, so it is reachable NOW and
   lands somewhere sane whenever the game shows it later. The stick
   knob rides along by the same translation as its base. Returns
   true when the control was actually moved (it needed rescuing,
   or `force` was set).
   --------------------------------------------------------------------------- */
function rescueControl(id, force){
  var el = document.getElementById(id);
  if (!el) return false;
  var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
  if (!vw || !vh) return false;
  if (!force && !needsRescue(el, vw, vh)) return false;
  var r = rectOf(el);
  var w = (r && r.width) || 0, h = (r && r.height) || 0;
  if (!w) { try { w = el.offsetWidth || 0; } catch (e) {} }
  if (!h) { try { h = el.offsetHeight || 0; } catch (e) {} }
  var p = clampPos((vw - w) / 2, (vh - h) / 2, w, h, vw, vh);
  var face = currentFace();
  var oldLeft = r ? r.left : null, oldTop = r ? r.top : null;
  store[face][id] = { fx: round4(p.left / vw), fy: round4(p.top / vh) };
  placeVisual(el, id, p.left, p.top);
  if (id === 'joy-base'){
    var k = document.getElementById('joy-knob');
    if (k){
      var kr = rectOf(k);
      var kw = (kr && kr.width) || 0, kh = (kr && kr.height) || 0;
      /* Preserve the knob's offset from the base; the pair's
         resting geometry (knob centred in the base) is the
         fallback when either rect is unmeasurable. */
      var dx = (kr && oldLeft !== null) ? (kr.left - oldLeft) : 55;
      var dy = (kr && oldTop !== null) ? (kr.top - oldTop) : 55;
      var kp = clampPos(p.left + dx, p.top + dy, kw, kh, vw, vh);
      store[face]['joy-knob'] = { fx: round4(kp.left / vw), fy: round4(kp.top / vh) };
      placeVisual(k, 'joy-knob', kp.left, kp.top);
    }
  }
  saveStore();
  return true;
}

/* Select a control BY NAME (v2): it becomes the active control; if
   it is off-screen or hidden it is brought back to centre first so
   there is always something on screen to grab. Used by the Select
   list — the list itself closes and the bar collapses (menus
   yield) before this is called, see pickFromList(). */
function selectControl(id){
  if (!inMove) return false;
  if (TARGET_IDS.indexOf(id) === -1) return false;
  var el = document.getElementById(id);
  if (!el) return false;
  rescueControl(id, false);
  setSelected(id);
  return true;
}

/* "Centre it" (v2): the bring-back on its own — an individual
   rescue that doesn't change the selection. */
function centreControl(id){
  if (!inMove) return false;
  if (TARGET_IDS.indexOf(id) === -1) return false;
  if (!document.getElementById(id)) return false;
  return rescueControl(id, true);
}

/* The Select list's data: every movable control, by friendly
   name, with a live hint about the ones in trouble. */
function selectList(){
  var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
  var out = [];
  for (var i = 0; i < TARGET_IDS.length; i++){
    var id = TARGET_IDS[i];
    var el = document.getElementById(id);
    var hint = '';
    if (!el) hint = 'not in this build';
    else if (needsRescue(el, vw, vh)){
      var r = rectOf(el);
      hint = (!r || (!r.width && !r.height)) ? 'hidden' : 'off screen';
    }
    out.push({ id: id, name: NAMES[id] || id, hint: hint });
  }
  return out;
}

/* ---------------------------------------------------------------------------
   The v2 move-mode UI — built by this file (see the header for
   why): the Select button + Hide button inside the existing
   #hud-move-bar, the slim edge tab that replaces the bar when it
   collapses, and the Select panel. Styles are injected once.
   --------------------------------------------------------------------------- */
var selectBtnEl = null, hideBtnEl = null, tabEl = null, panelEl = null;
var panelRows = [];      /* [{id, pick, centre}] for the open panel */
var panelOpen = false;
var barCollapsed = false;

var MOVE_CSS =
  '#hud-move-tab{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:200;' +
  'display:none;background:rgba(10,14,22,.94);border:2px solid #ffd75e;border-top:none;' +
  'border-radius:0 0 10px 10px;color:#ffd75e;font-size:13px;font-weight:bold;' +
  'padding:5px 14px;cursor:pointer;}' +
  '#hud-move-tab.show{display:block;}' +
  '#hud-move-panel{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:203;' +
  'display:none;width:min(92vw,380px);max-height:62vh;overflow-y:auto;' +
  'background:rgba(10,14,22,.97);border:2px solid #ffd75e;border-radius:12px;' +
  'padding:10px;color:#fff;font-size:14px;}' +
  '#hud-move-panel.show{display:block;}' +
  '#hud-move-panel .hm-head{display:flex;justify-content:space-between;align-items:center;' +
  'margin-bottom:8px;color:#ffd75e;font-weight:bold;}' +
  '#hud-move-panel .hm-row{display:flex;gap:8px;align-items:stretch;margin-bottom:6px;}' +
  '#hud-move-panel .hm-pick{flex:1;text-align:left;padding:9px 12px;font-size:15px;' +
  'border-radius:9px;border:none;background:#232b3d;color:#fff;cursor:pointer;}' +
  '#hud-move-panel .hm-pick .hm-hint{color:#ffd75e;font-size:12px;}' +
  '#hud-move-panel .hm-centre{padding:9px 10px;font-size:13px;border-radius:9px;' +
  'border:none;background:#333a4e;color:#fff;white-space:nowrap;cursor:pointer;}' +
  '#hud-move-panel .hm-close{padding:4px 10px;font-size:14px;border-radius:8px;' +
  'border:none;background:#333a4e;color:#fff;cursor:pointer;}' +
  '#hud-move-select{background:#232b3d;color:#fff;}' +
  '#hud-move-hide{background:#333a4e;color:#fff;}';

function buildMoveUI(){
  if (panelEl) return; /* built once */
  try {
    var st = document.createElement('style');
    st.id = 'hud-move-style';
    st.textContent = MOVE_CSS;
    var host = document.head || document.body;
    if (host && host.appendChild) host.appendChild(st);
  } catch (e) { /* styles are decoration; the mechanics below stand alone */ }
  var bar = document.getElementById('hud-move-bar');
  try {
    if (bar && document.createElement){
      selectBtnEl = document.createElement('button');
      selectBtnEl.id = 'hud-move-select';
      selectBtnEl.textContent = 'Select control ▾';
      selectBtnEl.addEventListener('click', function(){ togglePanel(); });
      bar.appendChild(selectBtnEl);
      hideBtnEl = document.createElement('button');
      hideBtnEl.id = 'hud-move-hide';
      hideBtnEl.textContent = 'Hide ▾';
      hideBtnEl.addEventListener('click', function(){ collapseBar(); });
      bar.appendChild(hideBtnEl);
    }
  } catch (e) { selectBtnEl = null; hideBtnEl = null; }
  try {
    if (document.createElement && document.body){
      tabEl = document.createElement('button');
      tabEl.id = 'hud-move-tab';
      tabEl.textContent = '✎ Move controls ▴';
      tabEl.addEventListener('click', function(){ expandBar(); });
      document.body.appendChild(tabEl);
      panelEl = document.createElement('div');
      panelEl.id = 'hud-move-panel';
      document.body.appendChild(panelEl);
    }
  } catch (e) { tabEl = null; panelEl = null; }
}

/* The bar collapses to the slim tab (v2 yield rule): the drag
   field is the whole viewport, and the chrome gets out of it.
   One tap on the tab brings the bar back for Done/Reset/Select. */
function collapseBar(){
  if (!inMove || barCollapsed) return;
  barCollapsed = true;
  closePanel();
  var bar = document.getElementById('hud-move-bar');
  if (bar) bar.classList.remove('show');
  if (tabEl) tabEl.classList.add('show');
}
function expandBar(){
  if (!inMove || !barCollapsed) return;
  barCollapsed = false;
  var bar = document.getElementById('hud-move-bar');
  if (bar) bar.classList.add('show');
  if (tabEl) tabEl.classList.remove('show');
}

/* The Select panel: rebuilt on every open so the hints (off
   screen / hidden) describe the controls as they are right now.
   Picking a row — or centring from it — closes the panel AND
   collapses the bar in the same tap (menus yield): the player is
   left looking at the control, with the whole viewport to drag
   in. */
function buildPanel(){
  if (!panelEl) return;
  panelRows = [];
  while (panelEl.children && panelEl.children.length){
    panelEl.removeChild(panelEl.children[0]);
  }
  var head = document.createElement('div');
  head.className = 'hm-head';
  var title = document.createElement('span');
  title.textContent = 'Select a control to move';
  head.appendChild(title);
  var close = document.createElement('button');
  close.className = 'hm-close';
  close.textContent = '✕';
  close.addEventListener('click', function(){ closePanel(); });
  head.appendChild(close);
  panelEl.appendChild(head);
  var items = selectList();
  for (var i = 0; i < items.length; i++){
    (function(item){
      var row = document.createElement('div');
      row.className = 'hm-row';
      var pick = document.createElement('button');
      pick.className = 'hm-pick';
      pick.textContent = item.name + (item.hint ? '  ' : '');
      if (item.hint){
        var hint = document.createElement('span');
        hint.className = 'hm-hint';
        hint.textContent = '(' + item.hint + ')';
        pick.appendChild(hint);
      }
      pick.addEventListener('click', function(){ pickFromList(item.id); });
      row.appendChild(pick);
      var centre = document.createElement('button');
      centre.className = 'hm-centre';
      centre.textContent = 'Centre it';
      centre.addEventListener('click', function(){ centreFromList(item.id); });
      row.appendChild(centre);
      panelEl.appendChild(row);
      panelRows.push({ id: item.id, row: row, pick: pick, centre: centre });
    })(items[i]);
  }
}
function openPanel(){
  if (!inMove || !panelEl) return;
  buildPanel();
  panelOpen = true;
  panelEl.classList.add('show');
  panelEl.style.display = 'block';
}
function closePanel(){
  panelOpen = false;
  if (panelEl){
    panelEl.classList.remove('show');
    panelEl.style.display = 'none';
  }
}
function togglePanel(){
  if (panelOpen) closePanel(); else openPanel();
}
/* A pick from the list: select the control (bringing it back
   first if it was lost), then EVERY menu gets out of the way. */
function pickFromList(id){
  selectControl(id);
  closePanel();
  collapseBar();
}
function centreFromList(id){
  centreControl(id);
  closePanel();
  collapseBar();
}

/* ---------------------------------------------------------------------------
   Enter / exit
   --------------------------------------------------------------------------- */
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
  /* The bar starts expanded, parked at the top edge; the player
     can collapse it (or it collapses itself on a list pick). */
  barCollapsed = false;
  var bar = document.getElementById('hud-move-bar');
  if (bar) bar.classList.add('show');
  if (tabEl) tabEl.classList.remove('show');
  closePanel();
  try {
    if (window.Report && Report.note) Report.note('hudmove', {event: 'enter', face: currentFace()});
  } catch (e) {}
}

function exitMoveMode(){
  if (!inMove) return;
  inMove = false;
  drag = null;
  clearSelected();
  hideTag();
  closePanel();
  barCollapsed = false;
  if (tabEl) tabEl.classList.remove('show');
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
  clearSelected();
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
  if (d.id) importantSet[d.id] = true;
  d.curLeft = p.left;
  d.curTop = p.top;
}

function onPointerDown(e){
  if (!inMove) return;
  var t = dragTargetOf(e);
  if (!t) return; /* the bar/tab/panel and everything else still work */
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
  /* Grabbing a control makes it the selected one (v2). */
  setSelected(t.id);
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
  var doneId = drag.id;
  drag = null;
  hideTag();
  /* The dropped control stays the selected one; park its tag. */
  if (selectedId === doneId){
    var el = document.getElementById(doneId);
    if (el) showTagFor(el, NAMES[doneId] || doneId);
  }
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
  buildMoveUI();
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
      Report.setSys('hudmove', { status: 'ok', version: '2.0',
        note: 'Player-movable HUD controls: drag, select-by-list with bring-back, edge law, menus yield; per-face overrides in localStorage (Joshua 2026-10-17)' });
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
  /* v2 — selection, rescue, and the yielding menus */
  selectList: selectList,
  select: selectControl,
  centre: centreControl,
  selected: function(){ return selectedId; },
  openPanel: openPanel,
  closePanel: closePanel,
  isPanelOpen: function(){ return panelOpen; },
  panelRows: function(){ return panelRows.slice(); },
  collapseBar: collapseBar,
  expandBar: expandBar,
  isBarCollapsed: function(){ return barCollapsed; },
  edgeClamp: edgeClamp,
  TARGET_IDS: TARGET_IDS.slice(),
  APPLY_IDS: APPLY_IDS.slice()
};

})();
