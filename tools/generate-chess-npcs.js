#!/usr/bin/env node
/* ============================================================================
   generate-chess-npcs.js — build the chess mini-game's NPC profiles from
   Joshua's digitised prison score sheets.
   ----------------------------------------------------------------------------
   Design: ~/workspace/game-map/CHESS-NPC-DESIGN.md (Joshua, 2026-10-18).
   One NPC per real player on the sheets. A profile is GENERATED from that
   player's recorded games — never hand-authored — and every number in it
   carries its sample size, so a player with one recorded game is honestly
   a thin re-creation.

   INPUT   every  sheet*-games.json  in the scores folder (default
           ~/workspace/game-map/chess-scores). Each file: { games: [...] }
           with moves in the sheets' own long form ("Nb1-c3", "Be2xh5",
           "0-0"), exactly as transcribed, plus a byPlayer index whose
           CANONICAL keys are the NPC identities — one entry per real
           person (Joshua's is 'Da King), the sheets' spellings riding
           as aliases. NPCs are keyed off those canonical entries,
           never off a raw spelling; spellings no entry claims fall
           back to a mechanical grouping (see buildIdentities).
   ENGINE  the rules are the game's own: the ChessEngine block is lifted
           out of detailed/chess.html and used to replay every game, so
           "legal", "capture available", "gives check" and the position
           keys in the book mean exactly what they mean on the page.
   OUTPUT  detailed/chess-npcs.json (default: beside the chess.html the
           engine came from). Deterministic: same inputs -> same bytes
           (no timestamps, stable ordering everywhere).

   ADDING SHEET 2 (or 3, ...): drop sheet2-games.json into the scores
   folder and re-run this script. Existing NPCs grow in place (same id),
   new players appear. Nothing else changes — the page loads profiles
   as data at open.

   Usage: node tools/generate-chess-npcs.js [--scores DIR] [--page FILE]
          [--out FILE]
   ============================================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */
function argValue(flag, fallback) {
  var i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
var HOME = process.env.HOME || '/home/hatch';
var SCORES_DIR = argValue('--scores', path.join(HOME, 'workspace/game-map/chess-scores'));
var PAGE_FILE = argValue('--page', path.join(HOME, 'workspace/game-map/play/detailed/chess.html'));
var OUT_FILE = argValue('--out', path.join(path.dirname(PAGE_FILE), 'chess-npcs.json'));

var warnings = [];
function warn(msg) { warnings.push(msg); console.error('WARN: ' + msg); }

/* ------------------------------------------------------------------ */
/* The game's own rules engine, lifted out of chess.html               */
/* ------------------------------------------------------------------ */
function loadEngine(pageFile) {
  var html = fs.readFileSync(pageFile, 'utf8');
  var begin = html.indexOf('/* === CHESS ENGINE BEGIN === */');
  var end = html.indexOf('/* === CHESS ENGINE END === */');
  if (begin < 0 || end < 0) throw new Error('engine markers not found in ' + pageFile);
  var code = html.slice(begin, end);
  var sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code + '\nthis.ChessEngine = ChessEngine;', sandbox);
  if (!sandbox.ChessEngine) throw new Error('engine did not initialise');
  return sandbox.ChessEngine;
}

