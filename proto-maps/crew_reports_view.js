/* ============================================================================
   CREW REPORTS VIEW (Joshua 2026-10-24) — the construction crews'
   reports live in the Administrator menu now, NOT on the game view.

   What changed and why: the road crew, infrastructure crew,
   veteran foremen and inspectors used to announce every report on
   the game view (toasts) and kept 🚧/🔧 buttons on the HUD. Joshua:
   "remove them from the viewport — leave them in the
   administrative menu so if somebody wants to review reports I
   can see this information from the menu instead of it occupying
   space on the view screen."

   The reports themselves are generated and stored EXACTLY as
   before — every event still lands in the crews' own dispatch
   logs (window.ROADCREW.log / window.INFRACREW.log, persisted by
   the crew systems) and in the Report data (Report.note). This
   module only READS those logs, when the player opens the view
   from Settings -> Administrator -> "Crew Reports"
   (#adm-crewreports, wired here like hud_move.js wires its own
   entry points). Nothing in this module renders during play.

   The view lists each crew's filed reports (newest first, latest
   30 per crew) and offers the crews' full dispatch panels (defect
   boards included) via ROADCREW.toggle / INFRACREW.toggle — the
   same panels the Administrator "Road Dispatch Log" row opens.
   Inspector findings live in the Report data (crewinspector) and
   CrewInspector.findings(); they were never part of the dispatch
   logs, so they are not duplicated here.

   Defensive throughout (the house pattern): crews not booted yet
   read as "still starting up", a missing crew changes nothing,
   and no failure in here can break the menu or the game.
   ============================================================================ */
