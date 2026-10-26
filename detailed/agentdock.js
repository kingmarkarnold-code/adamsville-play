/* ============================================================================
   AGENTDOCK — Collapsible "Agent Reports" icon group (v1.0)
   ----------------------------------------------------------------------------
   Joshua (2026-10-09): all the agent/crew icon buttons clutter the HUD and
   cover the street-name display. This module collects them into ONE
   collapsible dock:
     - Collapsed: single "📋" (Agent Reports) toggle button
     - Expanded: the toggle + all agent buttons in a horizontal row
   Buttons collected: sf-btn (survey fleet 🗺️), ce-btn (code
   enforcement 🏢), heli-btn (helicopter 🚁).
   (2026-10-24: rc-btn / ic-btn left this list because the buttons
   themselves are gone — Joshua moved the road + infrastructure
   crews' reports into the Administrator menu, off the game view.)
   Each module still owns its button and panel — the dock only re-parents
   the button elements and overrides their position CSS. Click handlers,
   panels, and titles are untouched.
   Single-instance guard + boot poll (same pattern as other modules).

   2026-10-26 (Joshua): "the report icon is still on screen" — the dock
   itself is now HIDDEN by default: no always-on-screen 📋 toggle at
   all. The entry point is the Administrator menu's "📋 Agent Reports"
   row (#adm-agentreports, beside Crew Reports), which reveals the
   dock already expanded. Tapping the toggle to collapse hides the
   dock again. The dock, the tray and the collected agent buttons are
   unchanged — only the always-visible icon is gone. Automatic crash
   and session reports never used this dock and are untouched.
   ============================================================================ */
(function(){
'use strict';
if (window.__agentdock) return;  // single instance
window.__agentdock = true;

/* The agent button IDs this dock collects, in display order. */
var AGENT_BTNS = ['sf-btn','ce-btn','heli-btn'];

var dock=null, toggleBtn=null, tray=null, expanded=false;
var revealed=false;  // 2026-10-26: dock hidden until the menu asks for it
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
    // Collapsing puts the icon away again (2026-10-26): the dock only
    // exists on screen while the player is using it.
    if (!expanded) hideDock();
  });
  tray=document.createElement('div');
  tray.id='agent-dock-tray';
  dock.appendChild(toggleBtn);
  dock.appendChild(tray);
  // Hidden by default (2026-10-26) — revealed from the Administrator
  // menu's Agent Reports row or via AGENTDOCK.expand().
  dock.style.display='none';
  document.body.appendChild(dock);
}

/* Reveal the dock on screen (still collapsed until expanded). */
function showDock(){
  buildDock();
  revealed=true;
  dock.style.display='flex';
}
/* Take the dock off the screen entirely (and collapse it). */
function hideDock(){
  if (!dock) return;
  revealed=false;
  expanded=false;
  dock.classList.remove('open');
  dock.style.display='none';
  if (toggleBtn) toggleBtn.title='Agent Reports — tap to expand';
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
   Poll every 500ms until all of them are docked (or 60s timeout). */
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
        status:'ok', version:'1.1',
        note:'docked '+collected.length+'/'+AGENT_BTNS.length+' agent buttons into collapsible group (road/infra crew buttons retired to the Administrator menu 2026-10-24); dock hidden by default since 2026-10-26, opened from Administrator > Agent Reports'
      });
    }catch(e){}
    return;  // done
  }
  setTimeout(poll, 500);
}
setTimeout(poll, 1000);  // let agent modules boot first

/* Public API (for admin panel / debugging). Since 2026-10-26 the dock
   starts hidden: expand() reveals AND opens it; collapse() closes
   AND hides it. */
window.AGENTDOCK={
  expand:function(){ showDock(); if(dock&&!expanded) toggleBtn.click(); },
  collapse:function(){ hideDock(); },
  get docked(){ return collected.map(function(c){ return c.el.id; }); }
};

/* Administrator menu entry (2026-10-26): the "📋 Agent Reports" row
   (#adm-agentreports in index.html, beside Crew Reports) is how the
   player reaches the agent buttons now that the always-on-screen
   icon is gone. Same wiring pattern as crew_reports_view.js: find
   the row (retrying while the page finishes booting), and on click
   close the menus and reveal the dock already expanded. */
(function wireAgentReportsRow(){
  var tries=0;
  function wire(){
    var row=document.getElementById('adm-agentreports');
    if (!row){
      if (++tries<=40) setTimeout(wire, 500);
      return;
    }
    if (row.__agentdockWired) return;
    row.__agentdockWired=true;
    row.addEventListener('click', function(){
      try{
        var am=document.getElementById('adminmenu'); if (am) am.classList.remove('show');
        var st=document.getElementById('settings'); if (st) st.classList.remove('show');
      }catch(e){}
      window.AGENTDOCK.expand();
    });
  }
  wire();
})();
})();
