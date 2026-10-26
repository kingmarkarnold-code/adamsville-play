/* ============================================================
   SURVIVING ADAMSVILLE — Crash & error log (crashlog.js)
   ------------------------------------------------------------
   JOSHUA'S FAILURE PHILOSOPHY (2026-10-17, his design):
   Silent fail-open is BANNED in this game. When something breaks,
   the game must (1) WRITE IT DOWN, (2) TELL THE TESTER, and
   (3) only then continue — deliberately, never silently. One play
   session should harvest MANY errors, not stop at the first.

   WHAT THIS MODULE DOES:
   * Keeps ONE growing markdown log for the whole game:
       reports/crash-log.md   (in the adamsville-play repo)
     Every entry is headed by WHO generated it + WHAT it is, and
     records what happened, the error type, where it broke, and
     what the game did about it. Text/markdown so the file stays
     small and Joshua + Mollie read the SAME facts.
   * Entries are queued in localStorage first, then uploaded in
     one batch through the game's existing upload configuration
     (window.GITHUB_CONFIG in github-config.js — same repo, same
     reports/ folder, same token as github_reports.js). Failed
     uploads stay queued and retry on the next launch.
   * CRITICAL WINDOW: for big failures (e.g. the map downloaded
     and verified but the buildings did not spawn) it shows a
     PASSABLE window — never a hard stop — with error-specific
     guided options for the designer-tester ("Continue exploring"
     vs "Reload and try again"). The problem is written to the
     log BEFORE the tester chooses; the choice is logged too.
   * COLLISION DIAGNOSTICS (Joshua's idea): when the player bumps
     something — on foot or driving — a small notice names what
     was hit ("a commercial building near Cascade Road
     Southwest"). An invisible-but-solid object names itself the
     same way, and the bump is filed to the log.
   * INSTRUMENTED SEAMS (via the SA_CRASH early buffer defined in
     index.html, plus hooks installed here): zone-file load
     failures, road-grid build, building spawn, traffic spawn,
     uncaught errors, and rejected promises. Load-step failures
     the old loader only whispered about are drained and logged.

   ACTIVATION: uploads need a valid token in github-config.js
   (or GitHubReports.setToken()). Without one, everything still
   works — entries just wait in the local queue. Nothing in this
   file ever throws: a broken crash log must not break the game.
   ------------------------------------------------------------
   Documentation comments are required on all game code —
   Joshua's standing rule. This file follows it.
   ============================================================ */
