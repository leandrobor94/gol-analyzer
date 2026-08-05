/**
 * Auditoria del gate STRONG (debe ser >=90% hit en datos historicos).
 * Exit 2 si STRONG < 90% con n>=3.
 */
const fs = require('fs');
const { analyzeGoal, getWindowType, hasMeaningfulStats } = require('./run_flashscore');
const { classifyAlert } = require('./alert_gate');

const p = JSON.parse(fs.readFileSync('predictions.json', 'utf8').replace(/^\uFEFF/, ''));
const B = JSON.parse(fs.readFileSync('weights.json', 'utf8')).betas;

function collect(modernOnly) {
  const strong = [];
  const borderline = [];
  for (const pred of p) {
    if (pred.goalAfterAnalysis !== true && pred.goalAfterAnalysis !== false) continue;
    if (!pred.stats || !hasMeaningfulStats(pred.stats)) continue;
    if (modernOnly && !(pred.timestamp >= '2026-08-01')) continue;
    const m = {
      minute: pred.analysisMinute || 0,
      scoreHome: pred.scoreAtAnalysis?.home ?? 0,
      scoreAway: pred.scoreAtAnalysis?.away ?? 0,
      stats: pred.stats, teamHome: pred.teamHome, teamAway: pred.teamAway,
      league: pred.league || '', matchId: pred.id, rawName: pred.match
    };
    const r = analyzeGoal(m, { betas: B }, {}, null, getWindowType(m.minute), null);
    r.stats = m.stats;
    const g = classifyAlert(r, hasMeaningfulStats);
    const row = { y: !!pred.goalAfterAnalysis, score: r.score, gate: g, match: pred.match };
    if (g.tier === 'STRONG') strong.push(row);
    if (g.tier === 'BORDERLINE') borderline.push(row);
  }
  return { strong, borderline };
}

function report(label, modern) {
  const { strong, borderline } = collect(modern);
  const sh = strong.filter(x => x.y).length;
  const bh = borderline.filter(x => x.y).length;
  const sRate = strong.length ? sh / strong.length : null;
  const bRate = borderline.length ? bh / borderline.length : null;
  console.log(label);
  console.log('  STRONG     n=' + strong.length + ' hit=' + sh +
    (sRate != null ? ' (' + (sRate * 100).toFixed(0) + '%)' : ''));
  console.log('  BORDERLINE n=' + borderline.length + ' hit=' + bh +
    (bRate != null ? ' (' + (bRate * 100).toFixed(0) + '%)' : ' — necesita IA'));
  strong.forEach(x => console.log('   ' + (x.y ? 'HIT' : 'MISS') + ' ' + x.score + '% ' + x.match.slice(0, 40) +
    ' xgR=' + x.gate.xgRemaining + ' gd=' + x.gate.gd));
  return { strong, sRate, sh };
}

console.log('=== TARGET: STRONG hit-rate >= 90% ===\n');
const neu = report('NEW (desde ago-1)', true);
const all = report('\nALL', false);

let fail = false;
if (all.strong.length >= 3 && all.sRate < 0.90) {
  console.log('\nFAIL: ALL STRONG < 90%');
  fail = true;
}
if (neu.strong.length >= 3 && neu.sRate < 0.90) {
  console.log('\nFAIL: NEW STRONG < 90%');
  fail = true;
}
if (all.strong.length < 3) {
  console.log('\nWARN: poco volumen STRONG n=' + all.strong.length + ' (hit rate inestable)');
}

if (!fail && all.sRate >= 0.90) {
  console.log('\nPASS: STRONG hit-rate ' + (all.sRate * 100).toFixed(0) + '% >= 90% (n=' + all.strong.length + ')');
}
process.exit(fail ? 2 : 0);
