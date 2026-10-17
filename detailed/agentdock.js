/* ============================================================================
   AGENTDOCK — Collapsible "Agent Reports" icon group (v1.0)
   ----------------------------------------------------------------------------
   Joshua (2026-10-09): all the agent/crew icon buttons clutter the HUD and
   cover the street-name display. This module collects them into ONE
   collapsible dock:
     - Collapsed: single "📋" (Agent Reports) toggle button
     - Expanded: the toggle + all agent buttons in a horizontal row
   Buttons collected: rc-btn (road crew 🚧), ic-btn (infrastructure 🔧),
   sf-btn (survey fleet 🗺️), ce-btn (code enforcement 🏢),
   heli-btn (helicopter 🚁).
   Each module still owns its button and panel — the dock only re-parents
   the button elements and overrides their position CSS. Click handlers,
   panels, and titles are untouched.
   The dock sits below the backpack icon row, clear of the street-name HUD.
   Mobile overrides keep it thumb-reachable without covering the road label.
   Single-instance guard + boot poll (same pattern as other modules).
   ============================================================================ */
(function(){
'use strict';
if (window.__agentdock) return;  // single instance
window.__agentdock = true;

/* The agent button IDs this dock collects, in display order. */
var AGENT_BTNS = ['rc-btn','ic-btn','sf-btn','ce-btn','heli-btn'];

var dock=null, toggleBtn=null, tray=null, expanded=false;
var collected=[];  // {el, origParent}

function buildDock(){
  if (dock) return;
  // --- styles ---
  var css=document.createElement('style');
  css.textContent=
    /* Dock container: fixed, sits in the HUD icon area below the title row.
       Desktop: top-left icon row area. Never overlaps #street-name. */
    '#agent-dock{position:fixed;left:12px;top:156px;z-index:30;'+
    'display:flex;align-items:center;gap:6px;}'+
    /* The single toggle button — matches the other HUD icon buttons. */
    '#agent-dock-toggle{width:52px;height:52px;border-radius:12px;'+
    'border:2px solid #7fd4ff;background:rgba(20,24,34,.88);color:#7fd4ff;'+
    'font-size:24px;cursor:pointer;flex:0 0 auto;}'+
    /* The expanding tray: hidden when collapsed, horizontal row when open. */
    '#agent-dock-tray{display:none;align-items:center;gap:6px;'+
    'background:rgba(20,24,34,.72);border-radius:12px;padding:6px;}'+
    '#agent-dock.open #agent-dock-tray{display:flex;}'+
    /* Docked agent buttons: strip their fixed positioning, keep their look. */
    '#agent-dock-tray button{position:static!important;left:auto!important;'+
    'top:auto!important;bottom:auto!important;right:auto!important;'+
    'width:52px;height:52px;margin:0;flex:0 0 auto;}'+
    /* Mobile: dock moves to avoid the street-name (top-left on mobile). */
    '@media (max-width:820px),(pointer:coarse){'+
    '#agent-dock{left:8px!important;top:150px!important;}'+
    '#agent-dock-toggle{width:48px!important;height:48px!important;}'+
    '#agent-dock-tray button{width:48px!important;height:48px!important;}}';
  document.head.appendChild(css);

  // --- DOM ---
  dock=document.createElement('div');
  dock.id='agent-dock';
  toggleBtn=document.createElement('button');
  toggleBtn.id='agent-dock-toggle';
  toggleBtn.title='Agent Reports — tap to expand';
  toggleBtn.innerHTML='📋';
  toggleBtn.addEventListener('click', function(){
    expanded=!expanded;
    dock.classList.toggle('open', expanded);
    toggleBtn.title=expanded?'Agent Reports — tap to collapse':'Agent Reports — tap to expand';
  });
  tray=document.createElement('div');
  tray.id='agent-dock-tray';
  dock.appendChild(toggleBtn);
  dock.appendChild(tray);
  document.body.appendChild(dock);
}

/* Move an agent button into the tray, preserving its handlers. */
function collect(id){
  var el=document.getElementById(id);
  if (!el || el.__docked) return false;
  el.__docked=true;
  collected.push({el:el, origParent:el.parentNode});
  tray.appendChild(el);
  return true;
}

/* Boot poll: agent modules create their buttons on their own schedule.
   Poll every 500ms until all five are docked (or 60s timeout). */
var tries=0;
function poll(){
  tries++;
  buildDock();
  var pending=0;
  AGENT_BTNS.forEach(function(id){
    if (!document.getElementById(id)) pending++;
    else collect(id);
  });
  if (pending===0 || tries>120){
    try{
      if (typeof Report!=='undefined') Report.setSys('agentdock',{
        status:'ok', version:'1.0',
        note:'docked '+collected.length+'/5 agent buttons into collapsible group'
      });
    }catch(e){}
    return;  // done
  }
  setTimeout(poll, 500);
}
setTimeout(poll, 1000);  // let agent modules boot first

/* Public API (for admin panel / debugging). */
window.AGENTDOCK={
  expand:function(){ if(dock&&!expanded) toggleBtn.click(); },
  collapse:function(){ if(dock&&expanded) toggleBtn.click(); },
  get docked(){ return collected.map(function(c){ return c.el.id; }); }
};
})();
