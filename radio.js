/* Radio: one button opens popup controls. Different tracks for walk vs drive. */
var Radio = {
  tracks: [],
  walkTrack: 0, driveTrack: 1, current: -1,
  audio: null, playing: false, mode: 'walk',
  init: function(){
    // tracks served from the APK music folder via watcher site
    var base='https://kingmarkarnold-code.github.io/adamsville-watcher/music/';
    this.tracks=[
      {name:'Solarflex Beat', file:'solarflex-beat-569522_012209_9_gwjz.mp3'},
      {name:'Aggressive Bass', file:'vaitsez-aggressive-bass-beat-565491_011939_10_1zrr.mp3'}
    ];
    var self=this;
    document.getElementById('radiobtn').onclick=function(){
      var p=document.getElementById('radiopop');
      p.style.display=(p.style.display==='none')?'block':'none';
    };
    document.getElementById('rp-close').onclick=function(){
      document.getElementById('radiopop').style.display='none';
    };
    document.getElementById('rp-play').onclick=function(){ self.toggle(); };
    document.getElementById('rp-next').onclick=function(){ self.next(); };
    document.getElementById('rp-prev').onclick=function(){ self.prev(); };
    this.audio=new Audio(); this.audio.loop=true;
    this.audio.onended=function(){ self.next(); };
  },
  playTrack: function(i){
    if(i<0||i>=this.tracks.length) return;
    this.current=i;
    var t=this.tracks[i];
    this.audio.src='https://kingmarkarnold-code.github.io/adamsville-watcher/music/'+t.file;
    this.audio.play().catch(function(){});
    this.playing=true;
    document.getElementById('rp-track').textContent=t.name;
    document.getElementById('rp-play').textContent='⏸';
  },
  toggle: function(){
    if(this.playing){ this.audio.pause(); this.playing=false;
      document.getElementById('rp-play').textContent='▶'; }
    else if(this.current>=0){ this.audio.play().catch(function(){}); this.playing=true;
      document.getElementById('rp-play').textContent='⏸'; }
    else this.playTrack(this.mode==='drive'?this.driveTrack:this.walkTrack);
  },
  next: function(){ this.playTrack((this.current+1)%this.tracks.length); },
  prev: function(){ this.playTrack((this.current-1+this.tracks.length)%this.tracks.length); },
  setMode: function(mode){
    if(mode===this.mode) return;
    this.mode=mode;
    // auto-switch track when mode changes (if playing)
    if(this.playing) this.playTrack(mode==='drive'?this.driveTrack:this.walkTrack);
  }
};
