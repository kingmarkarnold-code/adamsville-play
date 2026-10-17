/* ============================================================
   SURVIVING ADAMSVILLE — GitHub report uploader
   FILE: github_reports.js
   ------------------------------------------------------------
   WHAT THIS DOES:
   Sends the game's diagnostic reports to the GitHub repo as
   timestamped JSON files in the `reports/` folder, so Joshua
   (and Mollie) can see inspector findings, stuck vehicles,
   errors, and performance warnings without needing the phone
   the game ran on.

   HOW IT WORKS:
   * All existing Report.note() / Report.noteError() calls are
     wrapped automatically — every system that already logs to
     the Report panel also queues a GitHub-bound report. No
     changes to other files needed.
   * Reports sit in a memory queue. Every flushIntervalMs
     (default 5 minutes, see github-config.js) the queue is
     uploaded in ONE batch: reports are grouped by type and each
     group becomes a single file, e.g.
       reports/2026-10-11-003012-inspector-finding.json
     so a busy 5 minutes costs ~4 API calls, not hundreds.
   * A final flush runs when the page hides/closes
     (pagehide + visibilitychange), using fetch keepalive so the
     upload survives page teardown.
   * The GitHub token comes from github-config.js
     (window.GITHUB_CONFIG.token) or from browser storage via
     GitHubReports.setToken() — storage wins. No token = no
     uploads, silently. Nothing here ever prompts or throws.

   SECURITY:
   * The token is sent ONLY to https://api.github.com, never
     anywhere else. It is never logged or written to a file.
   * Anyone who downloads the game can read a token pasted into
     github-config.js — that is why Joshua's token must be a
     fine-grained token limited to Contents:read/write on ONLY
     the adamsville-play repo (see github-config.js).
   * Every network call is wrapped in try/catch. Diagnostics
     must never break the game — Joshua's standing rule.

   API:
   * GitHubReports.queue(type, details) — queue one report now.
   * GitHubReports.flush() — upload the queue immediately.
   * GitHubReports.setToken(t) — store a token in this browser
     only (localStorage). Returns true on success.
   * GitHubReports.clearToken() — forget the stored token.
   * GitHubReports.status() — {enabled,hasToken,queued,
     lastFlush,lastError} for debugging.
   ------------------------------------------------------------
   Documentation comments are required on all game code — Joshua's
   standing rule. This file follows it.
   ============================================================ */