window.CrashLog = (function(){
  'use strict';

  /* ================= small safe helpers ================= */

  function pad(n){ return (n<10?'0':'')+n; }

  function nowIso(){ try{ return new Date().toISOString(); }catch(e){ return ''; } }

  /* Human stamp for entry headings: 2026-10-17 16:42:03 (local). */
  function headStamp(d){
    d = d || new Date();
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+
      ' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
  }

  function ls(){
    try{
      if (typeof window!=='undefined' && window.localStorage) return window.localStorage;
      if (typeof localStorage!=='undefined') return localStorage;
    }catch(e){}
    return null;
  }

  /* UTF-8 safe base64 (same trick as github_reports.js). */
  function b64encodeUtf8(str){
    try{
      if (typeof btoa!=='undefined') return btoa(unescape(encodeURIComponent(str)));
    }catch(e){}
    return null;
  }
  function b64decodeUtf8(b64){
    try{
      if (typeof atob!=='undefined')
        return decodeURIComponent(escape(atob(String(b64).replace(/\s+/g,''))));
    }catch(e){}
    return null;
  }

  function fetchFn(){
    try{
      if (typeof window!=='undefined' && window.fetch) return window.fetch;
      if (typeof fetch!=='undefined') return fetch;
    }catch(e){}
    return null;
  }

  /* ================= configuration =================
     Reads the SAME config object as github_reports.js. */

  function cfg(){
    try{
      if (typeof window!=='undefined' && window.GITHUB_CONFIG) return window.GITHUB_CONFIG;
    }catch(e){}
    return {};
  }

  /* Token resolution order identical to GitHubReports: browser
     storage first (private), github-config.js second. */
  function getToken(){
    try{
      var store = ls();
      var t = store ? store.getItem('sa_github_token') : null;
      if (t) return t;
      var c = cfg();
      if (c && c.token) return String(c.token);
    }catch(e){}
    return '';
  }

  function logPath(){
    var c = cfg();
    var dir = (c.reportsDir || 'reports').replace(/^\/+|\/+$/g,'') || 'reports';
    return dir + '/crash-log.md';
  }

  function flushMs(){
    try{
      var ms = parseInt(cfg().flushIntervalMs, 10);
      if (ms >= 60000) return ms;
    }catch(e){}
    return 5*60*1000;
  }

  /* WHO generated the entries: the game, and which face of it. */
  var sessionId = 's'+Date.now().toString(36)+
    Math.floor(Math.random()*0xffffff).toString(36);

  function who(){
    var face = 'web player';
    try{
      if (typeof window!=='undefined' &&
          (window.MapDownloadBridge || window.Capacitor)) face = 'APK';
    }catch(e){}
    return 'Surviving Adamsville game ('+face+')';
  }

  function uiVer(){
    try{
      if (typeof window!=='undefined' && window.__UIVER) return String(window.__UIVER);
    }catch(e){}
    return 'unknown';
  }

  function zoneId(){
    try{
      if (typeof window!=='undefined'){
        if (window.__ZONE_META && window.__ZONE_META.id) return String(window.__ZONE_META.id);
        var m = /[?&]zone=([a-z0-9_]+)/i.exec(window.location && window.location.search || '');
        if (m) return m[1];
      }
    }catch(e){}
    return 'adamsville';
  }

  /* ================= the entry model =================
     One entry = one markdown section. Fields follow Joshua's
     try/catch record: what happened, error type, breaking
     location, and the action taken on failure. */

  var LEVELS = { info:1, bump:1, warning:1, error:1, critical:1 };

  function makeEntry(level, code, what, data){
    data = data || {};
    return {
      ts: nowIso(),
      level: LEVELS[level] ? level : 'error',
      code: String(code || 'unspecified'),
      who: who(),
      what: String(what || 'Unspecified failure'),
      message: data.message ? String(data.message) : '',
      errorName: data.errorName ? String(data.errorName) : '',
      where: data.where ? String(data.where) : '',
      action: data.action ? String(data.action) :
        'logged; game continued (deliberate log-and-continue)',
      x: (typeof data.x==='number') ? Math.round(data.x*10)/10 : null,
      z: (typeof data.z==='number') ? Math.round(data.z*10)/10 : null,
      near: data.near ? String(data.near) : '',
      details: data.details || null,
      zone: zoneId(),
      ui: uiVer(),
      session: sessionId,
      sent: false
    };
  }

  /* PURE: render one entry as a markdown section. The ## heading
     carries WHO + WHAT, per Joshua's design. */
  function formatEntry(e){
    var lines = [];
    lines.push('## '+headStamp(new Date(e.ts))+' — ['+e.who+'] '+e.what);
    lines.push('- **Level:** '+e.level+(e.code ? ' · code `'+e.code+'`' : ''));
    if (e.message) lines.push('- **What happened:** '+e.message);
    if (e.errorName) lines.push('- **Error type:** '+e.errorName);
    if (e.where) lines.push('- **Where:** '+e.where);
    lines.push('- **Action taken:** '+e.action);
    if (e.x!==null && e.x!==undefined && e.z!==null && e.z!==undefined)
      lines.push('- **Position:** x '+e.x+', z '+e.z+(e.near ? ' — near '+e.near : ''));
    if (e.details){
      try{ lines.push('- **Details:** `'+JSON.stringify(e.details)+'`'); }catch(err){}
    }
    lines.push('- **Session:** '+e.session+' · zone '+e.zone+' · ui '+e.ui);
    lines.push('');
    return lines.join('\n');
  }

  var LOG_HEADER =
    '# Surviving Adamsville — Crash & Error Log\n\n' +
    'One growing log for the whole suite\'s testing. Every crash, caught\n' +
    'error, collision diagnostic and critical-window decision from the game\n' +
    'lands here automatically. Newest entries are at the BOTTOM. Do not edit\n' +
    'by hand — entries are appended by the game (crashlog.js).\n\n';

  /* PURE: append entries (in order) to existing log text. Creates
     the file (header + entries) when existing is empty/missing. */
  function appendEntries(existing, entries){
    var text = (typeof existing==='string' && existing.length) ? existing : null;
    if (text===null) text = LOG_HEADER;
    if (text.charAt(text.length-1) !== '\n') text += '\n';
    for (var i=0;i<entries.length;i++) text += formatEntry(entries[i])+'\n';
    return text;
  }

  /* ================= the pending queue =================
     Persisted in localStorage so unsent entries survive a dead
     token, a closed tab, anything. Retried next launch. */

  var PENDING_KEY = 'sa.crashlog.pending.v1';
  var MAX_PENDING = 300;
  var pending = [];
  var lastFlush = null, lastError = null, failStreak = 0, flushing = false;

  function persist(){
    try{
      var store = ls();
      if (store) store.setItem(PENDING_KEY, JSON.stringify(pending));
    }catch(e){ /* storage full/blocked: memory queue still works */ }
  }

  function restore(){
    try{
      var store = ls();
      if (!store) return;
      var raw = store.getItem(PENDING_KEY);
      if (!raw) return;
      var arr = JSON.parse(raw);
      if (arr && arr.length){
        for (var i=0;i<arr.length;i++)
          if (arr[i] && arr[i].what) pending.push(arr[i]);
      }
    }catch(e){}
  }

  /* Queue an entry. Overflow policy: drop oldest bumps first,
     then oldest non-critical — a critical record is the last
     thing this system may ever lose. */
  function enqueue(e){
    pending.push(e);
    while (pending.length > MAX_PENDING){
      var idx = -1, i;
      for (i=0;i<pending.length;i++)
        if (pending[i].level==='bump'){ idx=i; break; }
      if (idx===-1)
        for (i=0;i<pending.length;i++)
          if (pending[i].level!=='critical'){ idx=i; break; }
      if (idx===-1) idx = 0;
      pending.splice(idx,1);
    }
    persist();
    reportSys();
  }

  /* ================= upload (Contents API) =================
     GET the one log file, append locally, PUT it back. This is
     an append to a single growing file — NOT one file per report
     (that is github_reports.js's older per-type JSON scheme). */

  function api(method, path, body){
    var f = fetchFn();
    if (!f) return Promise.reject(new Error('no fetch available'));
    var c = cfg();
    var repo = c.repo || 'kingmarkarnold-code/adamsville-play';
    var url = 'https://api.github.com/repos/'+repo+'/contents/'+path;
    var headers = {
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'Authorization': 'Bearer '+getToken()
    };
    var opts = { method: method, headers: headers };
    if (body) opts.body = JSON.stringify(body);
    return f(url, opts);
  }

  function flush(){
    if (flushing) return Promise.resolve(false);
    if (!pending.length) return Promise.resolve(false);
    if (cfg().enabled === false){ lastError='uploads disabled in config'; return Promise.resolve(false); }
    if (!getToken()){ lastError='no token configured (queue held locally)'; return Promise.resolve(false); }
    /* After repeated failures, stop hammering: the queue retries
       on the next launch (failStreak resets per page load) or on
       an explicit CrashLog.flush(). */
    if (failStreak >= 3 && !flush.forced){ lastError = lastError || 'backing off after failures'; return Promise.resolve(false); }

    flushing = true;
    var batch = pending.slice();
    var path = logPath();

    function attempt(isRetry){
      return api('GET', path).then(function(resp){
        if (resp.status===404) return { text:null, sha:null };
        if (!resp.ok) throw new Error('GitHub API GET '+resp.status);
        return resp.json().then(function(j){
          return { text: b64decodeUtf8(j.content||''), sha: j.sha || null };
        });
      }).then(function(cur){
        var text = appendEntries(cur.text, batch);
        var b64 = b64encodeUtf8(text);
        if (!b64) throw new Error('base64 encode failed');
        var body = { message: 'Crash log: +'+batch.length+' entr'+(batch.length===1?'y':'ies'),
                     content: b64 };
        if (cur.sha) body.sha = cur.sha;
        return api('PUT', path, body).then(function(resp){
          if (resp.status===409 || resp.status===422){
            if (!isRetry) return attempt(true);   // someone else appended: refetch + merge once
            throw new Error('GitHub API PUT '+resp.status+' (conflict)');
          }
          if (!resp.ok) throw new Error('GitHub API PUT '+resp.status);
          return resp.json();
        });
      });
    }

    return attempt(false).then(function(){
      flushing = false; failStreak = 0;
      for (var i=0;i<batch.length;i++) batch[i].sent = true;
      pending = pending.filter(function(e){ return batch.indexOf(e)===-1; });
      persist();
      lastFlush = nowIso(); lastError = null;
      reportSys();
      return true;
    }).catch(function(err){
      flushing = false; failStreak++;
      lastError = String((err&&err.message)||err);
      reportSys();
      return false;
    });
  }

  /* ================= critical window =================
     PASSABLE, never a hard stop (Joshua's testing-phase design).
     Each critical code has a template: plain-language title and
     explanation + guided options. The safest option is the
     default (highlighted) one. The entry is written to the log
     BEFORE the choice; the choice itself is recorded. */

  var OPT_CONTINUE = { id:'continue', label:'Continue exploring', action:'continue' };
  var OPT_RELOAD   = { id:'reload',   label:'Reload and try again', action:'reload' };

  var TEMPLATES = {
    /* Joshua's own template example, word for word in spirit:
       "the full map was downloaded and verified but the buildings
       did not spawn — would you like to continue to explore?" */
    'buildings-no-data': {
      title: 'The buildings did not spawn',
      explain: 'The full map was downloaded and verified, but the building data never arrived — so there are no buildings to place. The streets and the ground are fine; the city would be empty. Would you like to continue to explore?',
      options: [OPT_CONTINUE, OPT_RELOAD], def: 'continue'
    },
    'buildings-spawn-crashed': {
      title: 'Building placement crashed',
      explain: 'The code that places buildings threw an error partway through. Some buildings may be missing or misplaced. The error is in the crash log with its location.',
      options: [OPT_CONTINUE, OPT_RELOAD], def: 'continue'
    },
    'buildings-all-skipped': {
      title: 'Every building was skipped',
      explain: 'The building data arrived, but placement refused every single building (all were blocked, e.g. by roads). The city would be empty even though the data is here.',
      options: [OPT_CONTINUE, OPT_RELOAD], def: 'continue'
    },
    'roads-empty': {
      title: 'The streets did not build',
      explain: 'Road data loaded, but the drivable street grid came out empty — driving and walking have nothing solid to follow. Reloading is the safer choice here.',
      options: [OPT_RELOAD, OPT_CONTINUE], def: 'reload'
    },
    'road-build-failed': {
      title: 'Building the streets crashed',
      explain: 'The code that turns road data into the drivable street grid threw an error. The world may be missing streets or have them in the wrong place.',
      options: [OPT_RELOAD, OPT_CONTINUE], def: 'reload'
    },
    'traffic-none-spawned': {
      title: 'No traffic spawned',
      explain: 'Traffic initialised but produced zero cars. The world works — it will just feel empty until this is fixed.',
      options: [OPT_CONTINUE, OPT_RELOAD], def: 'continue'
    },
    'zone-file-failed': {
      title: 'Part of the map failed to load',
      explain: 'One of the zone data files failed every download attempt and its fallback. The game continued without it — that part of the world may be missing or wrong.',
      options: [OPT_CONTINUE, OPT_RELOAD], def: 'continue'
    }
  };

  function templateFor(code){
    return TEMPLATES[code] || {
      title: 'Something went wrong',
      explain: 'A critical failure was caught and written to the crash log. You can keep exploring — the failure is on record either way.',
      options: [OPT_CONTINUE, OPT_RELOAD], def: 'continue'
    };
  }

  /* DOM-free decision core (unit-tested): a FIFO of criticals,
     one "current" at a time. choose() records the decision via
     the onDecision callback and advances. */
  function makeCritCore(onShow, onDecision){
    var q = [], current = null;
    return {
      push: function(entry){
        q.push(entry);
        if (!current){ current = q.shift(); if (onShow) onShow(current); }
        return current === entry;
      },
      choose: function(optionId){
        if (!current) return null;
        var e = current, tmpl = templateFor(e.code), chosen = null, i;
        for (i=0;i<tmpl.options.length;i++)
          if (tmpl.options[i].id === optionId) chosen = tmpl.options[i];
        if (!chosen) chosen = tmpl.options[0];
        if (onDecision) onDecision(e, chosen);
        current = q.shift() || null;
        if (current && onShow) onShow(current);
        return { entry: e, option: chosen };
      },
      current: function(){ return current; },
      waiting: function(){ return q.length; }
    };
  }

  /* --- the window's DOM layer (thin; all logic lives above) --- */
  var critUi = null;

  function ensureCritUi(){
    if (critUi) return critUi;
    try{
      if (typeof document==='undefined' || !document.body) return null;
      var root = document.createElement('div');
      root.id = 'crash-crit';
      root.style.cssText = 'display:none;position:fixed;inset:0;z-index:99999;'+
        'background:rgba(12,9,4,0.74);font-family:system-ui,sans-serif;';
      root.innerHTML =
        '<div style="max-width:520px;margin:9vh auto 0;background:#1d2126;color:#f2efe6;'+
        'border:2px solid #e8a33d;border-radius:12px;padding:18px 20px;'+
        'box-shadow:0 12px 48px rgba(0,0,0,0.6)">' +
        '<div id="crash-crit-badge" style="font-size:12px;color:#e8a33d;letter-spacing:0.08em"></div>' +
        '<h2 id="crash-crit-title" style="margin:6px 0 8px;font-size:21px"></h2>' +
        '<p id="crash-crit-explain" style="margin:0 0 10px;font-size:15px;line-height:1.45"></p>' +
        '<p id="crash-crit-tech" style="margin:0 0 14px;font-size:11px;color:#9aa3ad;'+
        'font-family:monospace;white-space:pre-wrap"></p>' +
        '<div id="crash-crit-btns"></div>' +
        '<p style="margin:12px 0 0;font-size:12px;color:#9aa3ad">This problem has been ' +
        'written to the crash log. Picking an option never deletes the record.</p></div>';
      document.body.appendChild(root);
      critUi = {
        root: root,
        badge: root.querySelector('#crash-crit-badge'),
        title: root.querySelector('#crash-crit-title'),
        explain: root.querySelector('#crash-crit-explain'),
        tech: root.querySelector('#crash-crit-tech'),
        btns: root.querySelector('#crash-crit-btns')
      };
      return critUi;
    }catch(e){ return null; }
  }

  function showCrit(entry){
    var ui = ensureCritUi();
    if (!ui) return;
    var tmpl = templateFor(entry.code);
    try{
      var waiting = critCore.waiting();
      ui.badge.textContent = '⚠ CRITICAL — GAME LOGGED IT' +
        (waiting ? '  ·  +'+waiting+' more waiting' : '');
      ui.title.textContent = tmpl.title;
      ui.explain.textContent = tmpl.explain;
      ui.tech.textContent =
        (entry.message ? entry.message+'\n' : '') +
        'code: '+entry.code+(entry.where ? '  ·  at: '+entry.where : '')+
        (entry.errorName ? '  ·  error: '+entry.errorName : '');
      ui.btns.innerHTML = '';
      tmpl.options.forEach(function(opt){
        var b = document.createElement('button');
        b.textContent = opt.label;
        var isDef = (opt.id === tmpl.def);
        b.style.cssText = 'display:block;width:100%;margin:6px 0;padding:12px;'+
          'font-size:15px;border-radius:9px;cursor:pointer;'+
          (isDef ? 'background:#e8a33d;color:#191407;border:2px solid #ffcf7d;font-weight:700'
                 : 'background:#2c3138;color:#f2efe6;border:1px solid #565e66');
        b.addEventListener('click', function(){ chooseCrit(opt.id); });
        ui.btns.appendChild(b);
        if (isDef){ try{ b.focus(); }catch(e){} }
      });
      ui.root.style.display = 'block';
    }catch(e){}
  }

  function hideCrit(){
    if (critUi){ try{ critUi.root.style.display = 'none'; }catch(e){} }
  }

  var critCore = makeCritCore(showCrit, function(entry, option){
    /* Record the tester's decision. If the entry hasn't been
       uploaded yet, amend it in place (flush serialises the live
       objects); if it already went up, file a follow-up note. */
    var note = 'tester chose "'+option.label+'" at the critical window';
    if (!entry.sent){
      entry.action = 'logged; '+note;
      persist();
    } else {
      enqueue(makeEntry('info', entry.code+'-decision',
        'Critical-window decision: '+entry.what, {
          message: note, where: entry.where,
          action: 'decision recorded for the entry at '+entry.ts
        }));
    }
    reportSys();
  });

  function chooseCrit(optionId){
    var res = critCore.choose(optionId);
    if (!critCore.current()) hideCrit();
    if (res && res.option.action === 'reload'){
      try{ flush(); }catch(e){}
      try{ setTimeout(function(){
        if (typeof location!=='undefined') location.reload();
      }, 350); }catch(e){}
    }
    try{ setTimeout(flush, 1500); }catch(e){}
  }

  /* Raise a critical: log FIRST (facts before choices), then the
     passable window. */
  function critical(code, data){
    data = data || {};
    var tmpl = templateFor(code);
    var e = makeEntry('critical', code,
      data.what || ('Critical failure: '+tmpl.title), {
        message: data.message, errorName: data.errorName, where: data.where,
        x: data.x, z: data.z, details: data.details,
        action: 'logged; critical window shown — waiting for tester choice'
      });
    enqueue(e);
    critCore.push(e);
    try{ setTimeout(flush, 3000); }catch(err){}
    return e;
  }

  /* ================= collision diagnostics =================
     When the player bumps something, NAME it. Identification
     reads the game's own collision registries (bldgGrid /
     propGrid / segColliders) and, for buildings, the placed-
     building records published as window.__bldgKept — so a
     collider with NO matching placed building is reported as
     exactly what Joshua suspects: solid, but possibly invisible. */

  var BLDG_TYPES = {
    0: 'a house (residential building)',
    1: 'a commercial building',
    2: 'a multi-unit / institutional building',
    3: 'a special building'
  };

  function identify(x, z, radius){
    var out = { kind:'unknown', label:'something solid (unidentified)',
                bx:x, bz:z, road:'', suspicious:false };
    try{
      if (typeof window==='undefined') return out;
      radius = (typeof radius==='number') ? radius : 0.5;
      var best = null, bestD = 1e18, kind = null, i, gx, gz;

      /* (1) building colliders (spatial hash, 3x3 cells) */
      var bg = window.bldgGrid;
      if (bg){
        var cx = Math.floor(x/40), cz = Math.floor(z/40);
        for (gx=cx-1; gx<=cx+1; gx++) for (gz=cz-1; gz<=cz+1; gz++){
          var cell = bg[gx+','+gz]; if (!cell) continue;
          for (i=0;i<cell.length;i++){
            var c = cell[i];
            var d = Math.sqrt((x-c.x)*(x-c.x)+(z-c.z)*(z-c.z)) - c.r;
            if (d < radius + 0.75 && d < bestD){ bestD = d; best = c; kind = 'building'; }
          }
        }
      }
      if (kind === 'building' && best){
        out.kind = 'building'; out.bx = best.x; out.bz = best.z;
        var kept = window.__bldgKept, match = null;
        if (kept && kept.length){
          for (i=0;i<kept.length;i++){
            var k = kept[i];
            if (Math.abs(k[0]-best.x) < 0.6 && Math.abs(k[1]-best.z) < 0.6){ match = k; break; }
          }
        }
        if (match){
          out.label = BLDG_TYPES[match[5]] || 'a building';
          out.details = { w: match[2], d: match[3], h: match[4], type: match[5] };
        } else {
          /* A building collider with no placed-building record:
             the invisible-but-solid suspect. Say so plainly. */
          out.label = 'a solid structure (building collider with NO matching placed building — possibly invisible)';
          out.suspicious = true;
        }
      }

      /* (2) wall segments */
      if (!kind){
        var segs = window.segColliders;
        if (segs && segs.length){
          var lim = Math.min(segs.length, 20000);
          for (i=0;i<lim;i++){
            var s = segs[i];
            var vx = s.x2-s.x1, vz = s.z2-s.z1, len2 = vx*vx+vz*vz;
            var t = len2>0 ? ((x-s.x1)*vx+(z-s.z1)*vz)/len2 : 0;
            t = Math.max(0, Math.min(1, t));
            var px = s.x1+vx*t, pz = s.z1+vz*t;
            var sd = Math.sqrt((x-px)*(x-px)+(z-pz)*(z-pz));
            if (sd < radius + 0.4 && sd < bestD){
              bestD = sd; kind = 'wall';
              out.bx = px; out.bz = pz;
            }
          }
          if (kind === 'wall') out.label = 'a wall';
        }
      }

      /* (3) props (trees, signs, posts — one registry) */
      if (!kind){
        var pg = window.propGrid;
        if (pg){
          var pcx = Math.floor(x/40), pcz = Math.floor(z/40);
          for (gx=pcx-1; gx<=pcx+1; gx++) for (gz=pcz-1; gz<=pcz+1; gz++){
            var pcell = pg[gx+','+gz]; if (!pcell) continue;
            for (i=0;i<pcell.length;i++){
              var pc = pcell[i];
              var pd = Math.sqrt((x-pc.x)*(x-pc.x)+(z-pc.z)*(z-pc.z)) - pc.r;
              if (pd < radius + 0.75 && pd < bestD){
                bestD = pd; kind = 'prop';
                out.bx = pc.x; out.bz = pc.z;
              }
            }
          }
          if (kind === 'prop') out.label = 'a solid prop (tree, sign or post)';
        }
      }
      out.kind = kind || 'unknown';

      /* Nearest street name, using the game's own audit helper. */
      try{
        if (typeof window.nearestRoadInfo === 'function'){
          var ri = window.nearestRoadInfo(x, z);
          if (ri && ri.name) out.road = String(ri.name);
        }
      }catch(e){}
      return out;
    }catch(e){ return out; }
  }

  /* --- bump toast (small on-screen notice) --- */
  var toastEl = null, toastTimer = null;

  function toast(msg){
    try{
      if (typeof document==='undefined' || !document.body) return;
      if (!toastEl){
        toastEl = document.createElement('div');
        toastEl.id = 'crash-bump-toast';
        toastEl.style.cssText = 'position:fixed;left:50%;bottom:19%;'+
          'transform:translateX(-50%);z-index:99990;pointer-events:none;'+
          'background:rgba(20,22,26,0.88);color:#ffe1a1;border:1px solid #e8a33d;'+
          'border-radius:9px;padding:8px 14px;font:600 14px system-ui,sans-serif;'+
          'opacity:0;transition:opacity 0.25s;max-width:88vw;text-align:center';
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.style.opacity = '1';
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function(){ try{ toastEl.style.opacity='0'; }catch(e){} }, 2600);
    }catch(e){}
  }

  /* --- bump handling with cooldowns (bumping a wall 60x a second
     must not flood the log; repeats are counted, not lost) --- */
  var bumpSeen = {};   // signature -> {t, n}

  function handleBump(x, z, mode, speed){
    try{
      var id = identify(x, z, mode==='driving' ? 2.2 : 0.5);
      var sig = id.kind+'@'+Math.round(id.bx/5)+','+Math.round(id.bz/5)+(mode==='driving'?'/drv':'/walk');
      var now = Date.now();
      var cdMs = (mode==='driving') ? 20000 : 15000;
      var seen = bumpSeen[sig];
      if (seen && (now - seen.t) < cdMs){ seen.n++; return; }
      var repeats = seen ? seen.n : 0;
      bumpSeen[sig] = { t: now, n: 0 };

      toast('You bumped into ' + id.label + (id.road ? ' — near '+id.road : ''));

      var details = { kind: id.kind, mode: mode, suspicious: !!id.suspicious };
      if (typeof speed==='number') details.speed = Math.round(speed*10)/10;
      if (repeats) details.alsoBumpedTimesSinceLastReport = repeats;
      if (id.details) details.building = id.details;
      enqueue(makeEntry('bump', 'collision-'+id.kind,
        'Player bumped: '+id.label, {
          message: 'Player ('+mode+') collided with '+id.label+
            (id.road ? ' near '+id.road : '')+
            (id.suspicious ? '. WARNING: no placed building matches this collider — it may be invisible.' : ''),
          where: 'collision solver (resolveCollision)',
          x: id.bx, z: id.bz, near: id.road, details: details,
          action: 'logged; on-screen notice shown; game continued'
        }));
      try{ setTimeout(flush, 4000); }catch(e){}
    }catch(e){}
  }

  /* Wrap the collision solver: if the solver had to push the
     PLAYER out while the player was actually moving, that's a
     bump. Other modules wrap resolveCollision too (interior
     system) — the chain works in any order because every wrapper
     calls through. */
  var lastPX = null, lastPZ = null, collisionWrapped = false;

  function wrapCollision(){
    if (collisionWrapped) return;
    try{
      if (typeof window==='undefined' ||
          typeof window.resolveCollision !== 'function') return;
      collisionWrapped = true;
      var orig = window.resolveCollision;
      window.resolveCollision = function(p, radius){
        var isPlayer = false, bx = 0, bz = 0;
        try{
          isPlayer = (typeof player!=='undefined' && p === player);
        }catch(e){}
        if (isPlayer){ bx = p.x; bz = p.z; }
        var r = orig.apply(this, arguments);
        if (isPlayer){
          try{
            var pdx = p.x-bx, pdz = p.z-bz;
            var pushed = Math.sqrt(pdx*pdx+pdz*pdz);
            var moved = 0;
            if (lastPX !== null)
              moved = Math.sqrt((bx-lastPX)*(bx-lastPX)+(bz-lastPZ)*(bz-lastPZ));
            lastPX = p.x; lastPZ = p.z;
            if (pushed > 0.02 && moved > 0.01)
              handleBump(p.x, p.z, 'walking', null);
          }catch(e){}
        }
        return r;
      };
    }catch(e){}
  }

  /* ================= public log API ================= */

  function log(level, code, what, data){
    var e = makeEntry(level, code, what, data);
    enqueue(e);
    try{ setTimeout(flush, 3000); }catch(err){}
    return e;
  }

  function error(code, what, err, where){
    return log('error', code, what, {
      message: String((err && err.message) || err || ''),
      errorName: (err && err.name) || (err ? 'Error' : ''),
      where: where || ''
    });
  }

  /* ================= early-buffer drain =================
     index.html defines SA_CRASH(kind, data) from the first
     second of boot (window.__crashQ). Seams that fire before
     this module loads land there; we drain on init, and
     SA_CRASH calls _drain() directly once we exist. */

  function drain(){
    try{
      if (typeof window==='undefined' || !window.__crashQ) return;
      var q = window.__crashQ;
      while (q.length){
        var item = q.shift();
        if (!item) continue;
        var d = item.data || {};
        if (item.kind === 'bump'){
          handleBump(d.x||0, d.z||0, d.mode || 'driving', d.speed);
        } else if (item.kind === 'critical'){
          critical(d.code || 'unspecified', d);
        } else if (item.kind === 'warning'){
          log('warning', d.code || 'unspecified', d.what || 'Warning', d);
        } else {
          log('error', d.code || 'unspecified', d.what || 'Error', d);
        }
      }
    }catch(e){}
  }

  /* ================= zone + loader drains =================
     The deferred loader records final zone-file failures in
     window.__zoneLoadErrors and marks failed steps in
     window.__loadDone — then CONTINUES. Both used to be silent
     (console only). We reconcile each record against reality:
     if the data actually arrived (fallback saved it), the entry
     says so; if it truly is missing, it's an error — and for the
     buildings/roads files, a critical window. */

  var zoneDrained = {}, loadWarnDrained = false;

  function realityFor(key){
    try{
      if (key === 'buildings')
        return (typeof window.OSM_BUILDINGS!=='undefined' && window.OSM_BUILDINGS && window.OSM_BUILDINGS.length) ? 'arrived' : 'missing';
      if (key === 'roads' || key === 'roadsjs')
        return (typeof window.roadDrawData!=='undefined' && window.roadDrawData && window.roadDrawData.length) ? 'arrived' : 'missing';
      var files = window.__zoneScriptFiles || [];
      for (var i=0;i<files.length;i++)
        if (files[i] && files[i].key === key && files[i].global)
          return (typeof window[files[i].global]!=='undefined' && window[files[i].global]) ? 'arrived' : 'missing';
    }catch(e){}
    return 'unknown';
  }

  function drainZoneErrors(){
    try{
      var errs = (typeof window!=='undefined' && window.__zoneLoadErrors) || {};
      for (var key in errs){
        if (zoneDrained[key]) continue;
        zoneDrained[key] = true;
        var reality = realityFor(key);
        var reason = String(errs[key]);
        if (reality === 'arrived'){
          log('warning', 'zone-file-recovered',
            'Zone file "'+key+'" failed, fallback recovered it', {
              message: reason+' — but the data DID arrive via the fallback path.',
              where: 'deferred zone loader (index.html)',
              action: 'logged; game continued with fallback data (deliberate)'
            });
        } else if (reality === 'missing' && (key === 'buildings' || key === 'roads')){
          critical('zone-file-failed', {
            what: 'Zone file "'+key+'" failed to load',
            message: reason+' — and the data is NOT in the game.',
            where: 'deferred zone loader (index.html)'
          });
        } else {
          log('error', 'zone-file-failed',
            'Zone file "'+key+'" failed to load', {
              message: reason,
              where: 'deferred zone loader (index.html)',
              action: 'logged; game continued without it (deliberate)'
            });
        }
      }
    }catch(e){}
  }

  function drainLoadWarnings(){
    if (loadWarnDrained) return;
    try{
      if (typeof window==='undefined' || !window.__loadDone || !window.__loadOrder) return;
      var all = true, i;
      for (i=0;i<window.__loadOrder.length;i++)
        if (!window.__loadDone[window.__loadOrder[i]]){ all = false; break; }
      if (!all) return;   // loader still working; try again next tick
      loadWarnDrained = true;
      for (i=0;i<window.__loadOrder.length;i++){
        var key = window.__loadOrder[i];
        if (window.__loadDone[key] === 'warn'){
          var nm = (window.__loadNames && window.__loadNames[key]) || key;
          log('warning', 'load-step-failed',
            'Load step failed: '+nm, {
              message: 'The loader marked "'+nm+'" ('+key+') failed and continued without it.',
              where: 'deferred loader __loadStep',
              action: 'logged; game continued without that system (deliberate)'
            });
        }
      }
    }catch(e){}
  }

  /* ================= uncaught error nets ================= */

  var errSeen = {};

  function noteUncaught(kind, msg, file, line, errObj){
    try{
      var sig = kind+'|'+msg+'|'+(line||'');
      var now = Date.now();
      if (errSeen[sig] && (now - errSeen[sig]) < 3000) return;  // crash-loop guard
      errSeen[sig] = now;
      if (file && /crashlog\.js/.test(file)) return;             // never report ourselves
      var pos = null;
      try{
        if (typeof player!=='undefined' && player) pos = { x: player.x, z: player.z };
      }catch(e){}
      log('error', kind, 'Uncaught '+(kind==='error-crash' ? 'error' : 'promise rejection'), {
        message: msg,
        errorName: (errObj && errObj.name) || '',
        where: (file || '')+(line ? ':'+line : ''),
        x: pos ? pos.x : null, z: pos ? pos.z : null,
        details: (errObj && errObj.stack) ? { stack: String(errObj.stack).slice(0, 600) } : null
      });
    }catch(e){}
  }

  function hookErrors(){
    try{
      if (typeof window==='undefined' || !window.addEventListener) return;
      window.addEventListener('error', function(ev){
        try{
          noteUncaught('error-crash', String((ev && ev.message) || 'unknown error'),
            String((ev && ev.filename) || ''), (ev && ev.lineno) || null, ev && ev.error);
        }catch(e){}
      });
      window.addEventListener('unhandledrejection', function(ev){
        try{
          var r = ev && ev.reason;
          noteUncaught('error-rejection', String((r && r.message) || r || 'unhandled rejection'),
            '', null, r);
        }catch(e){}
      });
    }catch(e){}
  }

  /* ================= Report panel status ================= */

  function reportSys(){
    try{
      if (typeof Report!=='undefined' && Report.setSys)
        Report.setSys('crashLog', {
          queued: pending.length,
          hasToken: !!getToken(),
          lastFlush: lastFlush, lastError: lastError,
          note: 'one growing markdown log: '+logPath()
        });
    }catch(e){}
  }

  /* ================= init ================= */

  restore();
  drain();
  hookErrors();
  wrapCollision();

  try{
    var tries = 0;
    var iv = setInterval(function(){
      wrapCollision();           // in case the solver appeared late
      drain();                   // late SA_CRASH pushes
      drainZoneErrors();
      drainLoadWarnings();
      if (++tries > 90) clearInterval(iv);   // ~3 minutes of watching
    }, 2000);
  }catch(e){}

  try{ setTimeout(flush, 4000); }catch(e){}
  try{ setInterval(flush, flushMs()); }catch(e){}
  try{
    if (typeof document!=='undefined')
      document.addEventListener('visibilitychange', function(){
        if (document.visibilityState === 'hidden') flush();
      });
    if (typeof window!=='undefined')
      window.addEventListener('pagehide', function(){ flush(); });
  }catch(e){}

  reportSys();

  /* ================= public API ================= */
  return {
    log: log,
    error: error,
    critical: critical,
    bump: function(x, z, mode, speed){ handleBump(x, z, mode || 'walking', speed); },
    flush: function(){ flush.forced = true; var p = flush(); flush.forced = false; return p; },
    status: function(){
      return {
        queued: pending.length,
        hasToken: !!getToken(),
        lastFlush: lastFlush,
        lastError: lastError,
        failStreak: failStreak,
        logPath: logPath(),
        critWaiting: critCore.waiting() + (critCore.current() ? 1 : 0)
      };
    },
    /* hooks used by the SA_CRASH shim + the test harness */
    _drain: drain,
    _identify: identify,
    _format: formatEntry,
    _append: appendEntries,
    _core: makeCritCore,
    _templates: TEMPLATES
  };
})();
