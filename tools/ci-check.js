#!/usr/bin/env node
/**
 * ci-check.js — Surviving Adamsville CI gate.
 *
 * Run by .github/workflows/ci.yml on every push. Two phases:
 *   1. SYNTAX  — `node --check` on every deployable .js file plus every inline
 *                <script> block (plain AND text/x-deferred) in the two index.html
 *                entry points. Broken JS must never reach Joshua's phone.
 *   2. MANIFESTS — each manifest is valid JSON and its recorded hashes/sizes
 *                match the actual file contents on disk.
 *                  ui-manifest.json        -> full sha256
 *                  map-manifest.json       -> sha256 truncated to 16 hex chars
 *                  vehicles-manifest.json  -> full sha256
 *                  music-manifest.json     -> size only (no hashes stored)
 *
 * Any failure prints the offending file and exits 1 so the workflow goes red.
 * Run locally:  node .github/workflows/ci-check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');

// Repo root = one level up from tools/
const ROOT = path.resolve(__dirname, '..');
const DETAILED = path.join(ROOT, 'detailed');

let failures = 0;
function fail(msg) { failures++; console.error('  FAIL: ' + msg); }
function ok(msg)   { console.log('  ok: ' + msg); }

/* ------------------------------------------------------------------ */
/* Phase 1: syntax check                                              */
/* ------------------------------------------------------------------ */
function collectJsFiles() {
  const out = [];
  // Root-level legacy scripts
  for (const n of fs.readdirSync(ROOT)) {
    if (n.endsWith('.js') && !n.includes('.bak')) out.push(path.join(ROOT, n));
  }
  // Everything under detailed/, recursive, skipping backups
  const walk = (dir) => {
    for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
      if (n.name.includes('.bak')) continue;
      const p = path.join(dir, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.name.endsWith('.js')) out.push(p);
    }
  };
  walk(DETAILED);
  return out;
}

function extractInlineBlocks(htmlPath) {
  // Pull out <script>...</script> blocks that have NO src= and NO data-dsrc=
  // (inline game code), including type="text/x-deferred" blocks (they run via
  // eval after launch). HTML comments are stripped first so a <script> example
  // inside a comment can't mis-pair the matcher.
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  const blocks = [];
  const re = /<script(?![^>]*(?:\bsrc=|\bdata-dsrc=))[^>]*>([\s\S]*?)<\/script>/gi;
  let m, i = 0;
  while ((m = re.exec(html)) !== null) {
    const code = m[1].trim();
    if (code) blocks.push({ name: path.basename(htmlPath) + '#inline' + (++i), code });
  }
  return blocks;
}

function syntaxCheck() {
  console.log('== SYNTAX ==');
  let checked = 0;
  for (const f of collectJsFiles()) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
      checked++;
    } catch (e) {
      fail('syntax error in ' + path.relative(ROOT, f) + '\n' + (e.stderr || e.stdout || e.message));
    }
  }
  for (const html of [path.join(DETAILED, 'index.html'), path.join(ROOT, 'index.html')]) {
    if (!fs.existsSync(html)) { fail('missing entry point ' + html); continue; }
    for (const b of extractInlineBlocks(html)) {
      const tmp = path.join(os.tmpdir(), 'ci-inline-' + process.pid + '-' + checked + '.js');
      fs.writeFileSync(tmp, b.code);
      try {
        execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
        checked++;
      } catch (e) {
        fail('syntax error in inline block ' + b.name + '\n' + (e.stderr || e.stdout || e.message));
      } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
      }
    }
  }
  if (failures === 0) ok(checked + ' files/blocks syntax-checked');
}

/* ------------------------------------------------------------------ */
/* Phase 2: manifest validation                                        */
/* ------------------------------------------------------------------ */
const MANIFESTS = [
  // [file, hashMode] — 'full' = sha256 hexdigest, 'short16' = first 16 chars, 'size' = size only
  ['detailed/ui-manifest.json', 'full'],
  ['detailed/map-manifest.json', 'short16'],
  ['detailed/vehicles-manifest.json', 'full'],
  ['detailed/music-manifest.json', 'size'],
];

function manifestsCheck() {
  console.log('== MANIFESTS ==');
  for (const [rel, mode] of MANIFESTS) {
    const p = path.join(ROOT, rel);
    let man;
    try {
      man = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      fail(rel + ' is not valid JSON: ' + e.message);
      continue;
    }
    const files = man.files;
    if (!Array.isArray(files)) { fail(rel + ' has no "files" array'); continue; }
    let n = 0;
    for (const f of files) {
      const fp = path.join(DETAILED, f.name);
      let data;
      try {
        data = fs.readFileSync(fp);
      } catch (e) {
        fail(rel + ': listed file missing on disk: ' + f.name);
        continue;
      }
      if (f.size !== undefined && f.size !== data.length) {
        fail(rel + ': size mismatch for ' + f.name + ' (manifest ' + f.size + ', disk ' + data.length + ')');
        continue;
      }
      if (mode === 'full' || mode === 'short16') {
        const h = crypto.createHash('sha256').update(data).digest('hex');
        const want = mode === 'full' ? h : h.slice(0, 16);
        if (f.sha256 !== want) {
          fail(rel + ': hash mismatch for ' + f.name);
          continue;
        }
      }
      n++;
    }
    console.log('  ' + rel + ': ' + n + '/' + files.length + ' entries verified');
  }
  if (failures === 0) ok('all manifests valid');

  // Non-blocking: warn about deployable files no manifest covers (visibility only).
  const covered = new Set();
  for (const [rel] of MANIFESTS) {
    try {
      for (const f of JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')).files) covered.add(f.name);
    } catch (_) {}
  }
  const walkUncovered = (dir, out) => {
    for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
      if (n.name.includes('.bak')) continue;
      const p = path.join(dir, n.name);
      if (n.isDirectory()) { walkUncovered(p, out); continue; }
      if (/\.(js|bin|mp3|ogg|wav)$/.test(n.name)) {
        const rel = path.relative(DETAILED, p);
        if (!covered.has(rel)) out.push(rel);
      }
    }
  };
  const uncovered = [];
  walkUncovered(DETAILED, uncovered);
  for (const u of uncovered) console.log('  warn: no manifest covers ' + u + ' (not hash-checked)');
}

/* ------------------------------------------------------------------ */
syntaxCheck();
manifestsCheck();
console.log(failures === 0 ? '\nCI PASS' : '\nCI FAIL (' + failures + ' problem(s))');
process.exit(failures === 0 ? 0 : 1);
