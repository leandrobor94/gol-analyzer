const fs = require('fs');
const { analyzeGoal, getWindowType, hasMeaningfulStats } = require('./run_flashscore');
const p = JSON.parse(fs.readFileSync('predictions.json', 'utf8').replace(/^\uFEFF/, ''));
const w = JSON.parse(fs.readFileSync('weights.json', 'utf8'));
const B = w.betas;

const rows = [];
for (const pred of p) {
  if (pred.goalAfterAnalysis !== true && pred.goalAfterAnalysis !== false) continue;
  if (!pred.stats || !hasMeaningfulStats(pred.stats)) continue;
  if (!pred.timestamp || pred.timestamp < '2026-08-01') continue;
  const m = {
    rawName: pred.match, teamHome: pred.teamHome, teamAway: pred.teamAway, league: pred.league,
    matchId: pred.id, minute: pred.analysisMinute || 0,
    scoreHome: pred.scoreAtAnalysis?.home ?? 0, scoreAway: pred.scoreAtAnalysis?.away ?? 0,
    stats: pred.stats
  };
  const r = analyzeGoal(m, { betas: B }, {}, null, getWindowType(m.minute), null);
  rows.push({
    score: r.score, s15: r.score15, lambda: r.lambda, minute: m.minute,
    y: pred.goalAfterAnalysis ? 1 : 0, match: pred.match,
    gd: Math.abs(m.scoreHome - m.scoreAway),
    xg: (pred.stats.xgHome || 0) + (pred.stats.xgAway || 0),
    bc: (pred.stats.bigChancesHome || 0) + (pred.stats.bigChancesAway || 0)
  });
}

function evalGate(name, fn) {
  const a = rows.filter(fn);
  const h = a.filter(x => x.y).length;
  const rate = a.length ? (h / a.length * 100).toFixed(0) : '0';
  console.log(name.padEnd(48) + ' n=' + String(a.length).padStart(3) + ' hit=' + String(h).padStart(2) + ' (' + rate + '%)');
}

console.log('NEW-set n=' + rows.length + ' goalRate=' + (rows.filter(x => x.y).length / rows.length * 100).toFixed(0) + '%\n');
console.log('=== GATES (solo datos desde ago-1, replay modelo actual) ===');
evalGate('A: score>=80 min>=30', x => x.score >= 80 && x.minute >= 30);
evalGate('B: score>=85 min>=30', x => x.score >= 85 && x.minute >= 30);
evalGate('C: score>=90 min>=30', x => x.score >= 90 && x.minute >= 30);
evalGate('D: score>=80 & s15>=50', x => x.score >= 80 && x.s15 >= 50 && x.minute >= 30);
evalGate('E: score>=80 & s15>=55', x => x.score >= 80 && x.s15 >= 55 && x.minute >= 30);
evalGate('F: score>=80 & s15>=60', x => x.score >= 80 && x.s15 >= 60 && x.minute >= 30);
evalGate('G: score>=80 & minute>=50', x => x.score >= 80 && x.minute >= 50);
evalGate('H: score>=80 & minute 50-85', x => x.score >= 80 && x.minute >= 50 && x.minute <= 85);
evalGate('I: score>=80 & xg>=1.2', x => x.score >= 80 && x.xg >= 1.2 && x.minute >= 30);
evalGate('J: score>=80 & bc>=1', x => x.score >= 80 && x.bc >= 1 && x.minute >= 30);
evalGate('K: score>=80 & s15>=55 & min>=45', x => x.score >= 80 && x.s15 >= 55 && x.minute >= 45);
evalGate('L: score>=85 & s15>=50 & min>=45', x => x.score >= 85 && x.s15 >= 50 && x.minute >= 45);
evalGate('M: score>=80 & gd<=1 & min>=40', x => x.score >= 80 && x.gd <= 1 && x.minute >= 40);

// FP patterns
const fps = rows.filter(x => x.score >= 80 && x.minute >= 30 && !x.y);
const tps = rows.filter(x => x.score >= 80 && x.minute >= 30 && x.y);
console.log('\nFP n=' + fps.length + ' avgMin=' + (fps.reduce((s, x) => s + x.minute, 0) / (fps.length || 1)).toFixed(0) +
  ' avgS15=' + (fps.reduce((s, x) => s + x.s15, 0) / (fps.length || 1)).toFixed(0) +
  ' avgXg=' + (fps.reduce((s, x) => s + x.xg, 0) / (fps.length || 1)).toFixed(2));
console.log('TP n=' + tps.length + ' avgMin=' + (tps.reduce((s, x) => s + x.minute, 0) / (tps.length || 1)).toFixed(0) +
  ' avgS15=' + (tps.reduce((s, x) => s + x.s15, 0) / (tps.length || 1)).toFixed(0) +
  ' avgXg=' + (tps.reduce((s, x) => s + x.xg, 0) / (tps.length || 1)).toFixed(2));
console.log('\nFP detalle:');
fps.slice(0, 12).forEach(x => console.log('  ' + x.score + '% s15=' + x.s15 + ' min' + x.minute + ' gd' + x.gd + ' xg' + x.xg.toFixed(1) + ' ' + x.match));