/* ------------------------------------------------------------------ */
/* The sheets' long-form notation -> { from, to, promotion }           */
/* "c2-c4"  "Nb1-c3"  "Be2xh5"  "Qh5-g4+"  "e7-e8=Q"  "0-0"  "0-0-0"   */
/* ------------------------------------------------------------------ */
function parseLongMove(raw) {
  var s = String(raw).trim().replace(/[+#]+$/, '').replace(/[!?]+$/, '');
  if (s === '0-0' || s === 'O-O') return { castle: 'K' };
  if (s === '0-0-0' || s === 'O-O-O') return { castle: 'Q' };
  var m = s.match(/^([KQRBN])?([a-h][1-8])[-x]([a-h][1-8])(?:=?([QRBN]))?$/);
  if (!m) return null;
  return { from: m[2], to: m[3], promotion: m[4] || null };
}
function moveCode(from, to, promotion) {
  return from + to + (promotion ? promotion.toLowerCase() : '');
}

/* ------------------------------------------------------------------ */
/* Player identity: many sheet spellings -> one person.                */
/*                                                                     */
/* The transcriptions stay faithful ("Joshva Arnold" is what that      */
/* sheet says); grouping is mechanical and runs in this order:        */
/*   1. same set of name words, any order ("Joshua Arnold" =           */
/*      "Arnold, Joshua")                                              */
/*   2. subset merge — a bare "Arnold" joins the ONE fuller entry      */
/*      whose words contain it                                         */
/*   3. one-letter-typo merge — word sets differing by a single word   */
/*      at edit distance <= 1 ("Joshva"/"Joshua", "Standley"/          */
/*      "Stanley")                                                     */
/* Plus one alias Joshua named himself: the sheets' Arnold IS the      */
/* player the game displays as 'Da King, so a "'Da King" index key     */
/* (the digitiser files his games under it) joins the Arnold group.    */
/* ------------------------------------------------------------------ */
function wordSet(name) {
  return String(name).toLowerCase().replace(/[^a-z\s]/g, ' ')
    .split(/\s+/).filter(Boolean).sort();
}
function levenshtein(a, b) {
  var row = [], i, j;
  for (j = 0; j <= b.length; j++) row[j] = j;
  for (i = 1; i <= a.length; i++) {
    var prev = row[0]; row[0] = i;
    for (j = 1; j <= b.length; j++) {
      var cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}
function isSubset(small, big) {
  return small.every(function (w) { return big.indexOf(w) >= 0; });
}
function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/* Two word sets describe the same man, mechanically, when:
   - they are identical, or
   - they differ by ONE word that is a one-letter typo of the other
     ("Joshva"/"Joshua", "Standley"/"Stanley"), or
   - they differ by ONE word that is an INITIAL of the other
     ("Arnold, J" / "Arnold, Joshua") with the rest of the set equal.
*/
function samePersonWords(a, b) {
  var onlyA = a.filter(function (w) { return b.indexOf(w) < 0; });
  var onlyB = b.filter(function (w) { return a.indexOf(w) < 0; });
  if (onlyA.length === 0 && onlyB.length === 0) return true;
  if (onlyA.length !== 1 || onlyB.length !== 1) return false;
  if (levenshtein(onlyA[0], onlyB[0]) <= 1) return true;
  // an initial: one side is a single letter starting the other word
  return (onlyA[0].length === 1 && onlyB[0].indexOf(onlyA[0]) === 0) ||
         (onlyB[0].length === 1 && onlyA[0].indexOf(onlyB[0]) === 0);
}

/* Group raw spellings into people (the fallback grouping, used for
   spellings no canonical byPlayer key claims). spellingCounts:
   Map spelling->games. Returns [{ spellings, words, canonical }] */
function groupPlayers(spellingCounts) {
  var groups = [];
  spellingCounts.forEach(function (count, spelling) {
    groups.push({ spellings: [spelling], words: wordSet(spelling), counts: {} });
    groups[groups.length - 1].counts[spelling] = count;
  });
  function mergeInto(dst, src) {
    src.spellings.forEach(function (s) {
      dst.spellings.push(s); dst.counts[s] = src.counts[s];
    });
    dst.words = dst.words.filter(function (w, i) { return dst.words.indexOf(w) === i; });
  }
  var changed = true;
  while (changed) {
    changed = false;
    // same-person merges (identical / typo / initial)
    outer:
    for (var i = 0; i < groups.length; i++) {
      for (var j = i + 1; j < groups.length; j++) {
        if (samePersonWords(groups[i].words, groups[j].words)) {
          mergeInto(groups[i], groups[j]);
          groups.splice(j, 1); changed = true; break outer;
        }
      }
    }
    if (changed) continue;
    // subset merge: a bare surname joins a fuller entry containing
    // it — the unique superset when there is one; otherwise the
    // superset with the most recorded games (on these sheets a bare
    // "Arnold" is the prolific Arnold, not a second man), and the
    // guess is warned about, never silent.
    for (var k = 0; k < groups.length; k++) {
      var supers = groups.filter(function (g, gi) {
        return gi !== k && groups[k].words.length < g.words.length &&
               isSubset(groups[k].words, g.words);
      });
      if (supers.length === 1) {
        mergeInto(supers[0], groups[k]);
        groups.splice(k, 1); changed = true; break;
      }
      if (supers.length > 1) {
        supers.sort(function (x, y) {
          var gx = x.spellings.reduce(function (s, sp) { return s + x.counts[sp]; }, 0);
          var gy = y.spellings.reduce(function (s, sp) { return s + y.counts[sp]; }, 0);
          return gy - gx;
        });
        warn('ambiguous bare name "' + groups[k].spellings.join(' / ') +
             '" — filed under its most-recorded match');
        mergeInto(supers[0], groups[k]);
        groups.splice(k, 1); changed = true; break;
      }
    }
  }
  // the 'Da King alias: a group whose words are exactly {da, king}
  // joins the Arnold group (Joshua's named identity, 2026-10-18).
  var kingGroup = null, arnoldGroup = null;
  groups.forEach(function (g) {
    if (g.words.join(' ') === 'da king') kingGroup = g;
    if (g.words.indexOf('arnold') >= 0) arnoldGroup = g;
  });
  if (kingGroup && arnoldGroup && kingGroup !== arnoldGroup) {
    mergeInto(arnoldGroup, kingGroup);
    groups.splice(groups.indexOf(kingGroup), 1);
  }
  // canonical sheet name per group: most-recorded spelling wins; ties
  // prefer the "Surname, First" form, then the alphabetically first —
  // deterministic either way.
  groups.forEach(function (g) {
    g.spellings.sort();
    g.canonical = g.spellings.slice().sort(function (x, y) {
      if (g.counts[y] !== g.counts[x]) return g.counts[y] - g.counts[x];
      var cx = x.indexOf(',') >= 0 ? 0 : 1, cy = y.indexOf(',') >= 0 ? 0 : 1;
      if (cx !== cy) return cx - cy;
      return x < y ? -1 : 1;
    })[0];
  });
  return groups;
}

/* ------------------------------------------------------------------ */
/* Replay one recorded game through the engine, measuring as we go.    */
/* Returns the per-ply observations + the rules' verdict at the end.   */
/* A transcription that stops replaying stops the measures too — the   */
/* validated prefix is used and the game is counted in the warnings.   */
/* ------------------------------------------------------------------ */
/* Check-availability answers are memoised across the whole run:
   positions recur between games (openings above all), and a position
   only ever has one answer. */
var checkAvailCache = {};

/* Was a checking move available in this position? Probed honestly —
   play candidate moves through the one door, read the verdict, take
   them back (apply/undo restores the exact state). Candidates are
   ordered most-likely-check first (captures, queen moves, moves
   landing near the enemy king) so the common case exits after a
   probe or two; a position with no checking move still costs a full
   scan, which is the honest price of an exact answer. */
function checkAvailableAt(engine, st, legal) {
  var cacheKey = engine.positionKey(st);
  if (Object.prototype.hasOwnProperty.call(checkAvailCache, cacheKey)) {
    return checkAvailCache[cacheKey];
  }
  var enemyKing = st.turn === 'w' ? 'k' : 'K';
  var kingSq = -1;
  for (var i = 0; i < 64; i++) if (st.board[i] === enemyKing) { kingSq = i; break; }
  var kf = kingSq % 8, kr = 8 - Math.floor(kingSq / 8);
  function probeScore(m) {
    var s = 0;
    if (m.captured) s += 4;
    if (m.piece.toUpperCase() === 'Q') s += 2;
    var df = Math.abs((m.to % 8) - kf), dr = Math.abs((8 - Math.floor(m.to / 8)) - kr);
    if (Math.max(df, dr) <= 2) s += 2;
    return s;
  }
  var ordered = legal.slice().sort(function (a, b) {
    return probeScore(b) - probeScore(a);
  });
  var found = false;
  for (var j = 0; j < ordered.length; j++) {
    var cand = ordered[j];
    var probe = engine.applyMove(st, engine.sqName(cand.from), engine.sqName(cand.to),
      cand.promotion ? cand.promotion.toUpperCase() : undefined);
    if (probe && (probe.status.check ||
        (probe.status.over && probe.status.reason === 'checkmate'))) {
      found = true;
    }
    if (probe) engine.undoMove(st);
    if (found) break;
  }
  checkAvailCache[cacheKey] = found;
  return found;
}

function replayGame(engine, game) {
  var st = engine.createGame();
  var plies = [];
  var complete = true;
  for (var i = 0; i < game.moves.length; i++) {
    var colour = st.turn;
    var keyBefore = engine.positionKey(st);
    var legal = engine.legalMoves(st, colour);
    var captureAvailable = legal.some(function (m) { return !!m.captured; });
    var checkAvailable = checkAvailableAt(engine, st, legal);
    var parsed = parseLongMove(game.moves[i]);
    if (!parsed) {
      warn(game.id + ': ply ' + (i + 1) + ' unparseable as written: "' + game.moves[i] + '"');
      complete = false; break;
    }
    var from, to, promo = parsed.promotion || undefined;
    if (parsed.castle) {
      from = colour === 'w' ? 'e1' : 'e8';
      to = parsed.castle === 'K' ? (colour === 'w' ? 'g1' : 'g8')
                                 : (colour === 'w' ? 'c1' : 'c8');
    } else { from = parsed.from; to = parsed.to; }
    var played = engine.applyMove(st, from, to, promo);
    if (!played) {
      warn(game.id + ': ply ' + (i + 1) + ' is not legal as transcribed: "' + game.moves[i] + '"');
      complete = false; break;
    }
    plies.push({
      colour: colour,
      key: keyBefore,
      code: moveCode(from, to, played.move.promotion),
      choseCapture: !!played.move.captured,
      captureAvailable: captureAvailable,
      gaveCheck: !!(played.status.check ||
                    (played.status.over && played.status.reason === 'checkmate')),
      checkAvailable: checkAvailable
    });
  }
  return { plies: plies, complete: complete, finalStatus: engine.gameStatus(st) };
}

/* How did this game end, in the profile's three plain words?
   Derived by replay, not from the sheet's prose: if the rules say the
   final position is checkmate, it was mate; if the rules end it drawn,
   or the sheet's result is a draw, it was a draw; a decisive result on
   a position the rules haven't ended can only be a resignation. */
function endingOf(game, replay) {
  if (replay.finalStatus.over && replay.finalStatus.reason === 'checkmate') return 'checkmate';
  if (game.result === '1/2-1/2') return 'draw';
  if (replay.finalStatus.over) return 'draw';
  if (game.result === '1-0' || game.result === '0-1') return 'resignation';
  return null;   // unfinished / unknown result — counted nowhere
}

/* ------------------------------------------------------------------ */
/* Identities: one group per real person.                              */
/*                                                                     */
/* PRIMARY SOURCE — the digitiser's canonical byPlayer keys. The       */
/* games files file every game under one canonical entry per person    */
/* (Joshua's canonical key is 'Da King), with the sheets' spellings    */
/* as aliases. An NPC is keyed off that canonical entry — NEVER off    */
/* a raw sheet spelling. A spelling resolves to a canonical entry by   */
/* its alias list first, then by the entry's game list (game id +      */
/* colour).                                                            */
/*                                                                     */
/* FALLBACK — spellings no canonical entry claims (and the whole run   */
/* when a file predates byPlayer, like the digitiser's draft) go       */
/* through the mechanical grouping: same word set / one-letter typo /  */
/* initial / bare-surname subset. A mechanical group that the word     */
/* rules identify with a canonical entry joins it; the rest stand as   */
/* their own people, warned about. Either way each group ends with a   */
/* stable id and a display name, and Joshua's group — however it was   */
/* keyed — displays as 'Da King.                                       */
/* ------------------------------------------------------------------ */
function buildIdentities(games, docs) {
  var entries = [];
  docs.forEach(function (doc) {
    if (!doc.byPlayer) return;
    Object.keys(doc.byPlayer).forEach(function (key) {
      var val = doc.byPlayer[key] || {};
      var aliases = new Set([String(key).toLowerCase()]);
      if (!Array.isArray(val) && Array.isArray(val.aliases)) {
        val.aliases.forEach(function (a) { aliases.add(String(a).toLowerCase()); });
      }
      var gameColours = new Map();   // game id -> [colours] ([] = either)
      var list = Array.isArray(val) ? val : (val.games || []);
      (list || []).forEach(function (e) {
        if (typeof e === 'string') { if (!gameColours.has(e)) gameColours.set(e, []); }
        else if (e && e.id) {
          if (!gameColours.has(e.id)) gameColours.set(e.id, []);
          var c = e.colour || e.color;
          if (c) gameColours.get(e.id).push(c === 'w' ? 'w' : 'b');
        }
      });
      /* The same person can be canonical in more than one book
         (T. Richards and 'Da King are in both): the books are ONE
         collection, so a repeated canonical key MERGES into the
         first entry — union of aliases and game lists. Without this,
         each book's entry became its own group and the later book's
         alias list hijacked the shared spellings, splitting one man
         into two NPCs (seen 2026-10-18: da-king/da-king-2 and
         t-richards/t-richards-2 from the two-book run). */
      var existing = null;
      entries.forEach(function (e) { if (e.key === key) existing = e; });
      if (existing) {
        aliases.forEach(function (a) { existing.aliases.add(a); });
        gameColours.forEach(function (cols, gid) {
          if (!existing.gameColours.has(gid)) {
            existing.gameColours.set(gid, cols);
          } else {
            cols.forEach(function (c) {
              if (existing.gameColours.get(gid).indexOf(c) < 0) {
                existing.gameColours.get(gid).push(c);
              }
            });
          }
        });
      } else {
        entries.push({ key: key, aliases: aliases, gameColours: gameColours });
      }
    });
  });

  var groups = [];
  var groupOf = {};
  function newGroup(canonicalKey) {
    var g = { canonicalKey: canonicalKey, spellings: [] };
    groups.push(g);
    return g;
  }
  var entryGroups = entries.map(function (e) {
    var g = newGroup(e.key); g.entry = e; return g;
  });
  var aliasToGroup = {};
  entryGroups.forEach(function (g) {
    g.entry.aliases.forEach(function (a) { aliasToGroup[a] = g; });
  });

  var unresolved = new Map();
  games.forEach(function (game) {
    [['white', 'w'], ['black', 'b']].forEach(function (side) {
      var spelling = game[side[0]], colour = side[1];
      var g = aliasToGroup[String(spelling).toLowerCase()] || null;
      if (!g) {
        var cands = entryGroups.filter(function (eg) {
          var cols = eg.entry.gameColours.get(game.id);
          return cols && (cols.length === 0 || cols.indexOf(colour) >= 0);
        });
        if (cands.length === 1) g = cands[0];
      }
      if (g) {
        groupOf[spelling] = g;
        if (g.spellings.indexOf(spelling) < 0) g.spellings.push(spelling);
      } else {
        unresolved.set(spelling, (unresolved.get(spelling) || 0) + 1);
      }
    });
  });

  if (unresolved.size) {
    groupPlayers(unresolved).forEach(function (mg) {
      var target = null;
      entryGroups.forEach(function (eg) {
        if (target) return;
        eg.entry.aliases.forEach(function (a) {
          if (!target && samePersonWords(mg.words, wordSet(a))) target = eg;
        });
      });
      var g = target || newGroup(mg.canonical);
      mg.spellings.forEach(function (s) {
        groupOf[s] = g;
        if (g.spellings.indexOf(s) < 0) g.spellings.push(s);
      });
      if (!target) {
        warn('no canonical byPlayer entry claims "' + mg.canonical +
             '" — standing as its own NPC from the mechanical grouping');
      }
    });
  }

  // canonical entries that no game resolved to still exist as
  // (empty) people only if a game names them — groups with no
  // spellings never appear in a game and are dropped.
  groups = groups.filter(function (g) { return g.spellings.length > 0; });

  var usedIds = {};
  groups.forEach(function (g) {
    var keyNorm = g.canonicalKey.replace(/^'+/, '').trim().toLowerCase();
    g.isKing = keyNorm === 'da king' ||
      g.spellings.some(function (s) { return wordSet(s).indexOf('arnold') >= 0; });
    g.displayName = g.isKing ? "'Da King" : g.canonicalKey;
    var base = g.isKing ? 'da-king' : slug(g.canonicalKey);
    g.id = base;
    var n = 2;
    while (usedIds[g.id]) { g.id = base + '-' + (n++); }
    usedIds[g.id] = true;
  });
  return { groups: groups, groupOf: groupOf };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */
function main() {
  var engine = loadEngine(PAGE_FILE);
  var files = fs.readdirSync(SCORES_DIR)
    .filter(function (f) { return /^sheet\d+-games\.json$/.test(f); })
    .sort();
  var docs = files.map(function (f) {
    return JSON.parse(fs.readFileSync(path.join(SCORES_DIR, f), 'utf8'));
  });
  var games = [];
  docs.forEach(function (doc) {
    (doc.games || []).forEach(function (g) { games.push(g); });
  });

  // identity: canonical byPlayer keys first, mechanical grouping as
  // the fallback — one group per real person either way.
  var identities = buildIdentities(games, docs);
  var groups = identities.groups;
  var groupOf = identities.groupOf;

  // accumulate
  groups.forEach(function (g) {
    g.gamesRecorded = 0; g.validatedGames = 0;
    g.colours = { w: 0, b: 0 };
    g.record = { wins: 0, losses: 0, draws: 0, n: 0 };
    g.lengths = { total: 0, n: 0 };
    g.endings = { checkmate: 0, resignation: 0, draw: 0, n: 0 };
    g.firstMoves = { w: {}, b: {} };
    g.tend = { plies: 0, capChose: 0, capAvail: 0, chkChose: 0, chkAvail: 0 };
    g.book = { w: {}, b: {} };   // key -> { code -> count }
  });

  games.forEach(function (game) {
    console.log('replaying ' + game.id + ' (' + game.moves.length + ' plies)…');
    var replay = replayGame(engine, game);
    if (!replay.complete) {
      warn(game.id + ': only ' + replay.plies.length + ' of ' + game.moves.length +
           ' plies replayed; book/tendencies use the validated prefix');
    }
    var sides = [
      { group: groupOf[game.white], colour: 'w' },
      { group: groupOf[game.black], colour: 'b' }
    ];
    sides.forEach(function (side) {
      var g = side.group;
      if (!g) { warn(game.id + ': ungrouped player name'); return; }
      g.gamesRecorded++;
      if (replay.complete) g.validatedGames++;
      g.colours[side.colour]++;
      // result from this player's side
      if (game.result === '1-0' || game.result === '0-1' || game.result === '1/2-1/2') {
        var won = (game.result === '1-0' && side.colour === 'w') ||
                  (game.result === '0-1' && side.colour === 'b');
        if (game.result === '1/2-1/2') g.record.draws++;
        else if (won) g.record.wins++; else g.record.losses++;
        g.record.n++;
        var ending = endingOf(game, replay);
        if (ending) { g.endings[ending]++; g.endings.n++; }
      }
      g.lengths.total += game.moves.length; g.lengths.n++;
    });
    replay.plies.forEach(function (ply, idx) {
      var g = groupOf[ply.colour === 'w' ? game.white : game.black];
      if (!g) return;
      var t = g.tend;
      t.plies++;
      if (ply.captureAvailable) { t.capAvail++; if (ply.choseCapture) t.capChose++; }
      if (ply.checkAvailable) { t.chkAvail++; if (ply.gaveCheck) t.chkChose++; }
      var bookFor = g.book[ply.colour];
      if (!bookFor[ply.key]) bookFor[ply.key] = {};
      bookFor[ply.key][ply.code] = (bookFor[ply.key][ply.code] || 0) + 1;
      if (idx === 0 || idx === 1) {
        // first move of the game for White (ply 0) / first reply for Black (ply 1)
        var fm = g.firstMoves[ply.colour];
        fm[ply.code] = (fm[ply.code] || 0) + 1;
      }
    });
  });

  // emit — everything sorted, nothing dated: deterministic bytes.
  function rate(chose, avail) {
    return avail > 0 ? Math.round((chose / avail) * 1000) / 1000 : null;
  }
  function moveList(counts) {
    return Object.keys(counts).map(function (m) { return { m: m, n: counts[m] }; })
      .sort(function (a, b) { return b.n - a.n || (a.m < b.m ? -1 : 1); });
  }
  var npcs = groups.map(function (g) {
    function bookList(colour) {
      return Object.keys(g.book[colour]).sort().map(function (key) {
        return { key: key, moves: moveList(g.book[colour][key]) };
      });
    }
    return {
      id: g.id,
      displayName: g.displayName,
      sheetNames: g.spellings.slice().sort(),
      gamesRecorded: g.gamesRecorded,
      validatedGames: g.validatedGames,
      colours: g.colours,
      record: g.record,
      gameLengthsPlies: {
        mean: g.lengths.n ? Math.round((g.lengths.total / g.lengths.n) * 100) / 100 : null,
        n: g.lengths.n
      },
      endings: g.endings,
      firstMoves: { w: moveList(g.firstMoves.w), b: moveList(g.firstMoves.b) },
      tendencies: {
        plies: g.tend.plies,
        capture: { chose: g.tend.capChose, available: g.tend.capAvail,
                   rate: rate(g.tend.capChose, g.tend.capAvail) },
        check: { chose: g.tend.chkChose, available: g.tend.chkAvail,
                 rate: rate(g.tend.chkChose, g.tend.chkAvail) }
      },
      book: { w: bookList('w'), b: bookList('b') }
    };
  }).sort(function (a, b) { return a.id < b.id ? -1 : 1; });

  var out = {
    schema: 1,
    kind: 'chess-npc-profiles',
    generatedBy: 'tools/generate-chess-npcs.js',
    sourceFiles: files,
    npcs: npcs
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n');
  console.log('wrote ' + OUT_FILE + ' — ' + npcs.length + ' NPCs from ' +
              games.length + ' games in ' + files.length + ' file(s)');
  npcs.forEach(function (n) {
    console.log('  ' + n.displayName + ' (' + n.id + '): ' + n.gamesRecorded +
                ' games, ' + n.tendencies.plies + ' plies, book w' +
                n.book.w.length + '/b' + n.book.b.length + ' positions');
  });
  if (warnings.length) console.log(warnings.length + ' warning(s) — see above');
}

main();
