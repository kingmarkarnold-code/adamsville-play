#!/usr/bin/env node
/**
 * smoke-test.js — Surviving Adamsville pre-publish smoke test.
 *
 * Expert report #36 (Jennifer Wu, QA Tester — Joshua approved fix):
 * "There's no automated verification before pushing to live. Broken code
 * goes straight to Joshua's phone." The #12 CI gate checks syntax and
 * manifest hashes, but nothing verified the game would actually BOOT:
 * every deferred script well-formed, every loader step resolvable, every
 * boot function present, every deployable file on disk.
 *
 * The real incident that motivated this: expert #19's agent found
 * index.html had an UNCOLSED <script data-dsrc="semi_system.js"> tag that
 * swallowed the school_plaza.js tag as text — the Plaza at Cascade/Fairburn
 * script silently never loaded, and nobody noticed until a human read the
 * HTML. This test would have caught it.
 *
 * What it checks (all static, runs in seconds, no browser needed):
 *   1. ENTRY    — entry points exist and contain the boot markers.
 *   2. QUEUE    — every <script data-dsrc> tag is well-formed and closed
 *                 (swallowed-tag detection), every referenced file exists
 *                 on disk, no duplicates, and three.min.js loads before
 *                 every script that needs THREE at load time.
 *   3. STEPS    — every __loadOrder step key resolves to at least one file
 *                 (data-dkey scripts, zone data files for all 7 zones, or
 *                 an inline __loadStep call site). A missing CRITICAL step
 *                 fails the test; a missing optional step warns.
 *   4. BOOT     — the boot-sequence functions the loader depends on are
 *                 defined in the inline blocks (__loadDeferredQueue,
 *                 __loadStep, __tryStartGame, __showCriticalWarning,
 *                 __injectZoneFiles, Sim.onTick).
 *   5. DEPLOY   — every manifest-listed file exists on disk; every
 *                 deferred script is listed in ui-manifest.json (warn only —
 *                 it still deploys via the repo push, but the APK updater
 *                 would miss it); version strings match YYYY.MM.DD.N.
 *   6. STRUCTURE— <script>/<\/script> tags balance; every loader overlay
 *                 id referenced by getElementById('load-*') exists as a
 *                 static id="load-*" attribute.
 *
 * Exit 0 = safe to publish. Exit 1 = DO NOT PUSH; failures are printed.
 * Warnings never fail the test but are printed for the human to review.
 *
 * Run:  node tools/smoke-test.js        (from the repo/play root)
 *       node play/tools/smoke-test.js   (from ~/workspace/game-map)
 */
'use strict';
const fs = require('fs');
const path = require('path');

// Repo/play root = one level up from tools/. Also tolerates being run
// from ~/workspace/game-map as: node play/tools/smoke-test.js
let ROOT = path.resolve(__dirname, '..');
if (!fs.existsSync(path.join(ROOT, 'detailed', 'index.html')) &&
    fs.existsSync(path.join(ROOT, 'play', 'detailed', 'index.html'))) {
  ROOT = path.join(ROOT, 'play');
}
const DETAILED = path.join(ROOT, 'detailed');

let failures = 0;
let warnings = 0;
function fail(msg) { failures++; console.error('  FAIL: ' + msg); }
function warn(msg) { warnings++; console.log('  warn: ' + msg); }
function ok(msg)   { console.log('  ok: ' + msg); }

function read(p) { return fs.readFileSync(p, 'utf8'); }
function exists(p) { return fs.existsSync(p); }

/* ------------------------------------------------------------------ */
/* Shared parsers                                                      */
/* ------------------------------------------------------------------ */

// Strip HTML comments so a <script> example inside a comment can't
// mis-pair the tag matcher (same lesson as ci-check.js).
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

// All <script data-dsrc="..."> tags in document order, with their raw
// tag text, inner body, and data-dkey (if any).
function parseDsrcTags(html) {
  const tags = [];
  const re = /<script\b[^>]*\bdata-dsrc="([^"]+)"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tagText = m[0];
    const dkey = /data-dkey="([^"]*)"/i.exec(tagText);
    tags.push({
      file: m[1],
      body: m[2],
      key: dkey ? dkey[1] : '',
      // A well-formed deferred tag has an EMPTY body. If the body contains
      // another <script, this tag swallowed the next one (the #19 bug:
      // an unclosed tag ate school_plaza.js as text).
      swallowed: /<script/i.test(m[2]),
      index: m.index,
    });
  }
  return tags;
}

