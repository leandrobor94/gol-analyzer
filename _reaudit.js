/**
 * Re-auditoria exigente del estado actual.
 * Exit 2 si hay CRITICO/ALTO. Exit 0 si solo MEDIO/BAJO o limpio.
 */
const fs = require('fs');
const path = require('path');
const { analyzeGoal, getWindowType, hasMeaningfulStats } = require('./run_flashscore');

const root = __dirname;
const src = fs.readFileSync(path.join(root, 'run_flashscore.js'), 'utf8');
const learn = fs.readFileSync(path.join(root, 'learn.js'), 'utf8');
const s365 = fs.readFileSync(path.join(root, 'scores365.js'), 'utf8');
const yml = fs.readFileSync(path.join(root, '.github/workflows/analyze.yml'), 'utf8');
const notify = fs.readFileSync(path.join(root, 'notify.js'), 'utf8');
const p = JSON.parse(fs.readFileSync(path.join(root, 'predictions.json'), 'utf8').replace(/^\uFEFF/, ''));
const w = JSON.parse(fs.readFileSync(path.join(root, 'weights.json'), 'utf8').replace(/^\uFEFF/, ''));

const issues = [];
function hit(sev, msg) {
  issues.push({ sev, msg });
  console.log(sev + ': ' + msg);
}
function ok(msg) { console.log('OK: ' + msg); }

console.log('========== RE-AUDIT ' + new Date().toISOString() + ' ==========\n');

// --- JSON integrity ---
try {
  JSON.parse(fs.readFileSync(path.join(root, 'weights.json'), 'utf8').replace(/^\uFEFF/, ''));
  ok('weights.json parseable');
} catch (e) { hit('CRITICO', 'weights.json invalido: ' + e.message); }

try {
  JSON.parse(fs.readFileSync(path.join(root, 'alertas_log.json'), 'utf8').replace(/^\uFEFF/, ''));
  ok('alertas_log.json parseable');
} catch (e) { hit('CRITICO', 'alertas_log.json invalido: ' + e.message); }

// --- Structural invariants ---
const htN = (src.match(/if \(isHalftime\) lambda \*= 0\.55/g) || []).length;
if (htN !== 1) hit('CRITICO', 'isHalftime lambda*=0.55 count=' + htN + ' (debe 1)');
else ok('HT penalty x1');

if (!src.includes('B.urgency60')) hit('ALTO', 'urgency betas no usados');
else ok('urgency betas cableados');

if (!src.includes('firstAlertProbability')) hit('ALTO', 'sin firstAlertProbability');
else ok('firstAlertProbability');

if (!src.includes('r.score15 = updated.score15')) hit('ALTO', 'reanalisis no propaga score15');
else ok('score15 propagado en reanalisis');

if (!src.includes('CI — archivos en disco') && !src.includes('CI - archivos')) {
  // check CI skip doSync
  if (!(src.includes('process.env.CI') && src.includes('doSync') && src.includes('workflow'))) {
    hit('ALTO', 'doSync puede racear con workflow en CI');
  }
} else ok('doSync skip git en CI');

if (yml.includes('cancel-in-progress: true')) hit('ALTO', 'cancel-in-progress true');
else ok('cancel-in-progress false');

if (!yml.includes('alertas_log.json')) hit('ALTO', 'workflow no commitea alertas_log');
else ok('workflow incluye alertas_log');

if (!learn.includes('adjustBetas(weights, verified)')) hit('CRITICO', 'runLearning sin adjustBetas');
else ok('runLearning llama adjustBetas');

if (!learn.includes('learnable.sort')) hit('MEDIO', 'adjustBetas no prioriza mayor error');
else ok('adjustBetas ordena por |error|');

if (src.includes('module.parent')) hit('BAJO', 'module.parent deprecado');
else ok('require.main === module');

// save after reanalysis: search order
const saveIdx = src.indexOf('PERSISTIR PREDICCIONES');
const momIdx = src.indexOf('Fetch momentum');
const alertIdx = src.indexOf('Telegram alert');
if (saveIdx < 0 || saveIdx < momIdx || saveIdx > alertIdx) {
  hit('CRITICO', 'orden save/momentum/alertas incorrecto');
} else ok('orden: momentum → save → alertas');

