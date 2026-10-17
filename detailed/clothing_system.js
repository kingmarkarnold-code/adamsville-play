/* ============================================================================
   CLOTHING SYSTEM v1.0 (2026-10-11) — player wardrobe, closet UI, mall store
   ----------------------------------------------------------------------------
   WHAT IT DOES
     - Keeps the player's clothing (shirt / pants / shoes) in a wardrobe
       that persists in localStorage ('adamsville_wardrobe').
     - openWardrobe(): fullscreen closet UI — tap a swatch to change clothes
       instantly. Called by the interior system when the player uses a closet.
     - openStore():  mall clothing-store UI — "buy" extra outfits (free for
       now; prices/currency come later). Called by a mall interaction.
     - updateAppearance(): recolors the hero by SWAPPING materials on
       player.mesh — never mutating them, because toonMat() materials are
       cached per color and SHARED with NPCs (mutating would recolor
       strangers too).

   INTEGRATION (for the build agent, not done here)
     - Add <script data-dsrc="clothing_system.js" data-dkey=""> to index.html
       (deferred queue, after shirt_designs.js) and register the file in
       ui-manifest.json with a fresh sha256, then bump ui_version.
     - The interior system calls window.ClothingSystem.openWardrobe() at a
       closet; the mall calls window.ClothingSystem.openStore().

   Reads : window.player / player.mesh / player.rig (hero built by
           buildHero), window.ShirtDesigns, window.toonMat, showToast.
   Writes: window.ClothingSystem, localStorage 'adamsville_wardrobe'.
   Safe   : everything is guarded — if the hero isn't built yet (or THREE
           is missing) the module just waits / no-ops. No index.html edits
           needed by this file.
   ============================================================================ */