function parseLoadOrder(html) {
  const m = /window\.__loadOrder\s*=\s*\[([^\]]*)\]/.exec(html);
  if (!m) return null;
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function parseCriticalKeys(html) {
  const m = /window\.__criticalLoadKeys\s*=\s*\{([^}]*)\}/.exec(html);
  if (!m) return {};
  const out = {};
  const re = /([A-Za-z0-9_]+)\s*:/g;
  let k;
  while ((k = re.exec(m[1])) !== null) out[k[1]] = true;
  return out;
}

// Inline <script> blocks with no src= and no data-dsrc= (game code).
function extractInlineBlocks(html) {
  const blocks = [];
  const re = /<script(?![^>]*(?:\bsrc=|\bdata-dsrc=))[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1].trim()) blocks.push(m[1]);
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Phase 1: entry points                                               */
/* ------------------------------------------------------------------ */
function phaseEntry() {
  console.log('== ENTRY ==');
  const idx = path.join(DETAILED, 'index.html');
  if (!exists(idx)) { fail('missing entry point ' + idx); return null; }
  const html = read(idx);
  if (html.length < 10000) fail('detailed/index.html suspiciously small (' + html.length + ' bytes)');
  else ok('detailed/index.html present (' + html.length + ' bytes)');
  for (const marker of ['__loadDeferredQueue', '__loadOrder', 'data-dsrc="three.min.js"']) {
    if (!html.includes(marker)) fail('detailed/index.html missing boot marker: ' + marker);
  }
  const root = path.join(ROOT, 'index.html');
  if (!exists(root)) fail('missing root index.html mirror');
  else ok('root index.html mirror present');
  return stripComments(html);
}

/* ------------------------------------------------------------------ */
/* Phase 2: deferred queue integrity                                   */
/* ------------------------------------------------------------------ */
// Modules verified to never touch THREE at load time, so they may legally
// appear before three.min.js in the deferred queue. A new module placed
// before three.min.js must be added here AFTER verifying it is THREE-free
// at top level — the test fails otherwise, forcing the explicit opt-in.
const THREE_FREE_EARLY = { 'toon_mats.js': true, 'rounded_box.js': true };

function phaseQueue(html) {
  console.log('== QUEUE (deferred scripts) ==');
  const tags = parseDsrcTags(html);
  if (tags.length === 0) { fail('no <script data-dsrc> tags found'); return []; }
  ok(tags.length + ' deferred script tags parsed');

  const seen = {};
  let threeIdx = -1;
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    if (t.swallowed) {
      fail('swallowed script tag: data-dsrc="' + t.file + '" has <script> in its body ' +
           '(unclosed tag ate the next script — the #19 school_plaza.js bug)');
    }
    if (seen[t.file]) fail('duplicate data-dsrc="' + t.file + '"');
    seen[t.file] = true;
    const fp = path.join(DETAILED, t.file);
    if (!exists(fp)) fail('deferred script missing on disk: ' + t.file);
    if (t.file === 'three.min.js') threeIdx = i;
  }
  if (threeIdx === -1) {
    fail('three.min.js not in deferred queue (3D engine would never load)');
  } else {
    // Every non-exempt script before three.min.js must be THREE-free.
    for (let i = 0; i < threeIdx; i++) {
      const f = tags[i].file;
      if (!THREE_FREE_EARLY[f]) {
        fail('"' + f + '" loads before three.min.js but is not in the ' +
             'THREE_FREE_EARLY allowlist — verify it never touches THREE at ' +
             'load time, then add it to the allowlist in tools/smoke-test.js');
      }
    }
    if (failures === 0) ok('three.min.js ordering valid (engine before its users)');
  }
  const missing = tags.filter(t => !exists(path.join(DETAILED, t.file)));
  if (missing.length === 0 && failures === 0) ok('all deferred scripts exist on disk');
  return tags;
}

/* ------------------------------------------------------------------ */
/* Phase 3: loader step coverage                                       */
/* ------------------------------------------------------------------ */
const ZONES = ['mableton', 'adamsville', 'downtown', 'eastatlanta',
               'unioncity', 'southfulton', 'riverdale'];
const ZONE_FILES = { roads: 'roads.js', signs: 'signs.js', lifts: 'lifts.js',
                     pins: 'pins.js', buildings: 'buildings.js' };