// alert gates
const hasStatsGate = src.includes('hasMeaningfulStats(r.stats)');
const hasMinGate = src.includes('r.minute >= 30') || src.includes('r.minute < 30');
const hasXgGate = src.includes('xgRemaining') || src.includes('xg - goals');
if (!hasStatsGate || !hasMinGate) hit('ALTO', 'alertas sin gate stats/minuto');
else ok('alert gates stats+minuto');
if (!hasXgGate) hit('MEDIO', 'alertas sin gate xG restante (medido como mejora)');
else ok('alert gate xG restante');

// betas
if (!w.betas || typeof w.betas.baseline !== 'number') hit('CRITICO', 'weights sin betas');
else ok('betas presentes baseline=' + w.betas.baseline);

if ((w.stats?.correctScore || 0) > (w.stats?.verifiedCount || 0) + 10) {
  hit('ALTO', 'contadores stats inconsistentes correct=' + w.stats.correctScore + ' ver=' + w.stats.verifiedCount);
} else ok('contadores stats coherentes');

// data pipeline
const recent = p.filter(x => x.timestamp && x.timestamp >= '2026-08-01');
const withL = recent.filter(x => x._lambda != null).length;
const pending = p.filter(x => x.predictionCorrect === null);
const verified = p.filter(x => x.predictionCorrect === true || x.predictionCorrect === false);
console.log('\nDATA recent=' + recent.length + ' lambda=' + withL + ' pending=' + pending.length + ' verified=' + verified.length);
console.log('stats', JSON.stringify(w.stats));

if (recent.length > 50 && withL / recent.length < 0.5) {
  hit('ALTO', 'pocas preds con _lambda: ' + withL + '/' + recent.length);
} else if (recent.length > 0) ok('_lambda en ' + withL + '/' + recent.length);

// stale pending
const oldPend = pending.filter(x => x.timestamp && (Date.now() - new Date(x.timestamp)) / 86400000 > 2);
if (oldPend.length > 30) hit('MEDIO', 'pending >2d: ' + oldPend.length + ' (verificacion puede estar fallando)');
else ok('pending viejos=' + oldPend.length);

// verifiedCount stuck at 0 while many verified in file?
if ((w.stats?.verifiedCount || 0) === 0 && verified.filter(x => x.timestamp >= '2026-08-01').length > 20) {
  hit('ALTO', 'weights.stats.verifiedCount=0 pero hay ' + verified.filter(x => x.timestamp >= '2026-08-01').length + ' verificadas post-ago — contadores no se persisten o se resetean');
}

// --- Behavioral model checks ---
const B = w.betas;
const fake = {
  xgHome: 0.8, xgAway: 0.6, sotHome: 3, sotAway: 2, bigChancesHome: 1, bigChancesAway: 0,
  shotsInsideBoxHome: 4, shotsInsideBoxAway: 3, redCardsHome: 0, redCardsAway: 0,
  xgotHome: null, xgotAway: null, possessionHome: 0.55, possessionAway: 0.45
};
function run(min, sh, sa) {
  return analyzeGoal(
    { rawName: 'A vs B', teamHome: 'A', teamAway: 'B', league: 'T', matchId: '1', minute: min, scoreHome: sh, scoreAway: sa, stats: fake },
    { betas: B }, {}, null, getWindowType(min), null
  );
}
const d = run(70, 1, 1);
const t = run(70, 0, 2);
const l = run(70, 2, 0);
const early = run(20, 0, 0);
const ht = run(46, 0, 0);
console.log('\nMODEL draw70=' + d.score + ' trail02=' + t.score + ' lead20=' + l.score + ' early20=' + early.score + ' ht46=' + ht.score);

if (early.score >= 80) hit('CRITICO', 'early puede alertar score=' + early.score);
else ok('early cap OK score=' + early.score);

if (ht.score >= 80) hit('CRITICO', 'HT puede alertar score=' + ht.score);
else ok('HT cap OK score=' + ht.score);

if (!d.score15 && d.score15 !== 0) hit('ALTO', 'analyzeGoal no devuelve score15');
else ok('score15=' + d.score15);