(function(){
'use strict';

/* ---- re-execution guard: hot-reload must never double-init this module -- */
if (window.ClothingSystem && window.ClothingSystem.__clothingV === 1) return;

/* ============================ constants ================================== */
/* localStorage key for the whole wardrobe state. */
var STORAGE_KEY = 'adamsville_wardrobe';

/* Build-time colors used by buildHero() in index.html. The hero always
   spawns wearing these; every recolor is measured FROM these (or from the
   previously equipped outfit) TO the newly equipped one. */
var DEFAULT_SHIRT_HEX = 0xc23b2e;   /* SHIRT — red tee   */
var DEFAULT_PANTS_HEX = 0x2e4a6b;   /* PANTS — blue jeans */
var DEFAULT_SHOE_HEX  = 0xf2f2f2;   /* SHOE  — white sneakers */
var CATEGORIES = ['shirt', 'pants', 'shoes'];

/* ============================ item catalog ================================ */
/* Starting wardrobe — everything the player owns on a fresh save. */
var DEFAULT_ITEMS = [
  /* shirts */
  { id:'shirt_red',   name:'Red Tee',       category:'shirt', color:0xc23b2e, owned:true },
  { id:'shirt_blue',  name:'Blue Tee',      category:'shirt', color:0x2e5aac, owned:true },
  { id:'shirt_white', name:'White Tee',     category:'shirt', color:0xf2f2f2, owned:true },
  { id:'shirt_black', name:'Black Tee',     category:'shirt', color:0x1a1a1a, owned:true },
  /* pants */
  { id:'pants_blue',  name:'Blue Jeans',    category:'pants', color:0x2e4a6b, owned:true },
  { id:'pants_black', name:'Black Jeans',   category:'pants', color:0x1a1a1a, owned:true },
  { id:'pants_khaki', name:'Khaki',         category:'pants', color:0xc2b280, owned:true },
  /* shoes */
  { id:'shoes_white', name:'White Sneakers',category:'shoes', color:0xf2f2f2, owned:true },
  { id:'shoes_black', name:'Black Shoes',   category:'shoes', color:0x1a1a1a, owned:true },
  { id:'shoes_brown', name:'Brown Boots',   category:'shoes', color:0x5a3a1a, owned:true }
];

/* Mall clothing-store stock — NOT owned until "bought" (free placeholder). */
var STORE_ITEMS = [
  { id:'shirt_green',  name:'Green Tee',    category:'shirt', color:0x2e7a4a, owned:false },
  { id:'shirt_orange', name:'Orange Tee',   category:'shirt', color:0xe06a1a, owned:false },
  { id:'shirt_purple', name:'Purple Tee',   category:'shirt', color:0x6a2e8a, owned:false },
  { id:'shirt_gray',   name:'Gray Tee',     category:'shirt', color:0x808080, owned:false },
  { id:'pants_gray',   name:'Gray Slacks',  category:'pants', color:0x555a60, owned:false },
  { id:'pants_brown',  name:'Brown Pants',  category:'pants', color:0x6b4a2e, owned:false },
  { id:'shoes_red',    name:'Red Sneakers', category:'shoes', color:0xb03024, owned:false },
  { id:'shoes_tan',    name:'Tan Loafers',  category:'shoes', color:0xc2a06b, owned:false }
];

/* Full master catalog (wardrobe + store). New items added here in future
   versions merge into existing saves automatically on load. */
var ALL_ITEMS = DEFAULT_ITEMS.concat(STORE_ITEMS);

/* Find an item by id in the player's live wardrobe list. */
function findItem(id){
  if (!id || !state.wardrobe) return null;
  for (var i = 0; i < state.wardrobe.length; i++){
    if (state.wardrobe[i].id === id) return state.wardrobe[i];
  }
  return null;
}

/* 0xRRGGBB -> '#rrggbb' CSS string. */
function hexToCss(hex){
  return '#' + ('000000' + (hex >>> 0).toString(16)).slice(-6);
}

/* ============================ state ======================================= */
/* state.wardrobe : live array of {id,name,category,color,owned}.
   state.equipped : {shirt:<id>, pants:<id>, shoes:<id>} currently worn. */
var state = {
  wardrobe: [],
  equipped: { shirt:'shirt_red', pants:'pants_blue', shoes:'shoes_white' }
};

/* Load from localStorage, merging saved owned-flags / equipped ids onto the
   master catalog so future item additions never vanish from old saves. */
function loadState(){
  var savedOwned = {}, savedEquipped = null;
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (raw){
      var s = JSON.parse(raw);
      if (s && typeof s === 'object'){
        savedOwned = s.owned || {};
        savedEquipped = s.equipped || null;
      }
    }
  } catch (e) { /* corrupted save -> fall back to defaults */ }

  state.wardrobe = ALL_ITEMS.map(function(it){
    return {
      id: it.id,
      name: it.name,
      category: it.category,
      color: it.color,
      owned: (savedOwned[it.id] !== undefined) ? !!savedOwned[it.id] : !!it.owned
    };
  });

  /* Equipped ids are only honored if the item exists AND is owned;
     otherwise the build default wins (prevents "naked" states). */
  state.equipped = { shirt:'shirt_red', pants:'pants_blue', shoes:'shoes_white' };
  if (savedEquipped){
    CATEGORIES.forEach(function(cat){
      var id = savedEquipped[cat];
      var it = id && findItem(id);
      if (it && it.owned && it.category === cat) state.equipped[cat] = id;
    });
  }
}

/* Persist owned flags + equipped ids (compact: colors live in the catalog). */
function saveState(){
  try {
    var owned = {};
    state.wardrobe.forEach(function(it){ owned[it.id] = !!it.owned; });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: 1, owned: owned, equipped: state.equipped
    }));
  } catch (e) { /* storage full / private mode — wardrobe just won't persist */ }
}

/* Hex colors of the currently equipped outfit, e.g. {shirt:0x…,…}. */
function currentHexes(){
  var out = {};
  CATEGORIES.forEach(function(cat){
    var it = findItem(state.equipped[cat]);
    out[cat] = it ? it.color : { shirt:DEFAULT_SHIRT_HEX,
                                 pants:DEFAULT_PANTS_HEX,
                                 shoes:DEFAULT_SHOE_HEX }[cat];
  });
  return out;
}

/* ============================ hero helpers ================================ */
/* The hero object (global `player`, built by buildHero in index.html). */
function hero(){
  try { return (typeof player !== 'undefined' && player) ? player : null; }
  catch (e) { return null; }
}