// Load steps marked by inline __loadStep('...') calls rather than files.
const INLINE_STEPS = { world: "__loadStep('world')", music: "__loadStep('music')" };

function phaseSteps(html, tags) {
  console.log('== STEPS (loader coverage) ==');
  const order = parseLoadOrder(html);
  if (!order) { fail('could not parse window.__loadOrder'); return; }
  const critical = parseCriticalKeys(html);
  if (Object.keys(critical).length === 0) warn('could not parse __criticalLoadKeys (skipping criticality)');

  // key -> list of files from data-dkey attributes
  const keyFiles = {};
  for (const t of tags) {
    if (t.key) {
      (keyFiles[t.key] = keyFiles[t.key] || []).push(t.file);
    }
  }

  let covered = 0;
  for (const key of order) {
    let okFiles = [];
    if (keyFiles[key]) {
      okFiles = keyFiles[key].filter(f => exists(path.join(DETAILED, f)));
    } else if (ZONE_FILES[key]) {
      // Zone data step: every zone must carry the file.
      const missingZones = ZONES.filter(z =>
        !exists(path.join(DETAILED, 'zones', z, ZONE_FILES[key])));
      if (missingZones.length === 0) {
        okFiles = ZONES.map(z => 'zones/' + z + '/' + ZONE_FILES[key]);
      } else {
        (critical[key] ? fail : warn)(
          'zone data step "' + key + '" missing in zones: ' + missingZones.join(', '));
        continue;
      }
    } else if (INLINE_STEPS[key]) {
      if (html.includes(INLINE_STEPS[key])) okFiles = ['(inline call site)'];
    }
    if (okFiles.length === 0) {
      (critical[key] ? fail : warn)(
        'load step "' + key + '"' + (critical[key] ? ' (CRITICAL)' : '') +
        ' resolves to no file — the progress bar would wait on it forever');
    } else {
      covered++;
    }
  }
  ok(covered + '/' + order.length + ' load steps resolve to files');
}

/* ------------------------------------------------------------------ */
/* Phase 4: boot function presence                                     */
/* ------------------------------------------------------------------ */
const REQUIRED_BOOT_FNS = [
  '__loadDeferredQueue', '__loadStep', '__tryStartGame',
  '__showCriticalWarning', '__injectZoneFiles',
];
function phaseBoot(html) {
  console.log('== BOOT (required functions) ==');
  const blocks = extractInlineBlocks(html).join('\n');
  for (const fn of REQUIRED_BOOT_FNS) {
    const defined = new RegExp('function\\s+' + fn + '\\b').test(blocks);
    if (!defined) fail('boot function not defined: ' + fn + '()');
  }
  if (!/Sim\.onTick/.test(blocks)) fail('tick registry not wired (Sim.onTick not found in inline blocks)');
  else ok('Sim.onTick registry wired');
  if (failures === 0 || REQUIRED_BOOT_FNS.every(fn =>
      new RegExp('function\\s+' + fn + '\\b').test(blocks))) {
    ok('all boot functions defined');
  }
}

/* ------------------------------------------------------------------ */
/* Phase 5: manifest / deploy cross-check                              */
/* ------------------------------------------------------------------ */
function phaseDeploy(tags) {
  console.log('== DEPLOY (manifests) ==');
  const manPath = path.join(DETAILED, 'ui-manifest.json');
  let man;
  try {
    man = JSON.parse(read(manPath));
  } catch (e) {
    fail('ui-manifest.json is not valid JSON: ' + e.message);
    return;
  }
  const listed = {};
  for (const e of man.files || []) if (e.name) listed[e.name] = e;

  // Every manifest-listed file must exist on disk (else the client 404s).
  let missing = 0;
  for (const name of Object.keys(listed)) {
    if (!exists(path.join(DETAILED, name))) {
      fail('manifest lists missing file: ' + name);
      missing++;
    }
  }
  if (missing === 0) ok(Object.keys(listed).length + ' manifest files all exist on disk');

  // Every deferred script should be listed in SOME manifest so the APK
  // updater ships it. Warn only: the web boot loads it from the repo
  // regardless.
  const allListed = {};
  for (const mf of ['ui-manifest.json', 'map-manifest.json',
                    'vehicles-manifest.json', 'music-manifest.json']) {
    try {
      const m2 = JSON.parse(read(path.join(DETAILED, mf)));
      for (const e of m2.files || []) if (e.name) allListed[e.name] = true;
    } catch (e) { /* ui-manifest already validated above; others best-effort */ }
  }
  for (const t of tags) {
    if (!allListed[t.file]) {
      warn('deferred script not in any manifest (APK updater would miss it): ' + t.file);
    }
  }

  // Version strings must match the YYYY.MM.DD.N scheme the updater reads.
  const verFiles = [
    ['ui-manifest.json', 'ui_version'],
    ['map-manifest.json', 'map_version'],
    ['vehicles-manifest.json', 'vehicles_version'],
    ['music-manifest.json', 'music_version'],
  ];
  for (const [file, key] of verFiles) {
    const p = path.join(DETAILED, file);
    if (!exists(p)) { fail('missing ' + file); continue; }
    let m;
    try { m = JSON.parse(read(p)); }
    catch (e) { fail(file + ' is not valid JSON'); continue; }
    const v = m[key];
    if (!/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(v || '')) {
      fail(file + ' ' + key + ' has bad version format: ' + JSON.stringify(v));
    }
  }
  ok('version strings valid');
}