(function crewReportsView(){
'use strict';

var panelEl = null;
var built = false;

/* The view's styles — injected once, rc-panel family styling. */
var CSS =
  '#crew-reports-panel{position:fixed;inset:0;z-index:55;display:none;' +
  'align-items:center;justify-content:center;background:rgba(0,0,0,.72);}' +
  '#crew-reports-panel.show{display:flex;}' +
  '#crew-reports-panel .card{background:#161b26;border-radius:14px;' +
  'padding:20px 22px;max-width:470px;width:88%;max-height:78vh;' +
  'display:flex;flex-direction:column;color:#fff;}' +
  '#crew-reports-panel h3{margin:0 0 4px 0;color:#ffd75e;}' +
  '#crew-reports-panel .sub{color:#8a93a6;font-size:13px;margin-bottom:10px;}' +
  '#crew-reports-panel h4{margin:12px 0 4px 0;color:#ffb02e;font-size:15px;}' +
  '#crew-reports-panel h4.ic{color:#a8d800;}' +
  '#crew-reports-list{overflow-y:auto;flex:1;min-height:60px;}' +
  '.cr-log{margin:6px 0;padding:6px 10px;font-size:13px;color:#c9c9c9;' +
  'border-left:3px solid #ffb02e;}' +
  '.cr-log.ic{border-left-color:#a8d800;}' +
  '.cr-log .lt{color:#8a93a6;margin-right:8px;}' +
  '.cr-none{font-size:13px;color:#8a93a6;padding:6px 10px;}' +
  '#crew-reports-panel .btnrow{display:flex;gap:10px;margin-top:12px;}' +
  '#crew-reports-panel .btnrow button{flex:1;padding:11px 8px;font-size:14px;' +
  'border-radius:10px;border:none;font-weight:bold;cursor:pointer;}' +
  '#cr-open-road{background:#ffb02e;color:#111;}' +
  '#cr-open-infra{background:#a8d800;color:#111;}' +
  '#cr-close{background:#333a4e;color:#fff;}';

/* Escape report text before it goes into innerHTML — log lines
   carry street names and quoted field notes from game data. */
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Read one crew's stored log (newest first, capped). Returns null
   when the crew has not published its API yet. */
function readLog(api){
  try {
    if (api && api.log && api.log.length != null){
      return api.log.slice(-30).reverse();
    }
  } catch (e) { /* fall through to "not ready" */ }
  return null;
}

function renderList(){
  var host = document.getElementById('crew-reports-list');
  if (!host) return;
  var h = '';
  /* Road crew section. */
  h += '<h4>🚧 Road Crew</h4>';
  var rc = (typeof window !== 'undefined') ? window.ROADCREW : null;
  var rcLog = readLog(rc);
  if (!rcLog) h += '<div class="cr-none">Road crew is still starting up — no reports yet.</div>';
  else if (!rcLog.length) h += '<div class="cr-none">No reports filed yet — patrols are out.</div>';
  else rcLog.forEach(function (e) {
    h += '<div class="cr-log"><span class="lt">' + esc(e.t) + '</span>' + esc(e.msg) + '</div>';
  });
  /* Infrastructure crew section. */
  h += '<h4 class="ic">🔧 Infrastructure Crew</h4>';
  var ic = (typeof window !== 'undefined') ? window.INFRACREW : null;
  var icLog = readLog(ic);
  if (!icLog) h += '<div class="cr-none">Infrastructure crew is still starting up — no reports yet.</div>';
  else if (!icLog.length) h += '<div class="cr-none">No reports filed yet — crews are out.</div>';
  else icLog.forEach(function (e) {
    h += '<div class="cr-log ic"><span class="lt">' + esc(e.t) + '</span>' + esc(e.msg) + '</div>';
  });
  host.innerHTML = h;
}

/* Build the panel once (styles + DOM), in buildMoveUI's pattern:
   this module owns its UI so it can never be half-merged away
   from its behaviour. */
function build(){
  if (built) return;
  built = true;
  try {
    var st = document.createElement('style');
    st.id = 'crew-reports-style';
    st.textContent = CSS;
    (document.head || document.body).appendChild(st);
    panelEl = document.createElement('div');
    panelEl.id = 'crew-reports-panel';
    panelEl.innerHTML =
      '<div class="card"><h3>📋 Crew Reports</h3>' +
      '<div class="sub">What the construction crews have filed — ' +
      'recorded as it happens, read here in the Administrator menu.</div>' +
      '<div id="crew-reports-list"></div>' +
      '<div class="btnrow">' +
      '<button id="cr-open-road">🚧 Road panel</button>' +
      '<button id="cr-open-infra">🔧 Infra panel</button>' +
      '<button id="cr-close">Close</button>' +
      '</div></div>';
    document.body.appendChild(panelEl);
    document.getElementById('cr-close').addEventListener('click', function(){ toggle(false); });
    document.getElementById('cr-open-road').addEventListener('click', function(){
      toggle(false);
      try { if (window.ROADCREW && ROADCREW.toggle) ROADCREW.toggle(true); } catch (e) {}
    });
    document.getElementById('cr-open-infra').addEventListener('click', function(){
      toggle(false);
      try { if (window.INFRACREW && INFRACREW.toggle) INFRACREW.toggle(true); } catch (e) {}
    });
  } catch (e) { panelEl = null; }
}

function toggle(force){
  build();
  if (!panelEl) return;
  var open = (typeof force === 'boolean') ? force : !panelEl.classList.contains('show');
  if (open){
    renderList(); /* fresh every open — reports filed since the last look are here */
    panelEl.classList.add('show');
  } else {
    panelEl.classList.remove('show');
  }
}

/* Wire the Administrator row. The row is static HTML (index.html),
   so it exists by the time deferred scripts run; the small retry
   covers any loader reordering. */
function wire(){
  var btn = document.getElementById('adm-crewreports');
  if (btn && !btn.__crewReportsWired){
    btn.__crewReportsWired = true;
    btn.addEventListener('click', function(){ toggle(true); });
    return true;
  }
  return !!btn;
}
function init(){
  build();
  if (!wire()){
    var tries = 0;
    var iv = setInterval(function(){
      tries++;
      if (wire() || tries > 20) clearInterval(iv);
    }, 500);
  }
  try {
    if (typeof Report !== 'undefined' && Report.setSys){
      Report.setSys('crewreports', { status: 'ok', version: '1.0',
        note: 'Crew Reports view in the Administrator menu (Joshua 2026-10-24): lists ROADCREW.log + INFRACREW.log; crew reports no longer display on the game view.' });
    }
  } catch (e) {}
}

if (document.readyState === 'loading' && document.addEventListener)
  document.addEventListener('DOMContentLoaded', init);
else init();

/* Public API — debugging + the verification harness. */
window.CrewReportsView = {
  open: function(){ toggle(true); },
  close: function(){ toggle(false); },
  toggle: toggle,
  renderList: renderList
};

})();