/* Material for a clothing color. toonMat() is the game's shared toon palette;
   Lambert is the fallback if the palette helper hasn't loaded (or THREE is
   AWOL — then we return null and the caller skips the swap safely). */
function matFor(hex){
  try {
    if (typeof toonMat === 'function'){
      var m = toonMat(hex);
      if (m) return m;
    }
    if (typeof THREE !== 'undefined' && THREE.MeshLambertMaterial){
      return new THREE.MeshLambertMaterial({ color: hex });
    }
  } catch (e) {}
  return null;
}

/* Hex color of a material, or null if it has no readable color. */
function hexOf(mat){
  try { return (mat && mat.color && mat.color.getHex) ? mat.color.getHex() : null; }
  catch (e) { return null; }
}

/* Box dimensions of a mesh ({w,h,d}), or null for non-box geometry. */
function boxDims(mesh){
  try {
    var p = mesh && mesh.geometry && mesh.geometry.parameters;
    if (p && typeof p.width === 'number' && typeof p.height === 'number' &&
        typeof p.depth === 'number'){
      return { w: p.width, h: p.height, d: p.depth };
    }
  } catch (e) {}
  return null;
}

/* Shoe meshes are flat boxes (hero shoe: 0.14 x 0.10 x 0.27). */
function isShoeShape(mesh){
  var d = boxDims(mesh);
  return !!d && d.h <= 0.14 && d.d >= 0.20;
}

/* Pants meshes are tall narrow boxes (thigh/shin: 0.15 x 0.40 x 0.15). */
function isPantsShape(mesh){
  var d = boxDims(mesh);
  return !!d && d.h >= 0.35;
}

/* True if a mesh lives inside one of the hero's leg groups.
   Preferred path: walk up the parent chain to player.rig.legL/legR (the
   hp groups). Fallback (rig missing): shape heuristic — tall or flat
   boxes are leg parts. This keeps shirt/pants/shoe recolors from ever
   bleeding into each other even when two categories share a hex value
   (e.g. Black Tee 0x1a1a1a + Black Jeans 0x1a1a1a). */
function isLegMesh(mesh){
  try {
    var p = hero();
    var rig = p && p.rig;
    if (rig){
      var a = (rig.legL && rig.legL.hp) || null;
      var b = (rig.legR && rig.legR.hp) || null;
      var n = mesh;
      while (n){
        if (n === a || n === b) return true;
        n = n.parent;
      }
      return false;
    }
  } catch (e) {}
  return isPantsShape(mesh) || isShoeShape(mesh);
}

/* ============================ appearance ================================== */
/* Replace the shirt-design torso's 6-material array with a fresh set drawn
   in the new base color (front face keeps the PLAYER emblem, redrawn on the
   new color by ShirtDesigns.makeShirtMats). Old GPU resources are released,
   EXCEPT the 5 plain cached toonMat faces — those belong to the shared
   palette cache (NPCs may still use them), so we must NOT dispose them. */
function replaceTorsoMats(mesh, prevHex, nextHex){
  var oldMats = mesh.material;
  try {
    if (typeof ShirtDesigns !== 'undefined' && ShirtDesigns &&
        typeof ShirtDesigns.makeShirtMats === 'function'){
      var fresh = ShirtDesigns.makeShirtMats(nextHex, 'PLAYER');
      if (fresh && fresh.length === 6){
        mesh.material = fresh;
        disposeTorsoMats(oldMats);
        return;
      }
    }
  } catch (e) { /* fall through to the color-swap fallback */ }

  /* Fallback (ShirtDesigns missing): swap only the plain, untextured faces
     by color match; the design face keeps its old base color. Documented
     limitation — see header. */
  var newMat = matFor(nextHex);
  if (Array.isArray(oldMats) && newMat){
    mesh.material = oldMats.map(function(m){
      return (m && !m.map && hexOf(m) === prevHex) ? newMat : m;
    });
  }
}

/* Dispose ONLY the unique textured front material of an old torso array.
   Plain cached toonMat faces are shared game-wide — disposing them would
   break every other character wearing that color. */