window.GitHubReports = (function(){
  'use strict';

  /* ---------- small utilities ---------- */

  function pad(n){ return (n<10?'0':'')+n; }

  /* Local-time stamp for filenames: 2026-10-11-003012 */
  function fileTs(d){
    d = d || new Date();
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+
      '-'+pad(d.getHours())+pad(d.getMinutes())+pad(d.getSeconds());
  }

  /* Keep filenames safe: lowercase, dashes, no weird chars. */
  function slug(s){
    s = String(s==null?'report':s).toLowerCase().replace(/[^a-z0-9]+/g,'-')
      .replace(/^-+|-+$/g,'');
    return s || 'report';
  }

  /* UTF-8 safe base64 for the Contents API. */
  function b64encodeUtf8(str){
    try{
      if(typeof btoa!=='undefined')
        return btoa(unescape(encodeURIComponent(str)));
    }catch(e){}
    return null;
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

  /* ---------- configuration / token ---------- */

  function cfg(){
    try{
      if(typeof window!=='undefined' && window.GITHUB_CONFIG)
        return window.GITHUB_CONFIG;
    }catch(e){}
    return {};
  }

  /* Token resolution order: browser storage first (private),
     github-config.js second. Empty string = not configured. */
  function getToken(){
    try{
      var t = null;
      if(typeof localStorage!=='undefined')
        t = localStorage.getItem('sa_github_token');
      if(t) return t;
      var c = cfg();
      if(c && c.token) return String(c.token);
    }catch(e){}
    return '';
  }

  function isEnabled(){
    try{ return cfg().enabled !== false; }catch(e){ return true; }
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
  var lastFlush = null;    // ISO string of last successful flush
  var lastError = null;    // last failure reason (for status())
  var flushSeq = 0;        // guarantees unique filenames

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

  /* ---------- GitHub Contents API ---------- */

  function apiPut(path, contentB64, message, keepalive){
    var c = cfg();
    var repo = c.repo || 'kingmarkarnold-code/adamsville-play';
    var url = 'https://api.github.com/repos/'+repo+'/contents/'+path;
    var headers = {
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'Authorization': 'Bearer '+getToken()
    };
    var body = JSON.stringify({
      message: message,
      content: contentB64
    });
    var opts = { method:'PUT', headers:headers, body:body };
    if(keepalive){ try{ opts.keepalive = true; }catch(e){} }
    return fetch(url, opts).then(function(resp){
      if(!resp.ok)
        throw new Error('GitHub API '+resp.status);
      return resp.json();
    });
  }

  /* Upload the whole queue, grouped by type: one file per type per
     flush. Returns a Promise. Never rejects — failures are recorded
     in lastError and the queue is kept for the next retry. */
  function flush(keepalive){
    if(flushing) return Promise.resolve(false);
    if(!isEnabled()) return Promise.resolve(false);
    if(!getToken()) return Promise.resolve(false);  // not configured: silent
    if(queue.length===0) return Promise.resolve(false);
    flushing = true;

    var groups = {};   // type -> [reports]
    var items = queue.splice(0, queue.length);
    for(var i=0;i<items.length;i++){
      var t = items[i].type || 'report';
      (groups[t] = groups[t] || []).push(items[i]);
    }

    var c = cfg();
    var dir = (c.reportsDir || 'reports').replace(/^\/+|\/+$/g,'') || 'reports';
    var stamp = fileTs();
    flushSeq++;
    var seq = flushSeq;
    var types = Object.keys(groups);
    var chain = Promise.resolve(true);

    types.forEach(function(t, idx){
      chain = chain.then(function(){
        var payload;
        try{
          payload = JSON.stringify({
            app: 'Surviving Adamsville',
            reportType: t,
            exportedAt: new Date().toISOString(),
            session: sessionId,
            count: groups[t].length,
            reports: groups[t]
          });
        }catch(e){
          payload = '{"error":"serialize failed"}';
        }
        if(payload.length > 50000)   // sanity cap per file
          payload = payload.substring(0,50000)+'...[truncated]';
        var b64 = b64encodeUtf8(payload);
        if(!b64) throw new Error('base64 encode failed');
        var path = dir+'/'+stamp+'-'+t+(seq>1?'-'+seq:'')+
          (idx>0?'-'+idx:'')+'.json';
        return apiPut(path, b64,
          'Game report: '+t+' ('+groups[t].length+') @ '+stamp,
          keepalive).then(function(){ return true; });
      });
    });

    return chain.then(function(){
      flushing = false;
      lastFlush = new Date().toISOString();
      lastError = null;
      try{
        if(typeof Report!=='undefined' && Report.setSys)
          Report.setSys('githubReports',
            { lastFlush:lastFlush, queued:queue.length, ok:true });
      }catch(e){}
      return true;
    }).catch(function(err){
      flushing = false;
      // Put the batch back at the FRONT so nothing is lost; the
      // next flush retries. Cap still applies.
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
              error:lastError });
      }catch(e3){}
      return false;
    });
  }

  /* ---------- hook into the existing Report system ---------- */

  function hookReport(){
    try{
      if(typeof Report==='undefined' || !Report || hookReport.done) return;
      hookReport.done = true;
      // Wrap note(): every panel log also queues a GitHub report.
      if(typeof Report.note==='function'){
        var origNote = Report.note;
        Report.note = function(category, msgOrObj){
          try{
            var cat = String(category==null?'note':category);
            var details = (msgOrObj && typeof msgOrObj==='object')
              ? msgOrObj : { message: String(msgOrObj==null?'':msgOrObj) };
            details._category = cat;
            // Map known categories to the report-type filenames
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
    // PUT survive teardown in modern browsers.
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
          { ok:null, queued:0, note:'uploader armed' });
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
    setToken: function(t){
      try{
        if(typeof localStorage==='undefined') return false;
        t = String(t||'').trim();
        if(!t) return false;
        localStorage.setItem('sa_github_token', t);
        lastError = null;
        return true;
      }catch(e){ return false; }
    },
    clearToken: function(){
      try{
        if(typeof localStorage!=='undefined')
          localStorage.removeItem('sa_github_token');
        return true;
      }catch(e){ return false; }
    },
    status: function(){
      return {
        enabled: isEnabled(),
        hasToken: !!getToken(),
        queued: queue.length,
        lastFlush: lastFlush,
        lastError: lastError
      };
    }
  };
})();
