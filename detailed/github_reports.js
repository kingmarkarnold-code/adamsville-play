/* ============================================================
   SURVIVING ADAMSVILLE — Report sender (Google Form edition)
   FILE: github_reports.js
   ------------------------------------------------------------
   WHAT THIS DOES:
   Sends the game's diagnostic reports to Joshua (via Mollie)
   so inspector findings, stuck vehicles, errors, and
   performance warnings can be seen without needing the phone
   the game ran on. Reports land as responses in Joshua's
   Google Form, "Surviving Adamsville — Player Reports".

   HOW IT WORKS (Joshua's rulings — NO KEY IN GAME):
   * 2026-10-24: players must never need a GitHub key, so the
     game stopped talking to GitHub directly; the old
     direct-upload token code was removed the same day (its
     token was dead, and any working key shipped in a public
     game file can be read by anyone who downloads the game).
     There is no token code here on purpose — do not re-add one.
   * 2026-10-25: the Apps Script RELAY that was going to sit
     between the game and GitHub was retired before it ever
     deployed, and replaced by a Google Form Joshua owns.
     The game POSTs each report straight into the form
     (GITHUB_CONFIG.REPORT_FORM_URL + REPORT_FORM_ENTRIES in
     github-config.js) — no key, no sign-in, exactly like a
     public survey accepting anonymous answers. Mollie reads
     the responses through the Forms API. (The full build
     record: game-map/report-relay/GOOGLE-FORM.md.)
   * The relay path below is kept ONLY as an unused fallback:
     it is used solely if the form address is ever emptied
     AND a relay address filled in. Today neither is the case
     (form set, relay "").

   AUTO-FILL (Joshua's wiring principle, 2026-10-25):
   * EVERYTHING THE GAME CAN KNOW IS FILLED IN BY THE CODE:
     report type (mapped from the report's kind), game
     version (app + UI + map, read live), where in the game
     (zone + player position + street when the report knows
     it), and device (label + platform the game detects).
   * The player is left with ONLY the part that needs a
     human — the feedback message itself. In the form's
     "What happened?" answer, the report's own message rides
     FIRST and stays the readable head; the folded diagnostics
     (type, timestamp, session, full details JSON) follow it.
   * Crash and other automatic reports are fully automatic:
     no player input at all. There is deliberately NO
     player-facing field anywhere for version, device or
     location — those are never the player's job to type.

   EXIT / SESSION REPORTS (Joshua's directive, 2026-10-25):
   * When a player EXITS the game, one automatic SESSION
     report is queued and handed to the form as background
     work before the game finishes closing — the player is
     never asked anything and the close is never visibly
     delayed. It maps to the form's "Stats" report type
     (added to the form 2026-10-25 as "Session", renamed
     "Stats" the same day on Joshua's corrected word).
   * WHAT IT CARRIES — only facts the code actually knows:
     how long the session lasted (the headline of the
     "What happened?" answer), the distance travelled and
     the zones visited (both measured by this sender from
     the game's own player position / zone state — see
     samplePlayer below), the performance level + fps at
     exit when PerfBudget exposes them, and how many other
     reports this session queued. Device, game version and
     the exit position ride in their own auto-filled form
     fields, exactly like every other report. NO player
     name — automatic reports never carry one.
   * TRIGGERS: the game's single exit funnel exitGame() in
     index.html calls GitHubReports.sessionExit('exit-game')
     first; on the WEB, a pagehide (tab close / navigation
     away) queues it with reason 'page-close' if no exit
     queued it yet. A plain tab-hide (visibilitychange) is
     NOT an exit — it only flushes the queue, as before.
   * DEDUPE: exactly ONE session report per play session,
     however many exit paths fire (sessionReportQueued).
   * DELIVERY THAT SURVIVES CLOSING: the exit flush prefers
     navigator.sendBeacon (built for exactly this), falling
     back to fetch with keepalive:true, and finally to the
     normal queue semantics if neither exists.

   QUEUEING (unchanged behaviour):
   * All existing Report.note() / Report.noteError() calls are
     wrapped automatically — every system that already logs to
     the Report panel also queues a report here. That includes
     the Administrator crew reports (crewinspector findings):
     they are automatic reports and ride this same flush.
     No changes to other files needed.

   CREW REPORTS GO SILENT-AUTOMATIC (Joshua's directives,
   2026-10-28):
   * The crews' own dispatch/event logs (road crew dlog, infra
     crew dlog, survey fleet dlog, code enforcement clog, city
     workforce _log, veteran fileReport) used to live ONLY in
     the crews' local logs + the Report panel's system state —
     reaching Mollie required Joshua to push "Send Reports to
     Mollie". Each of those emitters now ALSO files through
     Report.note (in its own file), so every crew finding rides
     this sender automatically, in the background, while the
     crews are selected on. The in-game surfaces (Administrator
     Crew Reports view, dispatch panels) are untouched — he can
     still LOOK at everything; nothing needs his push any more.
   * CREW CATEGORY: crew/workforce kinds map to the form's new
     "Crew Report" type choice (added to the form 2026-10-28;
     same entry code — choices are values, not fields). The
     kind list lives in CREW_KINDS below; a crew system's
     ERRORS file as Crew Report too (an infra dispatch failure
     is a crew finding, not a game crash). All other kinds keep
     their previous mapping.
   * THROTTLE: crew logs are chatty (a workforce deployment
     line per worker move), so crew reports pass a per-kind
     gate in queueReport: identical messages deduped inside a
     10-minute window, and each crew kind capped per rolling
     10 minutes. Dropped reports are counted (status().
     crewDropped) — throttling is never silent in the data.
     Non-crew reports are never throttled.

   TELEMETRY (Joshua's directive, 2026-10-28):
   * Perf reports and the exit/session (Stats) report carry a
     standard `telemetry` block in their details (built by
     telemetryBlock below): current FPS + the session FPS band
     and quality-change count (PerfBudget.getTelemetry — the
     perf system's own counters), the governor values actually
     in force (__perfTrafficCap / __perfNpcDist /
     __perfShadowDist), the file-loading state (stock + map
     delivery results, the vehicle library's ready/failed
     state, and how many delivery-defect reports this session
     queued), and the map mode (package vs legacy + how it was
     requested). Every value is READ from the system that owns
     it; the sender tracks nothing of its own except counting
     the reports it queues. A source that doesn't exist yet
     (delivery hasn't run, library hasn't loaded) is simply
     absent from the block — never estimated.
   * Reports sit in a memory queue. Every flushIntervalMs
     (default 5 minutes, see github-config.js) the queue is
     sent: on the form path, ONE form POST per queued report
     (a Google Form takes one response per POST — it cannot
     take the old single JSON bundle). An item leaves the
     queue only when its own POST resolves; failures stay
     queued and the next flush retries them.
   * A final flush runs when the page hides/closes
     (pagehide + visibilitychange) with fetch keepalive, so
     the send is attempted even as the page tears down.
   * If no destination is configured, or a send fails, the
     reports STAY in the queue — and the manual/export
     behaviour (Report.shareJson etc.) is untouched, so no
     report is lost because a destination is absent. The only
     way a queued report is dropped is the maxQueue cap
     (oldest first), exactly as before.

   ONE HONEST LIMIT (browser security rules, not a bug):
   * Google Forms does not answer browser "CORS" permission
     checks for cross-origin posts, so the game sends with
     fetch mode "no-cors". The browser delivers the response
     to Google but will not let the game READ Google's reply.
     A resolved send therefore means "Google accepted the
     delivery", not "the answer was confirmed recorded".
     Failures we CAN see (no network, address missing) keep
     the queue intact. Mollie verifies real arrivals by
     reading the form's responses through the Forms API.

   SECURITY:
   * No key, token, or credential exists in this file or in
     github-config.js. The form address and field codes are
     public (anyone may read them); the worst they allow is
     posting a junk response into the form.
   * Every network call is wrapped in try/catch. Diagnostics
     must never break the game — Joshua's standing rule.

   API:
   * GitHubReports.queue(type, details) — queue one report now.
   * GitHubReports.sessionExit(reason) — queue the session's
     ONE exit/session report (deduped) and flush the queue on
     the closing-safe path. Called by exitGame() and pagehide.
   * GitHubReports.flush() — send the queue immediately.
     Returns a Promise for true (every queued report handed
     to the destination) / false (not configured, empty
     queue, or some send failed — failures stay queued).
   * GitHubReports.status() — {enabled, configured, hasForm,
     hasRelay, hasToken, queued, lastFlush, lastError}.
     `hasToken` is a LEGACY ALIAS kept only so older callers
     (the "Send Reports to Mollie" button in index.html) keep
     working: it reports whether a sending path is configured
     (today: the form), NOT whether a token exists. No token
     exists.
   ------------------------------------------------------------
   Documentation comments are required on all game code —
   Joshua's standing rule. This file follows it.
   ============================================================ */