function disposeTorsoMats(mats){
  if (!Array.isArray(mats)) return;
  mats.forEach(function(m){
    try {
      if (m && m.map){
        if (m.map.dispose) m.map.dispose();
        if (m.dispose) m.dispose();
      }
    } catch (e) {}
  });
}

/* Recolor the shirt: torso array gets rebuilt; every other non-leg mesh
   whose material matches the OLD shirt hex gets the new material SWAPPED
   in (shoulders, sleeves). Legs are skipped so a same-hex pants/shoe item
   can never be caught by a shirt change. */
function applyShirt(prevHex, nextHex){
  var p = hero();
  if (!p || !p.mesh || !p.mesh.traverse) return;
  var newMat = matFor(nextHex);
  if (!newMat) return;
  p.mesh.traverse(function(o){
    if (!o.isMesh) return;
    var m = o.material;
    /* Shirt-design torso: the only hero mesh with a 6-material array. */
    if (Array.isArray(m) && m.length === 6){
      replaceTorsoMats(o, prevHex, nextHex);
      return;
    }
    if (isLegMesh(o)) return;
    if (m && !Array.isArray(m) && hexOf(m) === prevHex){
      /* SWAP the reference — never mutate m.color, the cached instance may
         be shared with NPCs. */
      o.material = newMat;
    }
  });
}

/* Recolor pants (shoeMode=false) or shoes (shoeMode=true). Only leg-subtree
   meshes are considered, and shoe vs pants is split by geometry shape, so a
   same-hex shirt can never be caught by a pants/shoe change. */
function applyLegs(prevHex, nextHex, shoeMode){
  var p = hero();
  if (!p || !p.mesh || !p.mesh.traverse) return;
  var newMat = matFor(nextHex);
  if (!newMat) return;
  p.mesh.traverse(function(o){
    if (!o.isMesh || !isLegMesh(o)) return;
    if (isShoeShape(o) !== shoeMode) return;
    var m = o.material;
    if (m && !Array.isArray(m) && hexOf(m) === prevHex){
      o.material = newMat;   /* swap, don't mutate — shared cache */
    }
  });
}

/* Recolor the hero from one outfit to another.
   prev/next: {shirt:<hex>, pants:<hex>, shoes:<hex>}.
   Best-effort: silently no-ops when the hero isn't built yet or a material
   can't be found. Returns true if the hero mesh existed. */
function updateAppearance(prev, next){
  var p = hero();
  if (!p || !p.mesh) return false;
  prev = prev || {}; next = next || {};
  if (prev.shirt !== next.shirt &&
      prev.shirt !== undefined && next.shirt !== undefined){
    applyShirt(prev.shirt, next.shirt);
  }
  if (prev.pants !== next.pants &&
      prev.pants !== undefined && next.pants !== undefined){
    applyLegs(prev.pants, next.pants, false);
  }
  if (prev.shoes !== next.shoes &&
      prev.shoes !== undefined && next.shoes !== undefined){
    applyLegs(prev.shoes, next.shoes, true);
  }
  return true;
}

/* Re-apply the currently equipped outfit to the hero. Assumes the hero mesh
   is in its buildHero() default colors (true for a freshly spawned hero, and
   for the boot-time apply below). If the mesh was recolored by other means,
   the color matching may no-op instead of guessing — documented, safe. */
function refresh(){
  return updateAppearance(
    { shirt:DEFAULT_SHIRT_HEX, pants:DEFAULT_PANTS_HEX, shoes:DEFAULT_SHOE_HEX },
    currentHexes()
  );
}

/* ============================ public actions ============================== */
/* Equip an owned wardrobe item immediately: updates state, persists,
   recolors the hero, re-renders the open UI, toasts a confirmation. */
function equipItem(id){
  var item = findItem(id);
  if (!item || !item.owned) return false;
  var cat = item.category;
  if (state.equipped[cat] === id){
    toast(item.name + ' is already equipped');
    return true;
  }
  var prevHexes = currentHexes();
  state.equipped[cat] = id;
  saveState();
  updateAppearance(prevHexes, currentHexes());
  if (uiMode === 'wardrobe') renderWardrobe();
  toast('Equipped ' + item.name);
  return true;
}