// backtest
const oldV = verified.filter(x => x.timestamp && x.timestamp < '2026-08-01');
const newV = verified.filter(x => x.timestamp && x.timestamp >= '2026-08-01');
function bt(set, label) {
  let brier = 0, n = 0, a = 0, h = 0;
  for (const pred of set) {
    if (!pred.stats || !hasMeaningfulStats(pred.stats)) continue;
    const m = {
      rawName: pred.match, teamHome: pred.teamHome, teamAway: pred.teamAway, league: pred.league,
      matchId: pred.id, minute: pred.analysisMinute || 0,
      scoreHome: pred.scoreAtAnalysis?.home ?? 0, scoreAway: pred.scoreAtAnalysis?.away ?? 0,
      stats: pred.stats
    };
    const r = analyzeGoal(m, { betas: B }, {}, null, getWindowType(m.minute), null);
    const y = pred.goalAfterAnalysis ? 1 : 0;
    brier += Math.pow(r.score / 100 - y, 2);
    n++;
    if (r.score >= 80 && m.minute >= 30) { a++; if (y) h++; }
  }
  const br = n ? (brier / n).toFixed(4) : '-';
  const rate = a ? ((h / a) * 100).toFixed(0) : '0';
  console.log('BT ' + label + ' n=' + n + ' Brier=' + br + ' alerts=' + a + ' hit=' + h + ' (' + rate + '%)');
  return { n, brier: n ? brier / n : 1, a, h };
}
console.log('\n========== BACKTEST ==========');
const btOld = bt(oldV, 'OLD');
const btNew = bt(newV, 'NEW');
bt(verified, 'ALL');

if (btOld.a >= 5 && btOld.h / btOld.a < 0.7) {
  hit('ALTO', 'OLD alert hit-rate <70%: ' + btOld.h + '/' + btOld.a);
}
// Alert gate operativo (debe coincidir con run_flashscore.js)
function passesAlertGate(r, pred) {
  if (r.score < 80 || (pred.analysisMinute || 0) < 30) return false;
  const xg = (pred.stats.xgHome || 0) + (pred.stats.xgAway || 0);
  const goals = (pred.scoreAtAnalysis?.home || 0) + (pred.scoreAtAnalysis?.away || 0);
  return (xg - goals) >= 1.0;
}
function btGate(set, label) {
  let a = 0, h = 0;
  for (const pred of set) {
    if (!pred.stats || !hasMeaningfulStats(pred.stats)) continue;
    const m = {
      minute: pred.analysisMinute || 0,
      scoreHome: pred.scoreAtAnalysis?.home ?? 0, scoreAway: pred.scoreAtAnalysis?.away ?? 0,
      stats: pred.stats, teamHome: pred.teamHome, teamAway: pred.teamAway, league: pred.league, matchId: pred.id, rawName: pred.match
    };
    const r = analyzeGoal(m, { betas: B }, {}, null, getWindowType(m.minute), null);
    if (!passesAlertGate(r, pred)) continue;
    a++;
    if (pred.goalAfterAnalysis) h++;
  }
  const rate = a ? ((h / a) * 100).toFixed(0) : '0';
  console.log('GATE ' + label + ' alerts=' + a + ' hit=' + h + ' (' + rate + '%)');
  if (label === 'NEW' && a >= 6 && h / a < 0.55) {
    hit('MEDIO', 'NEW gated alert hit-rate <55%: ' + h + '/' + a);
  }
}
btGate(newV, 'NEW');
btGate(oldV, 'OLD');

// code smells
// teams factor: solo flag si el codigo promete usarlo sin guardia de samples
if (src.includes('teams[') && src.includes('timesPredictedGoal') && !src.includes('matchesTracked')) {
  hit('MEDIO', 'team factor sin umbral de samples');
}

if (src.includes('WINDOW_ODDS') || (src.includes('result.ev') && src.includes('windowOdds'))) {
  hit('BAJO', 'EV/windowOdds con odds inventadas aun en codigo');
}

// Double counting alert in learn + path?
// skip

console.log('\n========== RESUMEN ==========');
const by = { CRITICO: 0, ALTO: 0, MEDIO: 0, BAJO: 0 };
issues.forEach(i => { by[i.sev]++; });
console.log(by);
console.log('TOTAL', issues.length);
issues.forEach(i => console.log(' - [' + i.sev + '] ' + i.msg));

const bad = issues.filter(i => i.sev === 'CRITICO' || i.sev === 'ALTO');
process.exit(bad.length ? 2 : 0);
