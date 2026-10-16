/* ============================================================================
   CodeEnforcementOffice — central intranet endpoint for the Surviving
   Adamsville: Mollie's Edition QA crew. Every inspector team files its
   findings HERE via office.submit(); the office compiles and emits the ONE
   consolidated report. Teams never report to the parent directly — the
   office does.

   Each finding is tagged with its team's vehicle identity so the report
   shows which team's vehicle found what.
   ========================================================================== */
var fs = require('fs');
var path = require('path');

function CodeEnforcementOffice(opts){
  opts = opts || {};
  this.outDir = opts.outDir || '.';
  this.teams = {};      // teamId -> {unit, vehicle, agents:[...], summary:{}}
  this.findings = [];   // every submitted finding, vehicle-tagged
  this.seq = 0;
}

CodeEnforcementOffice.TEAMS = {
  roads:     { unit:'Road Crew',        vehicle:'DOT pickup — orange/white' },
  buildings: { unit:'Code Enforcement', vehicle:'sedan — white/blue stripe' },
  planner:   { unit:'City Planner',     vehicle:'van — municipal green' },
  inspector: { unit:'City Inspector',   vehicle:'SUV — safety yellow' },
  furniture: { unit:'Traffic Engineering', vehicle:'utility truck — yellow/black chevron' }
};

CodeEnforcementOffice.prototype.registerTeam = function(teamId, agents){
  var meta = CodeEnforcementOffice.TEAMS[teamId] || { unit:teamId, vehicle:'unmarked' };
  this.teams[teamId] = { unit:meta.unit, vehicle:meta.vehicle, agents:agents||[], summary:null };
  return this.teams[teamId];
};

/* A team files a finding with the office. The office stamps it with the
   team's vehicle identity and files it centrally. */
CodeEnforcementOffice.prototype.submit = function(teamId, finding){
  var meta = CodeEnforcementOffice.TEAMS[teamId] || { unit:teamId, vehicle:'unmarked' };
  finding.team = teamId;
  finding.unit = meta.unit;
  finding.vehicle = meta.vehicle;
  finding.filed = ++this.seq;
  this.findings.push(finding);
  return finding;
};

CodeEnforcementOffice.prototype.setTeamSummary = function(teamId, summary, agents){
  if (this.teams[teamId]){
    this.teams[teamId].summary = summary;
    if (agents) this.teams[teamId].agents = agents;
  }
};

function countBy(arr, k){
  var o={}; arr.forEach(function(f){ o[f[k]]=(o[f[k]]||0)+1; }); return o;
}

/* Compile the ONE consolidated report. Sections per check type. */
CodeEnforcementOffice.prototype.compile = function(extra){
  extra = extra || {};
  var self = this;
  var sections = {};
  ['roads','buildings','planner','inspector','furniture'].forEach(function(t){
    var team = self.teams[t] || { unit:t, vehicle:'unmarked', agents:[], summary:null };
    var mine = self.findings.filter(function(f){ return f.team===t; });
    sections[t] = {
      unit: team.unit,
      vehicle: team.vehicle,
      agents: team.agents,
      summary: team.summary || { issues: mine.length },
      issues: mine
    };
  });
  /* POI section merges planner (location) + inspector (placement) */
  var poiIssues = this.findings.filter(function(f){ return f.team==='planner'||f.team==='inspector'; });
  sections.pois = {
    unit: 'City Planner + City Inspector',
    vehicles: [CodeEnforcementOffice.TEAMS.planner.vehicle, CodeEnforcementOffice.TEAMS.inspector.vehicle],
    agents: (this.teams.planner?this.teams.planner.agents:[]).concat(this.teams.inspector?this.teams.inspector.agents:[]),
    summary: {
      pois: extra.poiCount||0,
      issues: poiIssues.length,
      byType: countBy(poiIssues,'type'),
      bySeverity: countBy(poiIssues,'severity')
    },
    issues: poiIssues
  };
  delete sections.planner; delete sections.inspector;

  var r = this.findings.filter(function(f){return f.team==='roads';});
  var b = this.findings.filter(function(f){return f.team==='buildings';});
  var t = this.findings.filter(function(f){return f.team==='furniture';});
  function fmt(arr){
    var o=countBy(arr,'type');
    return Object.keys(o).sort().map(function(k){return o[k]+' '+k;}).join(', ')||'none';
  }
  var summary =
    'CREW REPORT: '+r.length+' road issues ('+fmt(r)+') · '+
    b.length+' building violations ('+fmt(b)+') · '+
    poiIssues.length+' POI flags ('+fmt(poiIssues)+') · '+
    t.length+' furniture findings ('+fmt(t)+') — filed with the Code Enforcement Office';

  return {
    generated: new Date().toISOString(),
    edition: "Surviving Adamsville: Mollie's Edition",
    crew: "Surviving Adamsville: Mollie's Edition — Municipal QA Crew (one team, one report)",
    office: 'Code Enforcement Office (central filing)',
    game: extra.game || {},
    runtimeMs: extra.runtimeMs || 0,
    summary: summary,
    sections: sections
  };
};

/* Emit the consolidated report. Always writes, even when all clear. */
CodeEnforcementOffice.prototype.emit = function(report, filename){
  try{ fs.mkdirSync(this.outDir,{recursive:true}); }catch(e){}
  var file = path.join(this.outDir, filename || 'road-inspection.json');
  fs.writeFileSync(file, JSON.stringify(report,null,1));
  return file;
};

module.exports = CodeEnforcementOffice;