/* "Buy" a store item. PLACEHOLDER: no currency system exists yet, so every
   purchase is free — the item is simply added to the wardrobe. */
function buyItem(id){
  var item = findItem(id);
  if (!item) return false;
  if (item.owned){
    toast(item.name + ' is already in your wardrobe');
    return true;
  }
  item.owned = true;
  saveState();
  if (uiMode === 'store') renderStore();
  toast('Added to wardrobe: ' + item.name);
  return true;
}

/* Equipped item ids, e.g. {shirt:'shirt_red', pants:'pants_blue',
   shoes:'shoes_white'}. Returns a copy so callers can't corrupt state. */
function getEquipped(){
  return { shirt:state.equipped.shirt,
           pants:state.equipped.pants,
           shoes:state.equipped.shoes };
}

/* ============================ toast ======================================= */
/* Uses the game's showToast when available; otherwise a tiny local fallback
   so the UI still confirms taps on any page. */
var _fallbackToastEl = null;
function toast(msg){
  try {
    if (typeof showToast === 'function'){ showToast(msg, 1800); return; }
  } catch (e) {}
  try {
    if (!_fallbackToastEl){
      _fallbackToastEl = document.createElement('div');
      var s = _fallbackToastEl.style;
      s.position = 'fixed'; s.left = '50%'; s.bottom = '26px';
      s.transform = 'translateX(-50%)'; s.zIndex = '2147483001';
      s.background = 'rgba(20,24,32,.95)'; s.color = '#fff';
      s.padding = '12px 18px'; s.borderRadius = '10px';
      s.fontSize = '15px'; s.fontFamily = 'system-ui,sans-serif';
      s.display = 'none'; s.maxWidth = '86vw'; s.textAlign = 'center';
      document.body.appendChild(_fallbackToastEl);
    }
    _fallbackToastEl.textContent = msg;
    _fallbackToastEl.style.display = 'block';
    clearTimeout(_fallbackToastEl._t);
    _fallbackToastEl._t = setTimeout(function(){
      _fallbackToastEl.style.display = 'none';
    }, 1800);
  } catch (e) {}
}

/* ============================ wardrobe / store UI ========================= */
/* One reusable fullscreen overlay for both modes ('wardrobe' | 'store').
   Built lazily on first open; inline CSS only (no stylesheet dependency).
   Big tap targets + touch-action:manipulation for the TCL phone. */
var _overlay = null;
var _overlayBody = null;
var _overlayTitle = null;
var uiMode = null;

var CAT_LABELS = { shirt:'Shirts', pants:'Pants', shoes:'Shoes' };

function baseStyles(el, styles){
  for (var k in styles){ el.style[k] = styles[k]; }
  return el;
}

function ensureOverlay(){
  if (_overlay) return;
  _overlay = document.createElement('div');
  baseStyles(_overlay, {
    position:'fixed', inset:'0', zIndex:'2147483000',
    background:'rgba(6,8,12,.96)', color:'#f2f2f2',
    display:'none', flexDirection:'column',
    fontFamily:'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    touchAction:'manipulation', WebkitTapHighlightColor:'transparent'
  });

  /* header: title + big close button */
  var head = document.createElement('div');
  baseStyles(head, {
    display:'flex', alignItems:'center', justifyContent:'space-between',
    padding:'14px 16px', borderBottom:'1px solid #2a3342', flexShrink:'0'
  });
  _overlayTitle = document.createElement('div');
  baseStyles(_overlayTitle, { fontSize:'22px', fontWeight:'800' });
  var close = document.createElement('button');
  close.textContent = '✕ Close';
  baseStyles(close, {
    minWidth:'88px', minHeight:'52px', fontSize:'17px', fontWeight:'700',
    color:'#fff', background:'#3a4356', border:'none', borderRadius:'12px',
    padding:'10px 16px', cursor:'pointer'
  });
  close.addEventListener('click', closeUI);
  head.appendChild(_overlayTitle);
  head.appendChild(close);
  _overlay.appendChild(head);

  /* scrollable body */
  _overlayBody = document.createElement('div');
  baseStyles(_overlayBody, {
    overflowY:'auto', WebkitOverflowScrolling:'touch',
    padding:'6px 14px 30px', flexGrow:'1'
  });
  _overlay.appendChild(_overlayBody);

  document.body.appendChild(_overlay);
}

