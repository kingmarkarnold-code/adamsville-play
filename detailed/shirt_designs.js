/* ============================================================================
   SHIRT DESIGNS — custom shirt graphics for main characters (v1.0)
   ----------------------------------------------------------------------------
   STANDALONE MODULE. Include AFTER three.min.js (anywhere before the hero
   builder and refnpc_system.js):

       <script src="shirt_designs.js"></script>

   What it does:
     - Draws a canvas texture for a character's shirt FRONT (+z face):
       base shirt color + an ORIGINAL graphic and/or original text.
     - NO real brand names, logos, or trademarks — original art only
       (per Joshua, 2026-10-09).
     - Data-driven: window.ShirtDesigns.CONFIGS maps character name ->
       {text, textColor, font, graphic, graphicColor, image}.
     - Runtime API: ShirtDesigns.setDesign(name, cfg) to change/add a design
       live; ShirtDesigns.makeShirtMats(baseColor, charName) returns the
       6-material array for a BoxGeometry torso (front face = design).

   Reads: THREE (required). Writes: window.ShirtDesigns.
   ============================================================================ */
(function(){
'use strict';
if (window.ShirtDesigns) return;

/* ---------------- data: one original design per main character ----------- */
/* graphic: 'star' | 'bolt' | 'circle' | 'stripes' | 'chevron' | 'none'       */
var CONFIGS={
  'MECCA shirt man': { graphic:'star', graphicColor:'#f2e6c8', text:'', textColor:'#f2e6c8' },
  'Flag photo man':  { graphic:'stripes', graphicColor:'#7a2d20', text:'', textColor:'#7a2d20' },
  'Yellow shirt woman':{ graphic:'circle', graphicColor:'#7a2d20', text:'', textColor:'#7a2d20' },
  'Bearded cap man': { graphic:'chevron', graphicColor:'#dfe8f2', text:'', textColor:'#dfe8f2' },
  'Dreadlocks man':  { graphic:'bolt', graphicColor:'#8a6a1f', text:'', textColor:'#8a6a1f' },
  'Headband bun girl':{ graphic:'star', graphicColor:'#2e4a6b', text:'', textColor:'#2e4a6b' },
  'Puppy photo':     { graphic:'circle', graphicColor:'#dfe8f2', text:'', textColor:'#dfe8f2' },
  'Purple portrait woman':{ graphic:'chevron', graphicColor:'#f2e6c8', text:'', textColor:'#f2e6c8' },
  /* player hero (Joshua, 16) — subtle original emblem, configurable */
  'PLAYER':          { graphic:'star', graphicColor:'#f2e6c8', text:'', textColor:'#f2e6c8' }
};

/* ---------------- canvas drawing ----------------------------------------- */
function drawGraphic(g, kind, color, cx, cy, s){
  g.fillStyle=color; g.strokeStyle=color;
  if (kind==='star'){
    g.beginPath();
    for (var i=0;i<10;i++){
      var r=(i%2===0)?s:s*0.45, a=-Math.PI/2+i*Math.PI/5;
      var x=cx+Math.cos(a)*r, y=cy+Math.sin(a)*r;
      if (i===0) g.moveTo(x,y); else g.lineTo(x,y);
    }
    g.closePath(); g.fill();
  } else if (kind==='bolt'){
    g.beginPath();
    g.moveTo(cx+s*0.25,cy-s); g.lineTo(cx-s*0.45,cy+s*0.15); g.lineTo(cx-s*0.02,cy+s*0.15);
    g.lineTo(cx-s*0.25,cy+s); g.lineTo(cx+s*0.45,cy-s*0.15); g.lineTo(cx+s*0.02,cy-s*0.15);
    g.closePath(); g.fill();
  } else if (kind==='circle'){
    g.lineWidth=Math.max(3,s*0.22);
    g.beginPath(); g.arc(cx,cy,s*0.8,0,Math.PI*2); g.stroke();
    g.beginPath(); g.arc(cx,cy,s*0.30,0,Math.PI*2); g.fill();
  } else if (kind==='stripes'){
    g.fillRect(cx-s,cy-s*0.55,s*2,s*0.30);
    g.fillRect(cx-s,cy-s*0.05,s*2,s*0.30);
  } else if (kind==='chevron'){
    g.lineWidth=Math.max(4,s*0.28); g.lineJoin='miter';
    g.beginPath(); g.moveTo(cx-s*0.8,cy-s*0.1); g.lineTo(cx,cy+s*0.55); g.lineTo(cx+s*0.8,cy-s*0.1); g.stroke();
    g.beginPath(); g.moveTo(cx-s*0.8,cy-s*0.55); g.lineTo(cx,cy+s*0.1); g.lineTo(cx+s*0.8,cy-s*0.55); g.stroke();
  }
}

function drawShirt(cv, baseColor, cfg){
  var g=cv.getContext('2d'); if(!g) return;
  var W=cv.width, H=cv.height;
  g.clearRect(0,0,W,H);
  g.fillStyle=baseColor; g.fillRect(0,0,W,H);
  /* subtle fabric shading so the design reads on the 3D torso */
  var gr=g.createLinearGradient(0,0,0,H);
  gr.addColorStop(0,'rgba(255,255,255,0.10)');
  gr.addColorStop(0.5,'rgba(255,255,255,0)');
  gr.addColorStop(1,'rgba(0,0,0,0.14)');
  g.fillStyle=gr; g.fillRect(0,0,W,H);
  var cx=W/2, cy=H/2;
  if (cfg.graphic && cfg.graphic!=='none')
    drawGraphic(g, cfg.graphic, cfg.graphicColor||'#ffffff', cx, cy-(cfg.text?H*0.08:0), Math.min(W,H)*0.22);
  if (cfg.text){
    g.fillStyle=cfg.textColor||'#ffffff';
    g.font='bold '+Math.floor(H*0.16)+'px '+ (cfg.font||'Arial, sans-serif');
    g.textAlign='center'; g.textBaseline='middle';
    /* auto-shrink long text to fit */
    var tw=g.measureText(cfg.text).width, maxW=W*0.86, fs=H*0.16;
    while (tw>maxW && fs>8){ fs*=0.9; g.font='bold '+Math.floor(fs)+'px '+(cfg.font||'Arial, sans-serif'); tw=g.measureText(cfg.text).width; }
    g.fillText(cfg.text, cx, cy+H*0.26);
  }
  /* optional loaded picture (drawn under text/graphic layer order: image first) */
  if (cfg._img && cfg._img.complete && cfg._img.naturalWidth){
    var iw=cfg.imageW||W*0.6, ih=cfg.imageH||H*0.6;
    g.drawImage(cfg._img, cx-iw/2, cy-ih/2-(cfg.text?H*0.06:0), iw, ih);
    if (cfg.graphic && cfg.graphic!=='none')
      drawGraphic(g, cfg.graphic, cfg.graphicColor||'#ffffff', cx, cy-(cfg.text?H*0.08:0), Math.min(W,H)*0.22);
    if (cfg.text){
      g.fillStyle=cfg.textColor||'#ffffff';
      g.font='bold '+Math.floor(H*0.16)+'px '+(cfg.font||'Arial, sans-serif');
      g.textAlign='center'; g.textBaseline='middle';
      g.fillText(cfg.text, cx, cy+H*0.26);
    }
  }
}

/* image loading: cfg.image = dataURL or relative path; redraws on load */
function loadImage(cfg, cv, baseColor, tex){
  if (!cfg.image || cfg._img) return;
  try{
    var im=new Image();
    im.onload=function(){
      cfg._img=im;
      drawShirt(cv, baseColor, cfg);
      if (tex) tex.needsUpdate=true;
    };
    im.onerror=function(){ cfg._img=null; };
    im.src=cfg.image;
  }catch(e){}
}

/* ---------------- public API ---------------------------------------------- */
function makeShirtMats(baseColor, charName){
  /* returns [ +x, -x, +y, -y, +z(front), -z ] for BoxGeometry */
  var cfg=CONFIGS[charName]||null;
  var plain=new THREE.MeshLambertMaterial({color:baseColor});
  if (!cfg) return [plain,plain,plain,plain,plain,plain];
  var cv=document.createElement('canvas'); cv.width=128; cv.height=128;
  var bc=(typeof baseColor==='string')?baseColor:'#'+new THREE.Color(baseColor).getHexString();
  drawShirt(cv, bc, cfg);
  var tex=new THREE.CanvasTexture(cv);
  try{ if (THREE.sRGBEncoding!==undefined) tex.encoding=THREE.sRGBEncoding; }catch(e){}
  tex.anisotropy=2;
  loadImage(cfg, cv, bc, tex);
  var front=new THREE.MeshLambertMaterial({map:tex});
  return [plain,plain,plain,plain,front,plain];
}

function setDesign(charName, cfg){
  CONFIGS[charName]=cfg||{};
}

function getDesign(charName){ return CONFIGS[charName]||null; }

window.ShirtDesigns={
  CONFIGS:CONFIGS,
  makeShirtMats:makeShirtMats,
  setDesign:setDesign,
  getDesign:getDesign,
  drawShirt:drawShirt
};
})();
