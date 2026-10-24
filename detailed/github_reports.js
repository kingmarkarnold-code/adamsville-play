/* ============================================================
   SURVIVING ADAMSVILLE — Report sender (relay edition)
   FILE: github_reports.js
   ------------------------------------------------------------
   WHAT THIS DOES:
   Sends the game's diagnostic reports to Joshua (via Mollie)
   so inspector findings, stuck vehicles, errors, and
   performance warnings can be seen without needing the phone
   the game ran on. Reports still land as files in the GitHub
   repo's `reports/` folder — the relay puts them there.

   HOW IT WORKS (Joshua's ruling, 2026-10-24 — NO KEY IN GAME):
   * Players must never need a GitHub key, so the game no
     longer talks to GitHub directly. It POSTs each batch of
     reports as plain JSON to ONE relay address
     (GITHUB_CONFIG.REPORT_RELAY_URL in github-config.js).
     The relay is a small Google Apps Script web app running
     under Joshua's Google account; the GitHub key lives on
     the relay's side only (its private Script Properties)
     and is never sent to, or stored in, the game.
   * The direct-to-GitHub token upload that used to live in
     this file was REMOVED on 2026-10-24 (its token was dead,
     and any working key shipped in a public game file can be
     read by anyone who downloads the game). There is no token
     code left here on purpose — do not re-add one.

   QUEUEING (unchanged behaviour):
   * All existing Report.note() / Report.noteError() calls are
     wrapped automatically — every system that already logs to
     the Report panel also queues a report here. No changes to
     other files needed.
   * Reports sit in a memory queue. Every flushIntervalMs
     (default 5 minutes, see github-config.js) the whole queue
     is sent in ONE bundle: one POST, and the relay writes one
     file per bundle, e.g.
       reports/2026-10-24-153012-a17-5g.json
   * A final flush runs when the page hides/closes
     (pagehide + visibilitychange) with fetch keepalive, so
     the send is attempted even as the page tears down.
   * If the relay address is not set yet, or a send fails, the
     reports STAY in the queue and the next flush retries —
     and the manual/export behaviour (Report.shareJson etc.)
     is untouched, so no report is lost because the relay is
     absent. The only way a queued report is dropped is the
     maxQueue cap (oldest first), exactly as before.

   ONE HONEST LIMIT (browser security rules, not a bug):
   * Apps Script web apps do not answer browser "CORS"
     permission checks, so the game sends with
     Content-Type text/plain and fetch mode "no-cors". That
     means the browser delivers the bundle to the relay but
     will not let the game READ the relay's reply. A resolved
     send therefore means "Google accepted the delivery",
     not "the relay confirmed the file landed". Failures we
     CAN see (no network, relay address missing) keep the
     queue intact. Mollie verifies real arrivals by watching
     the repo's reports/ folder.

   SECURITY:
   * No key, token, or credential exists in this file or in
     github-config.js. The only thing sent besides the reports
     is a client tag (REPORT_CLIENT_TAG) which is NOT a secret
     — the relay uses it only to ignore obvious junk posts.
   * Every network call is wrapped in try/catch. Diagnostics
     must never break the game — Joshua's standing rule.

   API:
   * GitHubReports.queue(type, details) — queue one report now.
   * GitHubReports.flush() — send the queue immediately.
     Returns a Promise for true (handed to the relay) / false
     (not configured, empty queue, or send failed — queue kept).
   * GitHubReports.status() — {enabled, configured, hasRelay,
     hasToken, queued, lastFlush, lastError}. `hasToken` is a
     LEGACY ALIAS kept only so older callers (the "Send
     Reports to Mollie" button in index.html) keep working:
     it now reports whether a sending path is configured
     (the relay), NOT whether a token exists. No token exists.
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

  /* The relay address, "" until Joshua's one-time setup is done
     and Mollie pastes the deployed /exec URL into the config. */
  function relayUrl(){
    try{
      var u = cfg().REPORT_RELAY_URL;
      if(typeof u==='string' && /^https:\/\//i.test(u.trim()))
        return u.trim();
    }catch(e){}
    return '';
  }

  function clientTag(){
    try{
      var t = cfg().REPORT_CLIENT_TAG;
      if(typeof t==='string' && t) return t;
    }catch(e){}
    return 'surviving-adamsville-game';
  }

  /* A sending path exists only when sending is enabled AND the
     relay address has been filled in. */
  function isConfigured(){
    return isEnabled() && !!relayUrl();
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

  /* ---------- the queue ---------- */

  var queue = [];          // pending report objects
  var flushing = false;    // re-entrancy guard
  var lastFlush = null;    // ISO string of last successful send
  var lastError = null;    // last failure reason (for status())

  /* Queue one report. type: short slug-ish string. details: anything
     JSON-serializable (object preferred). */
  function queueReport(type, details){
    try{
      var q = queue;
      q.push({
        type: slug(type),
        ts: new Date().toISOString(),
        session: sessionId,
        player: playerPos(),
        details: details==null ? null : details
      });
      var cap = maxQueue();
      while(q.length > cap) q.shift();   // drop oldest, never grow unbounded
    }catch(e){ /* diagnostics never break the game */ }
  }

  /* ---------- the relay send ---------- */

  /* POST the whole queue to the relay as ONE JSON bundle.
     Returns a Promise. Never rejects — failures are recorded in
     lastError and the queue is kept whole for the next retry.
     keepalive: true for the page-hide send (see header: with
     no-cors the browser cannot show us the relay's reply, so a
     resolved send means Google accepted the delivery). */
  function flush(keepalive){
    if(flushing) return Promise.resolve(false);
    if(!isEnabled()) return Promise.resolve(false);
    if(queue.length===0) return Promise.resolve(false);
    var url = relayUrl();
    if(!url){
      // Relay not set up yet: stay silent, keep every report queued.
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
              message: String(msg==null?'':msg)
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

  function start(){
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
      timerId = setInterval(function(){ flush(false); }, flushMs());
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
        window.addEventListener('pagehide', finalFlush);
      }
    }catch(e){}
    try{
      if(typeof Report!=='undefined' && Report.setSys)
        Report.setSys('githubReports',
          { ok:null, queued:0, note:'report sender armed (relay)' });
    }catch(e){}
  }

  /* Run after the current script turn so window.Report (defined in an
     earlier inline block of index.html) is guaranteed present. */
  try{
    if(typeof window!=='undefined' && window.addEventListener)
      window.addEventListener('load', start);
    else
      start();
  }catch(e){ try{ start(); }catch(e2){} }

  /* ---------- public API ---------- */
  return {
    queue: queueReport,
    flush: function(){ return flush(false); },
    status: function(){
      var configured = isConfigured();
      return {
        enabled: isEnabled(),
        configured: configured,
        hasRelay: configured,
        relayUrl: relayUrl(),
        /* Legacy alias for older callers (index.html's "Send
           Reports to Mollie" button checks this before sending).
           It now means "a sending path is configured" — the
           relay. There is NO token in the game any more. */
        hasToken: configured,
        queued: queue.length,
        lastFlush: lastFlush,
        lastError: lastError
      };
    }
  };
})();