/* ------------------------------------------------------------------ */
/* Phase 6: HTML structural sanity                                    */
/* ------------------------------------------------------------------ */
function phaseStructure(html) {
  console.log('== STRUCTURE ==');
  // Balance check with proper raw-text parsing: a <script> element's body
  // runs to the FIRST </script> after its open tag (HTML rule), so <script
  // mentions inside JS comments/strings must not be counted as tags. Walk
  // tag-by-tag, skipping each element's body.
  let opens = 0, pos = 0, unclosed = null;
  const openRe = /<script[\s>][^<]*?\/>|<script[\s>]/gi;
  while (true) {
    openRe.lastIndex = pos;
    const m = openRe.exec(html);
    if (!m) break;
    if (/\/>$/.test(m[0])) { pos = openRe.lastIndex; continue; } // self-closed (never in practice)
    opens++;
    const closeIdx = html.indexOf('</script>', openRe.lastIndex);
    if (closeIdx === -1) { unclosed = m[0].slice(0, 60); break; }
    pos = closeIdx + '</script>'.length;
  }
  if (unclosed) {
    fail('unclosed <script> tag with no </script> after it: ' + unclosed);
  } else {
    ok('script tags structurally balanced (' + opens + ' elements)');
  }
  // Cross-check: every data-dsrc="..." occurrence must have produced a
  // parsed tag. A gap means a tag so malformed the parser missed it.
  const occurrences = (html.match(/data-dsrc="/g) || []).length;
  const parsed = parseDsrcTags(html).length;
  if (occurrences !== parsed) {
    fail('data-dsrc count mismatch: ' + occurrences + ' occurrences but ' +
         parsed + ' parsed tags — a tag is malformed or swallowed');
  } else {
    ok('all ' + occurrences + ' data-dsrc tags parsed cleanly');
  }
  // Every loader overlay id the code looks up must exist statically.
  const needed = new Set();
  const re = /getElementById\('(load-[a-z-]*)'\)/g;
  let m;
  while ((m = re.exec(html)) !== null) needed.add(m[1]);
  let absent = 0;
  for (const id of needed) {
    if (!html.includes('id="' + id + '"')) {
      fail('loader overlay id referenced but missing from HTML: ' + id);
      absent++;
    }
  }
  if (absent === 0) ok(needed.size + ' loader overlay ids present');
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */
function main() {
  console.log('Surviving Adamsville pre-publish smoke test (#36)');
  console.log('root: ' + ROOT);
  const html = phaseEntry();
  if (!html) { console.log('\nSMOKE TEST: FAIL (' + failures + ' failures)'); process.exit(1); }
  const tags = phaseQueue(html);
  phaseSteps(html, tags);
  phaseBoot(html);
  phaseDeploy(tags);
  phaseStructure(html);
  console.log('\n----------------------------------------');
  if (failures > 0) {
    console.log('SMOKE TEST: FAIL — ' + failures + ' failure(s), ' +
                warnings + ' warning(s). DO NOT PUSH.');
    process.exit(1);
  }
  console.log('SMOKE TEST: PASS — ' + warnings + ' warning(s). Safe to publish.');
  process.exit(0);
}

main();