function closeUI(){
  uiMode = null;
  if (_overlay) _overlay.style.display = 'none';
}

function openUI(mode){
  uiMode = mode;
  ensureOverlay();
  if (mode === 'store') renderStore(); else renderWardrobe();
  _overlay.style.display = 'flex';
}

/* One owned-item button: color swatch + name. Tapping equips it. */
function makeItemButton(item){
  var equipped = state.equipped[item.category] === item.id;
  var b = document.createElement('button');
  baseStyles(b, {
    display:'flex', flexDirection:'column', alignItems:'center', gap:'8px',
    minHeight:'104px', padding:'12px 6px', fontSize:'14px', color:'#f2f2f2',
    background: equipped ? '#1d3a24' : '#161c28',
    border: equipped ? '3px solid #4caf50' : '3px solid #2a3342',
    borderRadius:'14px', cursor:'pointer'
  });
  var sw = document.createElement('div');
  baseStyles(sw, {
    width:'46px', height:'46px', borderRadius:'50%',
    background:hexToCss(item.color), border:'2px solid #8a93a5', flexShrink:'0'
  });
  var nm = document.createElement('div');
  nm.textContent = item.name;
  baseStyles(nm, { textAlign:'center', lineHeight:'1.25' });
  b.appendChild(sw);
  b.appendChild(nm);
  if (equipped){
    var tag = document.createElement('div');
    tag.textContent = '✓ Equipped';
    baseStyles(tag, { fontSize:'12px', fontWeight:'800', color:'#7be382' });
    b.appendChild(tag);
  }
  b.addEventListener('click', function(){ equipItem(item.id); });
  return b;
}

/* Wardrobe UI: three sections (Shirts / Pants / Shoes) of owned items. */
function renderWardrobe(){
  _overlayTitle.textContent = 'Wardrobe';
  _overlayBody.innerHTML = '';
  CATEGORIES.forEach(function(cat){
    var h = document.createElement('div');
    h.textContent = CAT_LABELS[cat];
    baseStyles(h, { fontSize:'18px', fontWeight:'800', margin:'18px 2px 10px' });
    _overlayBody.appendChild(h);
    var grid = document.createElement('div');
    baseStyles(grid, {
      display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(100px,1fr))',
      gap:'10px'
    });
    var any = false;
    state.wardrobe.forEach(function(item){
      if (item.category === cat && item.owned){
        grid.appendChild(makeItemButton(item));
        any = true;
      }
    });
    if (!any){
      var none = document.createElement('div');
      none.textContent = 'Nothing here yet — visit the mall clothing store.';
      baseStyles(none, { color:'#8a93a5', fontSize:'14px', padding:'8px 2px' });
      grid.appendChild(none);
    }
    _overlayBody.appendChild(grid);
  });
}

