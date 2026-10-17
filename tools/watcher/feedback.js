/* ============================================================================
   Adamsville Watcher — In-Map Feedback
   Joshua taps any object (3D) or flag (2D), types a note; notes pin to map
   coordinates and stage in a local list. "Submit feedback" opens a pre-filled
   GitHub issue (title + body + `feedback` label) — he hits Submit in his
   browser and the report lands directly in the repo as an issue. Muse reads
   open `feedback`-labeled issues before fix passes and compiles.
   Fully local staging (localStorage); no token in the page, no copy-paste.
   ========================================================================== */
var Feedback = (function () {
'use strict';

var KEY = 'aw_feedback_v1';
var notes = load();

function load() {
  try { var n = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(n) ? n : []; }
  catch (e) { return []; }
}
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(notes)); } catch (e) {}
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function dateStr(d) {
  d = d || new Date();
  function p(n) { return ('0' + n).slice(-2); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* Stable machine-readable Markdown. One section per note. */
function markdown() {
  var lines = ['# Map Feedback — ' + dateStr(), '',
    '_Exported from Adamsville Watcher · ' + notes.length + ' note' + (notes.length === 1 ? '' : 's') + '_', ''];
  notes.forEach(function (n, i) {
    lines.push('## ' + (i + 1) + '. [' + n.type + '] ' + n.name);
    lines.push('- coords: ' + Math.round(n.x) + ', ' + Math.round(n.z));
    lines.push('- view: ' + (n.view || '3d'));
    lines.push('- note: ' + n.text);
    lines.push('');
  });
  return lines.join('\n');
}
function filename() { return 'map-feedback-' + dateStr() + '.md'; }

function updateBadge() {
  var el = document.getElementById('fbcount');
  if (el) el.textContent = notes.length ? '(' + notes.length + ')' : '';
}

function render() {
  var list = document.getElementById('fblist');
  if (!list) return;
  if (!notes.length) {
    list.innerHTML = '<div class="empty">No notes yet.<br>Tap a building, road, sign, or flag in either view, then type your note.</div>';
    return;
  }
  list.innerHTML = notes.map(function (n, i) {
    return '<div class="fnote" data-id="' + n.id + '">' +
      '<div class="fh"><b>' + (i + 1) + '.</b> <span class="ftype">[' + esc(n.type) + ']</span> ' + esc(n.name) +
      ' <span class="fx" data-del="' + n.id + '" title="delete">✕</span></div>' +
      '<div class="fc">' + Math.round(n.x) + ', ' + Math.round(n.z) + ' · ' + esc(n.view || '3d') + '</div>' +
      '<div class="ft">' + esc(n.text) + '</div></div>';
  }).join('');
  var dels = list.querySelectorAll('[data-del]');
  for (var i = 0; i < dels.length; i++) {
    (function (el) {
      el.addEventListener('click', function (ev) {
        ev.stopPropagation();
        remove(el.getAttribute('data-del'));
      });
    })(dels[i]);
  }
}

function add(note) {
  note.id = 'n' + Date.now();
  note.ts = new Date().toISOString();
  notes.push(note);
  persist(); render(); updateBadge();
  if (window.AW2D && window.AW2D.refreshPins) window.AW2D.refreshPins();
}
function remove(id) {
  notes = notes.filter(function (n) { return n.id !== id; });
  persist(); render(); updateBadge();
  if (window.AW2D && window.AW2D.refreshPins) window.AW2D.refreshPins();
}

/* Focus management (Joshua's standing rule): whenever a text field or the
   note popup has focus, ALL map keyboard controls must yield — typing must
   never drive the map. Every key handler on the site checks this first. */
function typingNow(){
  try {
    var m = document.getElementById('fbmodal');
    if (m && m.style.display !== 'none' && m.style.display !== '') return true;
    var a = document.activeElement;
    if (!a || a === document.body) return false;
    var t = (a.tagName || '').toUpperCase();
    if (t === 'TEXTAREA' || t === 'SELECT' || a.isContentEditable) return true;
    if (t === 'INPUT') {
      var it = (a.type || 'text').toLowerCase();
      return it !== 'checkbox' && it !== 'radio' && it !== 'button' &&
             it !== 'submit' && it !== 'range' && it !== 'color';
    }
    return false;
  } catch (e) { return false; }
}
window.WatcherTyping = typingNow;

/* Comment modal. prefill: {type, name, x, z, view} */
var pending = null;
function openComment(prefill) {
  pending = prefill;
  document.getElementById('fbmt').textContent =
    '[' + prefill.type + '] ' + prefill.name;
  document.getElementById('fbmm').textContent =
    'map coords ' + Math.round(prefill.x) + ', ' + Math.round(prefill.z);
  document.getElementById('fbtext').value = '';
  document.getElementById('fbmodal').style.display = 'flex';
  setTimeout(function () { document.getElementById('fbtext').focus(); }, 50);
}
function closeComment() {
  document.getElementById('fbmodal').style.display = 'none';
  pending = null;
}
function saveComment() {
  var t = document.getElementById('fbtext').value.trim();
  if (!t || !pending) { closeComment(); return; }
  add({ type: pending.type, name: pending.name, x: pending.x, z: pending.z,
        view: pending.view || '3d', text: t });
  closeComment();
}

/* Direct submit: opens a pre-filled GitHub issue. Joshua is logged into
   GitHub in his browser, so he just hits Submit there — the report lands in
   the repo as a `feedback`-labeled issue. No token in the page, no copy-paste. */
var REPO_ISSUES = 'https://github.com/kingmarkarnold-code/adamsville-watcher/issues/new';
/* Unified feedback submit: saves to the local outbox, files via API if a
   GitHub token is saved, otherwise opens the pre-filled GitHub issue page. */
function fbGetToken(){ try{ return localStorage.getItem('aw_gh_token')||''; }catch(e){ return ''; } }
function fbGetOutbox(){ try{ return JSON.parse(localStorage.getItem('aw_outbox')||'[]'); }catch(e){ return []; } }
function fbSaveOutbox(o){ try{ localStorage.setItem('aw_outbox', JSON.stringify(o)); }catch(e){} }
function fbQueue(title, body){
  var o=fbGetOutbox(); o.push({t:title, b:body, when:new Date().toISOString()}); fbSaveOutbox(o);
  if(typeof updateOutboxBtn==='function') updateOutboxBtn();
}
function fbFileAPI(title, body, label, cb){
  var tok=fbGetToken();
  if(!tok){ cb(false); return; }
  fetch('https://api.github.com/repos/kingmarkarnold-code/adamsville-watcher/issues',{
    method:'POST',
    headers:{ 'Authorization':'Bearer '+tok, 'Accept':'application/vnd.github+json',
      'Content-Type':'application/json' },
    body: JSON.stringify({ title:title, body:body, labels:[label||'feedback'] })
  }).then(function(r){ cb(r.ok); }).catch(function(){ cb(false); });
}
function submitFeedback(title, body, label){
  label=label||'feedback';
  var tok=fbGetToken();
  if(tok){
    fbFileAPI(title, body, label, function(ok){ if(!ok) fbQueue(title, body); });
  } else {
    fbQueue(title, body);
    var url=REPO_ISSUES+'?title='+encodeURIComponent(title)
      +'&body='+encodeURIComponent(body)+'&labels='+encodeURIComponent(label);
    if(url.length>7500){ alert('Report saved to outbox (too long for a GitHub link). Submit it from Reports when ready.'); return; }
    window.open(url,'_blank');
  }
}
function submitReport() {
  if (!notes.length) return;
  var md = markdown();
  var title = 'Map feedback — ' + dateStr() + ' (' + notes.length + ' note' + (notes.length === 1 ? '' : 's') + ')';
  if (md.length > 7000) {
    alert('That\u2019s a lot of notes for one submit (' + notes.length + '). ' +
      'Delete a few from the list (or submit in two batches). It\u2019s saved to your outbox regardless.');
  }
  submitFeedback(title, md, 'feedback');
  // clear notes and close the feedback box
  notes=[]; save();
  updateBadge();
  var fb=document.getElementById('feedbackbox');
  if(fb) fb.style.display='none';
  if(typeof renderNotes==='function') renderNotes();
}

function togglePanel(show) {
  var p = document.getElementById('fbpanel');
  var vis = (typeof show === 'boolean') ? show : (p.style.display !== 'block');
  p.style.display = vis ? 'block' : 'none';
  if (vis) render();
}

function init() {
  document.getElementById('fbbtn').addEventListener('click', function () { togglePanel(); });
  document.getElementById('fbx').addEventListener('click', function () { togglePanel(false); });
  document.getElementById('fbsubmit').addEventListener('click', submitReport);
  document.getElementById('fbsave').addEventListener('click', saveComment);
  document.getElementById('fbcancel').addEventListener('click', closeComment);
  document.getElementById('fbmodal').addEventListener('click', function (e) {
    if (e.target.id === 'fbmodal') closeComment();
  });
  updateBadge();
}

return {
  init: init,
  add: add,
  remove: remove,
  openComment: openComment,
  togglePanel: togglePanel,
  markdown: markdown,
  count: function () { return notes.length; },
  list: function () { return notes; }
};
})();