window.GitHubReports = (function(){
  'use strict';

  /* ---------- small utilities ---------- */

  function pad(n){ return (n<10?'0':'')+n; }

  /* Local-time stamp for bundle names: 2026-10-24-153012 */
  function fileTs(d){
    d = d || new Date();
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+
      '-'+pad(d.getHours())+pad(d.getMinutes())+pad(d.getSeconds());
  }

  /* Keep names safe: lowercase, dashes, no weird chars. */
  function slug(s){
    s = String(s==null?'report':s).toLowerCase().replace(/[^a-z0-9]+/g,'-')
      .replace(/^-+|-+$/g,'');
    return s || 'report';
  }

  /* Random session id so reports from one play session group together. */
  var sessionId = 's'+Date.now().toString(36)+
    Math.floor(Math.random()*0xffffff).toString(36);

  /* ---------- session tracking (for the exit/session report) ----------
     The sender's own session clock starts when this module loads
     (it loads with the game's scripts, before play begins). The
     facts below are MEASURED by this sender from game state that
     already exists — the player position (playerPos) and the
     current zone (zoneId) — sampled when a report is queued, on
     the flush timer, and once more at exit. Nothing here is
     estimated or invented. */
  var sessionStartMs = Date.now();
  var sessionReportQueued = false;  // dedupe: ONE session report per session
  var reportsQueuedTotal = 0;       // every report queued this session
  var zonesVisited = [];            // zone ids, first-visit order
  var distanceTravelledM = 0;       // world units = game metres (1u = 1m)
  var lastSamplePos = null;         // last sampled {x,z}

  function noteZone(z){
    try{
      if(typeof z==='string' && z){
        for(var i=0;i<zonesVisited.length;i++)
          if(zonesVisited[i]===z) return;
        zonesVisited.push(z);
      }
    }catch(e){}
  }

  /* Sample the player's position + zone once. Distance accrues
     only from believable steps: a single sample-to-sample jump
     over 500 units is a teleport / zone load / spawn, not
     travel, and is not counted. */
  function samplePlayer(){
    try{
      noteZone(zoneId());
      var p = playerPos();
      if(p){
        if(lastSamplePos){
          var dx = p.x-lastSamplePos.x, dz = p.z-lastSamplePos.z;
          var d = Math.sqrt(dx*dx+dz*dz);
          if(isFinite(d) && d <= 500) distanceTravelledM += d;
        }
        lastSamplePos = p;
      }
    }catch(e){}
  }

  function sessionSeconds(){
    var s = Math.round((Date.now()-sessionStartMs)/1000);
    return (isFinite(s) && s>0) ? s : 0;
  }

  /* "2h 3m 4s" / "3m 4s" / "4s" — plain, readable duration. */
  function durationText(totalSec){
    var s = Math.max(0, Math.floor(totalSec||0));
    var h = Math.floor(s/3600), m = Math.floor((s%3600)/60), r = s%60;
    if(h>0) return h+'h '+m+'m '+r+'s';
    if(m>0) return m+'m '+r+'s';
    return r+'s';
  }

  /* Player position snapshot, if the game has one yet. Never throws. */
  function playerPos(){
    try{
      if(typeof player!=='undefined' && player &&
         typeof player.x==='number' && typeof player.z==='number')
        return { x: Math.round(player.x*10)/10, z: Math.round(player.z*10)/10 };
      if(typeof window!=='undefined' && window.player && window.player.x!==undefined)
        return { x: Math.round(window.player.x*10)/10,
                 z: Math.round(window.player.z*10)/10 };
    }catch(e){}
    return null;
  }

  /* Current zone id, using the same guarded reads crashlog.js
     established (__ZONE_META first, then the ?zone= parameter).
     Snapshotted onto each report AT QUEUE TIME (see queueReport)
     so the "Where in the game" answer names the zone the event
     happened in — even if the player has crossed into another
     zone by the time the queue flushes. Never throws. */
  function zoneId(){
    try{
      if(typeof window!=='undefined'){
        if(window.__ZONE_META && window.__ZONE_META.id)
          return String(window.__ZONE_META.id);
        var m = /[?&]zone=([a-z0-9_]+)/i.exec(
          (window.location && window.location.search) || '');
        if(m) return m[1];
      }
    }catch(e){}
    return 'adamsville';
  }

  /* Live build versions, for the auto-filled "Game version"
     form answer: the app version stamped in index.html plus
     the UI and map versions the deferred loader stamps from
     the manifests (__UIVER / __MAPVER — the same reads
     input_diag.js makes). Read at FLUSH time so the answer
     names the build that is sending. Falls back to the send
     stamp when a build exposes none of them. Never throws. */
  function gameVersionString(){
    var parts = [];
    try{
      if(typeof window!=='undefined'){
        if(window.APP_VERSION) parts.push('app '+String(window.APP_VERSION));
        if(typeof window.__UIVER==='string' && window.__UIVER)
          parts.push('ui '+window.__UIVER);
        if(typeof window.__MAPVER==='string' && window.__MAPVER)
          parts.push('map '+window.__MAPVER);
      }
    }catch(e){}
    return parts.length ? parts.join(' · ') : ('build '+fileTs());
  }

  /* Short device label for the report filename, e.g. "a17-5g".
     Best-effort from the user agent; purely cosmetic. */
  function deviceLabel(){
    try{
      var ua = '';
      if(typeof navigator!=='undefined' && navigator.userAgent)
        ua = String(navigator.userAgent);
      var m = ua.match(/\(([^)]*)\)/);
      var inside = m ? m[1] : '';
      var parts = inside.split(';');
      var model = '';
      for(var i=parts.length-1;i>=0;i--){
        var p = parts[i].trim();
        if(p && !/^(android|linux)/i.test(p)){ model = p; break; }
      }
      return slug(model || 'player').substring(0,24) || 'player';
    }catch(e){}
    return 'player';
  }

  /* Device/app info sent with every bundle — helps Mollie tell
     whose phone a report came from. No identifiers, no accounts. */
  function deviceInfo(){
    var info = { label: deviceLabel() };
    try{
      if(typeof navigator!=='undefined'){
        info.userAgent = String(navigator.userAgent||'');
        info.platform = String(navigator.platform||'');
        info.language = String(navigator.language||'');
      }
    }catch(e){}
    return info;
  }

  /* ---------- configuration ---------- */

  function cfg(){
    try{
      if(typeof window!=='undefined' && window.GITHUB_CONFIG)
        return window.GITHUB_CONFIG;
    }catch(e){}
    return {};
  }

  function isEnabled(){
    try{ return cfg().enabled !== false; }catch(e){ return true; }
  }

  /* The relay address (RETIRED path — the relay was never
     deployed). "" today and expected to stay that way; read
     only so the fallback bundle send below keeps working if
     a relay address is ever filled in AND the form address
     is emptied. */
  function relayUrl(){
    try{
      var u = cfg().REPORT_RELAY_URL;
      if(typeof u==='string' && /^https:\/\//i.test(u.trim()))
        return u.trim();
    }catch(e){}
    return '';
  }

  /* The Google Form submission address — the game's live
     destination since 2026-10-25. A public form address, not
     a secret. "" only if the config is ever stripped. */
  function formUrl(){
    try{
      var u = cfg().REPORT_FORM_URL;
      if(typeof u==='string' && /^https:\/\//i.test(u.trim()))
        return u.trim();
    }catch(e){}
    return '';
  }

  /* The form's field codes (which POST parameter answers
     which question). Returns null when the config carries no
     usable map — a form send without the codes would answer
     nothing, so flush treats that as "not configured". */
  function formEntries(){
    try{
      var e = cfg().REPORT_FORM_ENTRIES;
      if(e && typeof e==='object' &&
         typeof e.type==='string' && e.type &&
         typeof e.message==='string' && e.message &&
         typeof e.version==='string' && e.version &&
         typeof e.where==='string' && e.where &&
         typeof e.device==='string' && e.device &&
         typeof e.name==='string' && e.name)
        return e;
    }catch(e){}
    return null;
  }

  function clientTag(){
    try{
      var t = cfg().REPORT_CLIENT_TAG;
      if(typeof t==='string' && t) return t;
    }catch(e){}
    return 'surviving-adamsville-game';
  }

  /* A sending path exists when sending is enabled AND a
     destination is set: the Google Form (preferred), or the
     retired relay as fallback if its address were ever
     filled in while the form's is empty. */
  function isConfigured(){
    return isEnabled() && (!!formUrl() || !!relayUrl());
  }

  function flushMs(){
    try{
      var ms = parseInt(cfg().flushIntervalMs, 10);
      if(ms >= 30000) return ms;   // never flush more often than 30s
    }catch(e){}
    return 5*60*1000;
  }

  function maxQueue(){
    try{
      var n = parseInt(cfg().maxQueue, 10);
      if(n >= 10) return n;
    }catch(e){}
    return 200;
  }

  /* ---------- crew reports (2026-10-28) ----------

     The crew/workforce systems whose findings file as the
     form's "Crew Report" type. Keys are the Report categories
     / queue type slugs those systems use: the road, infra,
     survey, HQ-staff, code-enforcement and priority-dispatch
     crews, the municipal workforce, the veteran foremen, the
     crew inspector (its note category is 'crewinspector'; its
     queued type is 'inspector-finding'), and the Administrator
     crew-reports view's own status category. */
  var CREW_KINDS = {
    'roadcrew': 1, 'infracrew': 1, 'surveyfleet': 1,
    'hqstaff': 1, 'cityworkforce': 1, 'codeenforce': 1,
    'prioritydispatch': 1, 'veterancrew': 1,
    'crewinspector': 1, 'inspector-finding': 1, 'crewreports': 1
  };

  /* The crew kind a report belongs to, or null. Candidates, in
     order: the report's details._category (set by the Report
     wrappers), the queue type itself, and the type with an
     'error-' prefix stripped (Report.noteError queues crew
     errors as 'error-<category>' — they are crew findings). */
  function crewKindOf(type, details){
    try{
      var cands = [];
      if(details && typeof details==='object' &&
         typeof details._category==='string' && details._category)
        cands.push(details._category.toLowerCase());
      var t = String(type==null?'':type).toLowerCase();
      if(t) cands.push(t);
      if(t.indexOf('error-')===0) cands.push(t.substring(6));
      for(var i=0;i<cands.length;i++)
        if(CREW_KINDS[cands[i]]) return cands[i];
    }catch(e){}
    return null;
  }

  /* Crew throttle state: per-kind rolling send windows and the
     last-sent stamp of each (kind, message) pair for dedupe.
     crewDropped counts every report the gate turned away, and
     status() exposes it — the cap is a flood guard, not a
     silent filter. */
  var crewWindow = {};     // kind -> [timestamps sent]
  var crewSeen = {};       // kind + '\n' + message -> last sent ts
  var crewDropped = 0;     // reports dropped by the crew gate
  var CREW_WINDOW_MS = 10*60*1000;   // rolling window
  var CREW_MAX_PER_WINDOW = 10;      // per kind per window
  var CREW_DEDUPE_MS = 10*60*1000;   // identical message resend gap

  /* True when a report may pass. Non-crew reports always pass.
     Crew reports pass when the (kind, message) pair hasn't been
     sent inside the dedupe gap AND the kind is under its
     per-window cap. */
  function crewGatePass(type, details){
    var kind = crewKindOf(type, details);
    if(!kind) return true;
    var now = Date.now();
    var msg = '';
    try{
      if(details && typeof details==='object' &&
         typeof details.message==='string') msg = details.message;
      else if(typeof details==='string') msg = details;
    }catch(e){}
    if(msg){
      var key = kind+'\n'+msg;
      var last = crewSeen[key];
      if(last && (now-last) < CREW_DEDUPE_MS){ crewDropped++; return false; }
      crewSeen[key] = now;
      /* Keep the dedupe map bounded: when it grows large, drop
         entries older than the dedupe gap (they can no longer
         suppress anything). */
      try{
        var keys = Object.keys(crewSeen);
        if(keys.length > 400){
          for(var i=0;i<keys.length;i++)
            if(now-(crewSeen[keys[i]]||0) >= CREW_DEDUPE_MS)
              delete crewSeen[keys[i]];
        }
      }catch(e){}
    }
    var arr = crewWindow[kind] || (crewWindow[kind] = []);
    while(arr.length && (now-arr[0]) > CREW_WINDOW_MS) arr.shift();
    if(arr.length >= CREW_MAX_PER_WINDOW){ crewDropped++; return false; }
    arr.push(now);
    return true;
  }

  /* Delivery-defect reports queued this session (the stock
     delivery layer's defect reports and the vehicle library's
     load-failure reports ride this same queue under their own
     types). Counted here — the sender counting its own queue,
     like reportsQueuedTotal — for the telemetry block's
     file-loading section. */
  var deliveryReportsQueued = 0;

  /* ---------- telemetry (2026-10-28) ----------

     The standard telemetry block attached to perf reports and
     the exit/session report (see queueReport /
     sessionReportDetails). Every value is read live from the
     system that owns it; absent sources are omitted, never
     estimated. Never throws. */
  function telemetryBlock(){
    var t = {};
    /* Performance: PerfBudget's own counters (fps now, session
       band, level + change count, manual override) plus the
       governor values actually published for other systems. */
    try{
      if(typeof window!=='undefined' && window.PerfBudget){
        var pb = window.PerfBudget;
        if(typeof pb.getTelemetry==='function'){
          var pt = pb.getTelemetry();
          if(pt && typeof pt==='object') t.perf = pt;
        } else {
          t.perf = {
            fps: (typeof pb.getFps==='function' ? pb.getFps() : null),
            level: (typeof pb.getLevel==='function' ? pb.getLevel() : null),
            levelLabel: (typeof pb.getLevelLabel==='function' ?
                         pb.getLevelLabel() : null)
          };
        }
      }
    }catch(e){}
    /* File loading: the delivery layers publish their startup
       results on window (index.html stores them); the vehicle
       library publishes ready/failed on itself. */
    try{
      var fl = {};
      var sr = (typeof window!=='undefined') ?
        window.__STOCKDELIVERY_RESULT : null;
      if(sr && typeof sr==='object'){
        fl.stockDelivery = { status: String(sr.status||''),
          error: (typeof sr.error==='string' ? sr.error : null) };
      }
      var mr = (typeof window!=='undefined') ?
        window.__MAPDELIVERY_RESULT : null;
      if(mr && typeof mr==='object'){
        fl.mapDelivery = { status: String(mr.status||'') };
      }
      var vl = (typeof window!=='undefined') ? window.VehicleLibrary : null;
      if(vl && typeof vl==='object'){
        fl.vehicleLibrary = { ready: !!vl.ready, failed: !!vl.failed,
          types: 0 };
        try{ fl.vehicleLibrary.types = Object.keys(vl.types||{}).length; }
        catch(e){}
      }
      fl.deliveryReportsQueuedThisSession = deliveryReportsQueued;
      if(Object.keys(fl).length) t.fileLoading = fl;
    }catch(e){}
    /* Map mode: package vs legacy, whether package was
       requested, and the raw mapsrc signal (URL parameter,
       else the stored preference, else the registry default —
       read the same way map_registry.js reads it). */
    try{
      if(typeof window!=='undefined' && window.MapSystem){
        var ms = window.MapSystem;
        var src = 'default';
        try{
          var q = new URLSearchParams(window.location.search||'');
          if(q.get('mapsrc')) src = 'url:'+q.get('mapsrc');
          else if(window.localStorage){
            var s = window.localStorage.getItem('sa_mapsrc');
            if(s) src = 'stored:'+s;
          }
        }catch(e){}
        t.map = {
          mode: (typeof ms.packageActive==='function' &&
                 ms.packageActive()) ? 'package' : 'legacy',
          packageRequested: (typeof ms.packageModeRequested==='function' ?
                             !!ms.packageModeRequested() : null),
          mapsrc: src
        };
      }
    }catch(e){}
    return t;
  }

  /* One readable line summarising a telemetry block, for the
     session report's message head. '' when the block is empty. */
  function telemetryLine(t){
    try{
      if(!t || typeof t!=='object') return '';
      var bits = [];
      if(t.perf){
        var p = t.perf;
        var s = 'fps '+p.fps;
        if(p.fpsLow!=null && p.fpsHigh!=null)
          s += ' (session band '+p.fpsLow+'–'+p.fpsHigh+')';
        s += ', quality '+(p.levelLabel||p.level);
        if(typeof p.levelChanges==='number')
          s += ' after '+p.levelChanges+' change'+
               (p.levelChanges===1?'':'s');
        bits.push(s);
        var gov = [];
        if(p.trafficCap!=null) gov.push('trafficCap '+p.trafficCap);
        if(p.npcDist!=null) gov.push('npcDist '+p.npcDist);
        if(p.shadowDist!=null) gov.push('shadowDist '+p.shadowDist);
        if(gov.length) bits.push('governor '+gov.join(' · '));
      }
      if(t.fileLoading){
        var fl = t.fileLoading, fbits = [];
        if(fl.stockDelivery)
          fbits.push('stock '+(fl.stockDelivery.status||'?'));
        if(fl.mapDelivery)
          fbits.push('map files '+(fl.mapDelivery.status||'?'));
        if(fl.vehicleLibrary)
          fbits.push('vehicle library '+
            (fl.vehicleLibrary.failed ? 'FAILED (legacy bodies)' :
             fl.vehicleLibrary.ready ? 'ready' : 'not loaded'));
        if(fbits.length) bits.push('files: '+fbits.join(', '));
      }
      if(t.map) bits.push('map mode: '+t.map.mode);
      return bits.length ? ('Telemetry: '+bits.join('; ')) : '';
    }catch(e){ return ''; }
  }

  /* ---------- the queue ---------- */

  var queue = [];          // pending report objects
  var flushing = false;    // re-entrancy guard
  var lastFlush = null;    // ISO string of last successful send
  var lastError = null;    // last failure reason (for status())

  /* Queue one report. type: short slug-ish string. details: anything
     JSON-serializable (object preferred). */
  function queueReport(type, details){
    try{
      /* Crew gate (2026-10-28): crew/workforce reports are
         deduped + per-kind capped so a chatty crew log can't
         flood the form; everything else passes untouched. A
         gated-out report is counted (status().crewDropped),
         never queued. */
      if(!crewGatePass(type, details)) return;
      /* Session tracking: count every queued report and take a
         position/zone sample (queueing moments are natural,
         already-paid-for sample points). */
      reportsQueuedTotal++;
      /* Delivery-defect tally for the telemetry block (the
         sender counting its own queue — see deliveryReportsQueued). */
      var slugType = slug(type);
      if(slugType==='stock-delivery' || slugType==='vehicle-library')
        deliveryReportsQueued++;
      /* Telemetry (2026-10-28): perf reports carry the standard
         telemetry block, attached here at queue time so the
         values describe the moment the perf event fired. */
      if(slugType.indexOf('perf')===0 && details &&
         typeof details==='object' && !details.telemetry){
        try{ details.telemetry = telemetryBlock(); }catch(e){}
      }
      samplePlayer();
      var q = queue;
      q.push({
        type: slug(type),
        ts: new Date().toISOString(),
        session: sessionId,
        player: playerPos(),
        /* Zone snapshot at queue time (2026-10-25): the form's
           "Where in the game" answer should name where the event
           happened, not wherever the player stands at flush. */
        zone: zoneId(),
        details: details==null ? null : details
      });
      var cap = maxQueue();
      while(q.length > cap) q.shift();   // drop oldest, never grow unbounded
    }catch(e){ /* diagnostics never break the game */ }
  }

  /* ---------- auto-fill: report -> form answers ---------- */

  /* Map a queued report's kind (its slug) to the form's
     "Report type" radio choice. The submitted value must match
     one of Bug / Crash / Feedback / Other / Stats / Crew Report
     EXACTLY or Google silently drops just that one answer.
     Mapping (GOOGLE-FORM.md): crew/workforce kinds are Crew
     Reports (2026-10-28, checked before the crash rule so crew
     errors file as crew findings); crash/error kinds are
     crashes; player-initiated kinds are feedback; the game's
     automatic diagnostic kinds (stuck vehicles, perf, input
     diagnostics, explicit bug reports) are bugs; anything
     else is Other. */
  function formTypeFor(type){
    var t = String(type==null?'':type).toLowerCase();
    /* The exit/session report (kind 'session') maps to the
       form's "Stats" choice (added to the form 2026-10-25 as
       "Session"; renamed "Stats" the same day on Joshua's
       corrected word — his first tap, renaming "Other", was
       a mis-tap he reversed; the "Other" fallback below is
       unchanged). */
    if(t==='session' || t.indexOf('session')>=0) return 'Stats';
    /* Crew/workforce kinds (2026-10-28): the form's "Crew
       Report" choice (added 2026-10-28; a choice is a VALUE in
       the same type entry, so no entry code changed). Checked
       BEFORE the crash rule so a crew system's errors file as
       crew findings, not game crashes. */
    if(crewKindOf(t, null)) return 'Crew Report';
    if(t.indexOf('crash')>=0 || t.indexOf('error')>=0) return 'Crash';
    if(t.indexOf('feedback')>=0 || t.indexOf('manual')===0) return 'Feedback';
    if(t==='bug' || t.indexOf('inspector')>=0 || t.indexOf('stuck')>=0 ||
       t.indexOf('perf')>=0 || t.indexOf('diag')>=0) return 'Bug';
    return 'Other';
  }

  /* The street a report happened on, when the report itself
     carries one (some systems note the street in their details:
     `street`, `roadName`, `road`, or crashlog-style `near`).
     Returns '' when the report knows no street — the code never
     invents one. */
  function streetOf(details){
    try{
      if(details && typeof details==='object'){
        var keys = ['street','roadName','road','near','streetName'];
        for(var i=0;i<keys.length;i++){
          var v = details[keys[i]];
          if(typeof v==='string' && v.trim()) return v.trim();
        }
      }
    }catch(e){}
    return '';
  }

  /* The auto-filled "Where in the game" answer: the zone the
     report was queued in (snapshot), the player's position at
     queue time, and the street when the report carries one. */
  function whereString(item){
    var parts = [];
    var zone = item.zone || zoneId();
    if(zone) parts.push(zone.charAt(0).toUpperCase()+zone.slice(1));
    if(item.player && typeof item.player.x==='number' &&
       typeof item.player.z==='number')
      parts.push('x '+item.player.x+', z '+item.player.z);
    var street = streetOf(item.details);
    if(street) parts.push('near '+street);
    return parts.join(' · ');
  }

  /* The auto-filled "Device" answer: the label + platform the
     game already detects (deviceInfo). The user agent is NOT
     sent — label and platform identify the device class for
     triage without shipping a long fingerprint string. */
  function deviceString(info){
    info = info || deviceInfo();
    var parts = [];
    if(info.label) parts.push(info.label);
    if(info.platform) parts.push(info.platform);
    return parts.join(' · ') || 'unknown device';
  }

  /* A player name, ONLY when a report's details explicitly
     carry one (details.playerName). No in-game flow collects a
     name today — automatic and crew reports never carry one —
     so this is normally ''. NEVER derive a "name" from other
     detail fields: a building's or road's name is not a person. */
  function playerNameOf(item){
    try{
      var d = item.details;
      if(d && typeof d==='object' &&
         typeof d.playerName==='string' && d.playerName.trim())
        return d.playerName.trim();
    }catch(e){}
    return '';
  }

  /* Cap for the "What happened?" answer. A manual export can
     carry a very large details payload; the cap keeps one
     oversized answer from jeopardising the whole response.
     Truncation is marked in the text so a cut is never silent. */
  var FORM_MESSAGE_CAP = 30000;

  /* The "What happened?" answer. THE REPORT'S OWN MESSAGE
     RIDES FIRST (Joshua's principle: the player's words stay
     the readable head of the field); the folded diagnostics —
     type, timestamp, session, then the full details JSON —
     follow it, clearly after. Reports with no message of their
     own (pure machine notes) start straight at the diagnostics.
     Nothing the old bundle carried is lost: it all rides here. */
  function formMessageFor(item){
    var d = item.details;
    var head = '';
    try{
      if(d && typeof d==='object' && typeof d.message==='string')
        head = d.message;
      else if(typeof d==='string')
        head = d;
    }catch(e){ head = ''; }
    var lines = [];
    if(head) lines.push(head);
    lines.push('— — —');
    lines.push('type: '+item.type+' · time: '+item.ts+
               ' · session: '+item.session);
    if(d!=null){
      try{ lines.push(JSON.stringify(d)); }
      catch(e){ lines.push(String(d)); }
    }
    var out = lines.join('\n');
    if(out.length > FORM_MESSAGE_CAP)
      out = out.substring(0, FORM_MESSAGE_CAP)+'\n[truncated by sender]';
    return out;
  }

  /* Build the form body for ONE queued report: one entry per
     question, every game-known value filled by the code
     (type mapped, version live, where from the queue-time
     snapshot, device detected). The name entry is included
     only when a report actually carries a player name.
     Returns a URLSearchParams (fetch encodes it as
     application/x-www-form-urlencoded, what the form expects). */
  function formBodyFor(item, entries, devInfo){
    var params = new URLSearchParams();
    params.set(entries.type, formTypeFor(item.type));
    params.set(entries.message, formMessageFor(item));
    params.set(entries.version, gameVersionString());
    params.set(entries.where, whereString(item));
    params.set(entries.device, deviceString(devInfo));
    var nm = playerNameOf(item);
    if(nm) params.set(entries.name, nm);
    return params;
  }

  /* ---------- the exit/session report ---------- */

  /* The session report's details. The composed `message` leads
     with the DURATION (the headline fact), then the rest of the
     session statistics — so in the form's "What happened?"
     answer the stats are the readable head, ahead of the folded
     diagnostics formMessageFor appends. Device, game version
     and the exit position are NOT repeated here: they ride in
     their own auto-filled form fields. Only facts the code
     actually knows are included:
       - duration, from this sender's session clock;
       - distance travelled + zones visited, measured by
         samplePlayer from the game's player position / zone;
       - performance at exit (level label + fps) ONLY when
         window.PerfBudget exposes them;
       - the standard telemetry block (2026-10-28: fps band +
         quality changes + governor, file-loading state, map
         mode — see telemetryBlock) in the details, with its
         one-line summary in the message;
       - how many OTHER reports this session queued (counted
         before this report itself is queued).
     No player name is ever attached: session reports are
     automatic, like crash reports. */
  function sessionReportDetails(reason){
    samplePlayer();  // one final sample at exit
    var secs = sessionSeconds();
    var perfBits = [];
    try{
      if(typeof window!=='undefined' && window.PerfBudget){
        var pb = window.PerfBudget;
        if(typeof pb.getLevelLabel==='function'){
          var lbl = pb.getLevelLabel();
          if(typeof lbl==='string' && lbl) perfBits.push('level '+lbl);
        }
        if(typeof pb.getFps==='function'){
          var f = pb.getFps();
          if(typeof f==='number' && isFinite(f) && f>0)
            perfBits.push('~'+Math.round(f)+' fps');
        }
      }
    }catch(e){}
    var lines = [];
    lines.push('Played for '+durationText(secs)+' ('+secs+' seconds)');
    lines.push('Distance travelled: '+Math.round(distanceTravelledM)+
               ' m (game units)');
    lines.push('Zones visited: '+
      (zonesVisited.length ? zonesVisited.join(', ') : zoneId()));
    if(perfBits.length)
      lines.push('Performance at exit: '+perfBits.join(' · '));
    /* Screen size + the layout actually picked (2026-10-26):
       ui_layout_apply.js publishes __SA_LAYOUT_PICK — the measured
       visible size and which layout (per-size name / face / legacy)
       this device got. The seeded layout sizes are manufacturer
       numbers, not measurements; this line is how a real device's
       Stats report replaces the guess. Absent when the layout
       module never ran — the rest of the report is unchanged. */
    var layoutPick = null;
    try{
      var pk = (typeof window!=='undefined') ? window.__SA_LAYOUT_PICK : null;
      if(pk && pk.vw && pk.vh){
        var scr = 'Screen: '+pk.vw+'x'+pk.vh+' visible';
        if(pk.source==='size' && pk.key){
          scr += ' · layout: size "'+pk.key+'" ('+pk.width+'x'+pk.height+
                 (pk.exact ? ', exact match' : ', nearest') + ')';
        } else if(pk.source){
          scr += ' · layout: '+pk.source+(pk.key ? ' "'+pk.key+'"' : '');
        }
        lines.push(scr);
        layoutPick = { source: pk.source||null, key: pk.key||null,
          width: pk.width||null, height: pk.height||null,
          exact: !!pk.exact, visibleW: pk.vw, visibleH: pk.vh };
      }
    }catch(e){}
    /* Telemetry (2026-10-28): the standard block rides in the
       details, and one readable summary line joins the message
       head — so the Stats answer shows the tuning evidence
       (fps band, quality changes, governor, file-loading
       state, map mode) without opening the folded JSON. */
    var telem = null, telemText = '';
    try{
      telem = telemetryBlock();
      telemText = telemetryLine(telem);
    }catch(e){ telem = null; telemText = ''; }
    if(telemText) lines.push(telemText);
    lines.push('Other reports queued this session: '+reportsQueuedTotal);
    lines.push('Exit path: '+String(reason||'exit'));
    var details = {
      message: lines.join('\n'),
      sessionSeconds: secs,
      duration: durationText(secs),
      distanceTravelledM: Math.round(distanceTravelledM*10)/10,
      zonesVisited: zonesVisited.slice(),
      otherReportsQueuedThisSession: reportsQueuedTotal,
      exitReason: String(reason||'exit')
    };
    if(perfBits.length) details.perfAtExit = perfBits.join(' · ');
    if(layoutPick) details.layoutPick = layoutPick;
    if(telem && Object.keys(telem).length) details.telemetry = telem;
    return details;
  }

  /* Queue the ONE session report for this play session.
     Returns true only when this call actually queued it —
     every later call (second exit path, pagehide after an
     explicit exit, …) is a no-op, so exactly one session
     report ever leaves per session. */
  function queueSessionReport(reason){
    try{
      if(sessionReportQueued) return false;
      sessionReportQueued = true;
      queueReport('session', sessionReportDetails(reason));
      return true;
    }catch(e){ return false; }
  }

  /* The exit entry point, called by the game's exit funnel
     (exitGame() in index.html) and by the pagehide handler
     below: queue the session report (deduped) and flush the
     whole queue on the closing-safe path (sendBeacon first,
     fetch keepalive second — see flushViaForm). Background
     work only: it never blocks or visibly delays the close.
     Returns the flush promise. */
  function sessionExit(reason){
    try{ queueSessionReport(reason||'exit'); }catch(e){}
    return flush(true);
  }

  /* ---------- the form send (live path) ---------- */

  /* POST the queue to the Google Form: ONE form response per
     queued report. An item leaves the queue only when its own
     POST resolves; failures go back to the front of the queue
     and the next flush retries them (the bundle logic's
     keep-everything promise, per report). Returns a Promise
     for true only when EVERY queued report was handed to
     Google. Never rejects — failures land in lastError.
     keepalive: true for the page-hide send (with no-cors the
     browser cannot show us Google's reply, so a resolved send
     means Google accepted the delivery). On the keepalive path
     each report first tries navigator.sendBeacon — delivery
     the browser guarantees across page teardown — and falls
     back to the keepalive fetch when the beacon is missing or
     refuses the body. */
  function flushViaForm(keepalive){
    var url = formUrl();
    var entries = formEntries();
    if(!url || !entries){
      // Form destination unusable: stay silent, keep the queue.
      lastError = 'form not configured';
      return Promise.resolve(false);
    }
    flushing = true;
    var items = queue.splice(0, queue.length);
    var dev = deviceInfo();
    var jobs = items.map(function(item){
      var body;
      try{
        body = formBodyFor(item, entries, dev);
      }catch(e){
        return Promise.resolve({ ok:false, item:item, err:e });
      }
      /* Closing-safe delivery (exit flushes): navigator.sendBeacon
         exists precisely for "send this while the page goes away" —
         the browser queues it and delivers it even after teardown.
         A URLSearchParams body is sent as
         application/x-www-form-urlencoded, exactly what the form
         expects. sendBeacon answers synchronously: true means the
         browser took the report (handed off), false means it
         refused (e.g. body too large) and we fall through to the
         keepalive fetch below. Non-exit flushes never use the
         beacon: there, a failed fetch must keep the report queued
         for retry, and only fetch can tell us it failed. */
      if(keepalive){
        try{
          if(typeof navigator!=='undefined' &&
             typeof navigator.sendBeacon==='function'){
            var handed = false;
            try{ handed = navigator.sendBeacon(url, body); }catch(e){}
            if(handed) return Promise.resolve({ ok:true, item:item });
          }
        }catch(e){}
      }
      var opts;
      try{
        opts = {
          method: 'POST',
          body: body,
          mode: 'no-cors'
        };
        if(keepalive){ try{ opts.keepalive = true; }catch(e){} }
      }catch(e){
        return Promise.resolve({ ok:false, item:item, err:e });
      }
      var p;
      try{ p = fetch(url, opts); }
      catch(e){ p = Promise.reject(e); }
      return p.then(function(){ return { ok:true, item:item }; },
                    function(err){ return { ok:false, item:item, err:err }; });
    });
    return Promise.all(jobs).then(function(results){
      flushing = false;
      var failed = [];
      var firstErr = null;
      for(var i=0;i<results.length;i++){
        if(!results[i].ok){
          failed.push(results[i].item);
          if(!firstErr) firstErr = results[i].err;
        }
      }
      if(failed.length){
        // Put ONLY the failures back, at the FRONT; the cap
        // still applies. Sent reports are gone for good.
        try{
          queue = failed.concat(queue);
          var cap = maxQueue();
          while(queue.length > cap) queue.shift();
        }catch(e){}
        lastError = String((firstErr&&firstErr.message)||firstErr||
                           'form send failed');
        try{
          if(typeof Report!=='undefined' && Report.setSys)
            Report.setSys('githubReports',
              { lastFlush:lastFlush, queued:queue.length, ok:false,
                error:lastError, via:'form' });
        }catch(e2){}
        return false;
      }
      lastFlush = new Date().toISOString();
      lastError = null;
      try{
        if(typeof Report!=='undefined' && Report.setSys)
          Report.setSys('githubReports',
            { lastFlush:lastFlush, queued:queue.length, ok:true,
              via:'form' });
      }catch(e){}
      return true;
    });
  }

  /* ---------- the relay send (RETIRED fallback) ---------- */

  /* POST the whole queue to the relay as ONE JSON bundle.
     Kept unchanged from the relay edition as an unused
     fallback: flush() reaches this only when the form
     address is empty AND a relay address is filled in.
     Returns a Promise. Never rejects — failures are recorded
     in lastError and the queue is kept whole for the next
     retry. keepalive: true for the page-hide send. */
  function flushViaRelay(keepalive){
    var url = relayUrl();
    if(!url){
      // Relay not set up: stay silent, keep every report queued.
      lastError = 'relay not configured';
      return Promise.resolve(false);
    }
    flushing = true;

    var items = queue.splice(0, queue.length);
    var bundle;
    try{
      bundle = JSON.stringify({
        clientTag: clientTag(),
        app: 'Surviving Adamsville',
        repo: String(cfg().repo || 'kingmarkarnold-code/adamsville-play'),
        sentAt: new Date().toISOString(),
        bundleStamp: fileTs(),
        session: sessionId,
        device: deviceInfo(),
        count: items.length,
        reports: items
      });
    }catch(e){
      // Could not even build the bundle: put the reports back.
      queue = items.concat(queue);
      flushing = false;
      lastError = 'bundle serialize failed';
      return Promise.resolve(false);
    }

    var opts = {
      method: 'POST',
      // text/plain + no-cors: the only combination an Apps Script
      // web app accepts from a browser without a CORS preflight
      // (which Apps Script cannot answer). Body is still JSON text.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: bundle,
      mode: 'no-cors'
    };
    if(keepalive){ try{ opts.keepalive = true; }catch(e){} }

    var sent;
    try{
      sent = fetch(url, opts);
    }catch(e){
      sent = Promise.reject(e);
    }
    return sent.then(function(){
      flushing = false;
      lastFlush = new Date().toISOString();
      lastError = null;
      try{
        if(typeof Report!=='undefined' && Report.setSys)
          Report.setSys('githubReports',
            { lastFlush:lastFlush, queued:queue.length, ok:true,
              via:'relay' });
      }catch(e){}
      return true;
    }).catch(function(err){
      flushing = false;
      // Send failed: put the batch back at the FRONT so nothing is
      // lost; the next flush retries. Cap still applies.
      try{
        queue = items.concat(queue);
        var cap = maxQueue();
        while(queue.length > cap) queue.shift();
      }catch(e2){}
      lastError = String((err&&err.message)||err);
      try{
        if(typeof Report!=='undefined' && Report.setSys)
          Report.setSys('githubReports',
            { lastFlush:lastFlush, queued:queue.length, ok:false,
              error:lastError, via:'relay' });
      }catch(e3){}
      return false;
    });
  }

  /* ---------- flush: dispatch to the live destination ---------- */

  /* Send the queue now. The Google Form is the destination
     whenever its address is set (the normal, live case since
     2026-10-25); the retired relay bundle send runs only when
     the form address is empty AND a relay address exists.
     With neither configured the queue simply waits — silent,
     nothing lost. Guards (re-entrancy, enabled, empty queue)
     live here so both paths share them. */
  function flush(keepalive){
    /* Boot-stall holding queue (2026-10-25): drain on EVERY flush, not
       only in start() — start() is bound to the window load event, whose
       timing against this module's deferred injection is not guaranteed,
       and a parked stall record must never wait on that luck. */
    try{ drainPendingBootReports(); }catch(e){}
    if(flushing) return Promise.resolve(false);
    if(!isEnabled()) return Promise.resolve(false);
    if(queue.length===0) return Promise.resolve(false);
    if(formUrl()) return flushViaForm(keepalive);
    if(relayUrl()) return flushViaRelay(keepalive);
    lastError = 'reports not configured';
    return Promise.resolve(false);
  }

  /* ---------- hook into the existing Report system ---------- */

  function hookReport(){
    try{
      if(typeof Report==='undefined' || !Report || hookReport.done) return;
      hookReport.done = true;
      // Wrap note(): every panel log also queues a report.
      if(typeof Report.note==='function'){
        var origNote = Report.note;
        Report.note = function(category, msgOrObj){
          try{
            var cat = String(category==null?'note':category);
            var details = (msgOrObj && typeof msgOrObj==='object')
              ? msgOrObj : { message: String(msgOrObj==null?'':msgOrObj) };
            details._category = cat;
            // Map known categories to the report-type names
            // Joshua asked for.
            var type = cat;
            if(cat==='crewinspector') type = 'inspector-finding';
            queueReport(type, details);
          }catch(e){}
          return origNote.apply(Report, arguments);
        };
      }
      // Wrap noteError(): errors become error-<category> reports.
      if(typeof Report.noteError==='function'){
        var origErr = Report.noteError;
        Report.noteError = function(category, code, msg){
          try{
            queueReport('error-'+slug(category), {
              code: String(code==null?'':code),
              message: String(msg==null?'':msg),
              /* The originating system, named like note()'s
                 _category (2026-10-28): the crew gate/mapping
                 reads it, and the folded diagnostics name the
                 system that errored. */
              _category: String(category==null?'':category)
            });
          }catch(e){}
          return origErr.apply(Report, arguments);
        };
      }
      // window.onerror safety net: uncaught exceptions become
      // crash reports (only one listener added here; others coexist).
      if(typeof window!=='undefined' && window.addEventListener){
        window.addEventListener('error', function(ev){
          try{
            queueReport('error-crash', {
              message: String((ev&&ev.message)||'unknown'),
              file: String((ev&&ev.filename)||''),
              line: (ev&&ev.lineno)||null, col: (ev&&ev.colno)||null
            });
          }catch(e){}
        });
      }
    }catch(e){ /* never break the game */ }
  }

  /* ---------- lifecycle ---------- */

  var timerId = null;

  /* Boot-stall holding queue (2026-10-25): index.html's loader watchdog
     is armed from the first second of boot — long before this module is
     loaded — so when it fires it records the stall into a localStorage
     holding queue ('sa_pending_reports_v1'). Drain those records into
     the real queue here; they then ride the ordinary flush to the form,
     so a hang reports itself even when the tab died before gameplay. */
  function drainPendingBootReports(){
    try{
      if(typeof localStorage==='undefined') return;
      var raw = localStorage.getItem('sa_pending_reports_v1');
      if(!raw) return;
      localStorage.removeItem('sa_pending_reports_v1');
      var arr = JSON.parse(raw);
      if(!arr || !arr.length) return;
      for(var i=0;i<arr.length;i++){
        var rec = arr[i];
        if(rec && rec.details) queueReport(rec.type || 'crash', rec.details);
      }
    }catch(e){}
  }

  function start(){
    drainPendingBootReports();
    hookReport();
    // If Report isn't defined yet (script order), retry shortly.
    if(!hookReport.done){
      var tries = 0;
      var iv = setInterval(function(){
        hookReport();
        if(hookReport.done || ++tries > 20) clearInterval(iv);
      }, 500);
    }
    try{
      timerId = setInterval(function(){
        /* Sample the player's travel between flushes so the
           exit report's distance/zones stay honest even in a
           session where nothing else was ever queued. */
        samplePlayer();
        flush(false);
      }, flushMs());
    }catch(e){}
    // Final flush when the page hides or closes. keepalive lets the
    // POST survive teardown in modern browsers.
    try{
      var finalFlush = function(){ flush(true); };
      if(typeof document!=='undefined'){
        document.addEventListener('visibilitychange', function(){
          if(document.visibilityState==='hidden') finalFlush();
        });
      }
      if(typeof window!=='undefined'){
        /* pagehide = the page is going away (tab close, navigation
           away, app teardown): the WEB exit path. Queue the ONE
           session report first (reason 'page-close'; a no-op if an
           explicit exit already queued it), then flush everything
           on the closing-safe path. A plain tab-hide above does NOT
           queue a session report — hiding is not exiting. */
        window.addEventListener('pagehide', function(){
          sessionExit('page-close');
        });
      }
    }catch(e){}
    try{
      if(typeof Report!=='undefined' && Report.setSys)
        Report.setSys('githubReports',
          { ok:null, queued:0,
            note:'report sender armed ('+(formUrl() ? 'form' : 'relay')+')' });
    }catch(e){}
  }

  /* Run after the current script turn so window.Report (defined in an
     earlier inline block of index.html) is guaranteed present. */
  try{
    if(typeof window!=='undefined' && window.addEventListener){
      /* If load already fired (deferred injection can land after it),
         start immediately — a listener for a past event never runs,
         which would silently disarm the flush timer, the pagehide exit
         flush AND the boot-stall drain above. */
      if(typeof document!=='undefined' && document.readyState==='complete')
        start();
      else
        window.addEventListener('load', start);
    }
    else
      start();
  }catch(e){ try{ start(); }catch(e2){} }

  /* ---------- public API ---------- */
  return {
    queue: queueReport,
    flush: function(){ return flush(false); },
    /* Exit/session reporting (2026-10-25): sessionExit queues
       the ONE session report (deduped) and flushes on the
       closing-safe path — exitGame() in index.html calls it,
       and the pagehide handler above calls it for web closes.
       queueSessionReport is exposed for tests/diagnostics. */
    sessionExit: sessionExit,
    queueSessionReport: queueSessionReport,
    status: function(){
      var configured = isConfigured();
      return {
        enabled: isEnabled(),
        configured: configured,
        /* The live destination (2026-10-25): the Google Form. */
        hasForm: !!formUrl(),
        formUrl: formUrl(),
        /* The retired relay fallback: configured only if its
           address is filled in (it is "" today). Previously
           this field reported `configured`; it now reports the
           relay itself, accurately — nothing in the game reads
           hasRelay to decide whether sending works (callers
           use hasToken below), so the correction is safe. */
        hasRelay: !!relayUrl(),
        relayUrl: relayUrl(),
        /* Legacy alias for older callers (index.html's "Send
           Reports to Mollie" button checks this before sending).
           It means "a sending path is configured" — today the
           form. There is NO token in the game any more. */
        hasToken: configured,
        queued: queue.length,
        /* Session-report state (2026-10-25): whether this
           session's ONE exit report has been queued yet, and
           how long the session has run so far. */
        sessionReportQueued: sessionReportQueued,
        sessionSeconds: sessionSeconds(),
        /* Crew gate state (2026-10-28): how many crew reports
           the dedupe/cap gate turned away this session. */
        crewDropped: crewDropped,
        lastFlush: lastFlush,
        lastError: lastError
      };
    }
  };
})();