/* Store UI: every catalog item with a Buy (free placeholder) button. */
function renderStore(){
  _overlayTitle.textContent = 'Clothing Store';
  _overlayBody.innerHTML = '';

  var note = document.createElement('div');
  note.textContent = 'Prices & currency coming later — everything is FREE for now.';
  baseStyles(note, {
    background:'#2a2410', border:'1px solid #8a6a1f', color:'#f2e6c8',
    borderRadius:'10px', padding:'12px', margin:'14px 0 4px', fontSize:'14px'
  });
  _overlayBody.appendChild(note);

  CATEGORIES.forEach(function(cat){
    var h = document.createElement('div');
    h.textContent = CAT_LABELS[cat];
    baseStyles(h, { fontSize:'18px', fontWeight:'800', margin:'18px 2px 10px' });
    _overlayBody.appendChild(h);
    var grid = document.createElement('div');
    baseStyles(grid, {
      display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(100px,1fr))',
      gap:'10px'
    });
    state.wardrobe.forEach(function(item){
      if (item.category !== cat) return;
      var card = document.createElement('div');
      baseStyles(card, {
        display:'flex', flexDirection:'column', alignItems:'center', gap:'8px',
        padding:'12px 6px', background:'#161c28', border:'3px solid #2a3342',
        borderRadius:'14px', minHeight:'150px'
      });
      var sw = document.createElement('div');
      baseStyles(sw, {
        width:'46px', height:'46px', borderRadius:'50%',
        background:hexToCss(item.color), border:'2px solid #8a93a5',
        flexShrink:'0'
      });
      var nm = document.createElement('div');
      nm.textContent = item.name;
      baseStyles(nm, { fontSize:'14px', textAlign:'center', lineHeight:'1.25' });
      card.appendChild(sw);
      card.appendChild(nm);
      var btn = document.createElement('button');
      if (item.owned){
        btn.textContent = '✓ Owned';
        btn.disabled = true;
        baseStyles(btn, {
          minHeight:'48px', width:'100%', fontSize:'15px', fontWeight:'700',
          color:'#7be382', background:'#1d3a24', border:'none',
          borderRadius:'10px', padding:'10px 6px'
        });
      } else {
        btn.textContent = 'Add — FREE';
        baseStyles(btn, {
          minHeight:'48px', width:'100%', fontSize:'15px', fontWeight:'700',
          color:'#fff', background:'#2e7a4a', border:'none',
          borderRadius:'10px', padding:'10px 6px', cursor:'pointer'
        });
        /* capture the id now — the loop variable must not leak into the tap */
        (function(id){
          btn.addEventListener('click', function(){ buyItem(id); });
        })(item.id);
      }
      card.appendChild(btn);
      grid.appendChild(card);
    });
    _overlayBody.appendChild(grid);
  });
}

/* Closet UI — called by the interior system when the player uses a closet. */
function openWardrobe(){
  try { openUI('wardrobe'); }
  catch (e) { toast('Wardrobe unavailable right now'); }
}

/* Mall clothing store UI — called by a mall interaction. */
function openStore(){
  try { openUI('store'); }
  catch (e) { toast('Store unavailable right now'); }
}

/* ============================ boot ======================================== */
loadState();

/* The hero is built by buildHero() in index.html, which may run AFTER this
   deferred script. Poll briefly for player.mesh; on first sight, apply the
   saved outfit (only if it differs from the build defaults — otherwise the
   hero is already correct and we touch nothing). Gives up after ~20s so a
   missing hero can never leave a timer running forever. */
(function pollForHero(){
  var tries = 0, maxTries = 40;
  var timer = setInterval(function(){
    tries++;
    try {
      var p = hero();
      if (p && p.mesh){
        clearInterval(timer);
        var cur = currentHexes();
        var needsApply = (cur.shirt !== DEFAULT_SHIRT_HEX ||
                          cur.pants !== DEFAULT_PANTS_HEX ||
                          cur.shoes !== DEFAULT_SHOE_HEX);
        if (needsApply) refresh();
      } else if (tries >= maxTries){
        clearInterval(timer);
      }
    } catch (e){
      clearInterval(timer);
    }
  }, 500);
})();

/* ============================ public API ================================== */
window.ClothingSystem = {
  __clothingV: 1,          /* re-execution guard stamp */
  version: '1.0',
  wardrobe: state.wardrobe,/* live array of {id,name,category,color,owned} */
  openWardrobe: openWardrobe, /* closet UI (interior system calls this) */
  openStore: openStore,       /* mall store UI (mall interaction calls this) */
  getEquipped: getEquipped,   /* -> {shirt:<id>, pants:<id>, shoes:<id>} */
  equipItem: equipItem,        /* equip an owned item by id */
  buyItem: buyItem,            /* store purchase (free placeholder for now) */
  addItem: buyItem,            /* alias: grant an item to the wardrobe */
  refresh: refresh,            /* re-apply equipped outfit to a fresh hero */
  updateAppearance: updateAppearance /* low-level recolor (best-effort) */
};

})();
