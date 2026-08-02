const fs = require('fs');
const { analyzeGoal, getWindowType, hasMeaningfulStats } = require('./run_flashscore');

const src = fs.readFileSync('run_flashscore.js', 'utf8');
const learn = fs.readFileSync('learn.js', 'utf8');
const yml = fs.readFileSync('.github/workflows/analyze.yml', 'utf8');
const p = JSON.parse(fs.readFileSync('predictions.json', 'utf8').replace(/^\uFEFF/, ''));
const w = JSON.parse(fs.readFileSync('weights.json', 'utf8').replace(/^\uFEFF/, ''));

const issues = [];
function hit(sev, msg) {
  issues.push({ sev, msg });
  console.log(sev + ': ' + msg);
}

// --- Structural ---
if (!src.includes('B.urgency60') && !src.includes('B.urgency75')) {
  hit('ALTO', 'betas.urgency60/75 se aprenden pero analyzeGoal usa urgencia hardcodeada — aprendizaje muerto');
}

const ag = src.slice(src.indexOf('function analyzeGoal'), src.indexOf('function writeSummary'));
if (ag.includes('teams') && !ag.includes('teams[')) {
  hit('MEDIO', 'analyzeGoal recibe teams pero no los usa en el score');
}

// lead2 en gd>=2 es intencional para modelo any-goal (0-2 suele tener menos goles que 1-1)

if (learn.includes('learnable.slice(0, 5)') && !learn.includes('learnable.sort')) {
  hit('MEDIO', 'adjustBetas toma las primeras 5 del array, no las de mayor |error|');
}

// Brier contamination
const brierBlock = learn.slice(learn.indexOf('Brier Score'), learn.indexOf('return adjustments'));
if (brierBlock.includes('for (const pred of verified)')) {
  hit('MEDIO', 'Brier acumula de TODO verified (puede incluir modelo viejo)');
}

if (yml.includes('cancel-in-progress: true')) {
  hit('ALTO', 'cancel-in-progress:true puede matar job a mitad y perder save de la ronda');
}

if (src.includes('existing.predictedProbability = r.score') && !src.includes('firstAlertProbability')) {
  hit('MEDIO', 'se pisa predictedProbability al actualizar — no hay score-at-first-alert fijo');
}

if ((w.stats.correctScore || 0) > (w.stats.verifiedCount || 0) + 5) {
  hit('ALTO', 'stats.correctScore (' + w.stats.correctScore + ') > verifiedCount (' + w.stats.verifiedCount + ') — contadores basura');
}

// --- HT effectiveMins bug ---
const B = w.betas || { baseline: 0.03, xgWeight: 0.8, bcWeight: 1.2, sotWeight: 0.4, redCardMult: 1.5, urgency60: 1.3, urgency75: 1.5, lead2Mult: 0.5, lead1LateMult: 0.7 };
const fakeStats = {
  xgHome: 0.8, xgAway: 0.6, sotHome: 3, sotAway: 2, bigChancesHome: 1, bigChancesAway: 0,
  shotsInsideBoxHome: 4, shotsInsideBoxAway: 3, redCardsHome: 0, redCardsAway: 0,
  xgotHome: null, xgotAway: null, possessionHome: 0.55, possessionAway: 0.45
};
const ht = analyzeGoal(
  { rawName: 'A vs B', teamHome: 'A', teamAway: 'B', league: 'Test', matchId: '1', minute: 46, scoreHome: 0, scoreAway: 0, stats: fakeStats },
  { betas: B }, {}, null, getWindowType(46), null
);
const m70 = analyzeGoal(
  { rawName: 'A vs B', teamHome: 'A', teamAway: 'B', league: 'Test', matchId: '1', minute: 70, scoreHome: 0, scoreAway: 0, stats: fakeStats },
  { betas: B }, {}, null, getWindowType(70), null
);
console.log('HT min46 score=' + ht.score + ' lambda=' + (ht.lambda || ht.pressure / 100).toFixed(4) + ' windowType=' + getWindowType(46));
console.log('min70 score=' + m70.score + ' lambda=' + (m70.lambda || m70.pressure / 100).toFixed(4));

// At HT remaining should be ~45+ of 2H. If effectiveMins wrong, score too low.
// Reconstruct: if score is much lower at 46 than expected for ~45 min remaining...
if (ht.score < 40 && m70.score > ht.score) {
  hit('CRITICO', 'entretiempo min46 score=' + ht.score + ' parece subestimado vs min70=' + m70.score + ' (effectiveMins HT mal)');
}

// lead2 when trailing
const trail2 = analyzeGoal(
  { rawName: 'A vs B', teamHome: 'A', teamAway: 'B', league: 'Test', matchId: '1', minute: 70, scoreHome: 0, scoreAway: 2, stats: fakeStats },
  { betas: B }, {}, null, getWindowType(70), null
);
const lead2 = analyzeGoal(
  { rawName: 'A vs B', teamHome: 'A', teamAway: 'B', league: 'Test', matchId: '1', minute: 70, scoreHome: 2, scoreAway: 0, stats: fakeStats },
  { betas: B }, {}, null, getWindowType(70), null
);
const draw = analyzeGoal(
  { rawName: 'A vs B', teamHome: 'A', teamAway: 'B', league: 'Test', matchId: '1', minute: 70, scoreHome: 1, scoreAway: 1, stats: fakeStats },
  { betas: B }, {}, null, getWindowType(70), null
);
console.log('0-2 trailing score=' + trail2.score + ' reasons=' + trail2.reasons.join('; '));
console.log('2-0 leading score=' + lead2.score + ' reasons=' + lead2.reasons.join('; '));
console.log('1-1 draw score=' + draw.score);

// 0-2 < 1-1 es CORRECTO para modelo any-goal (partido mas cerrado). No es bug.
if (trail2.score > draw.score + 15) {
  hit('MEDIO', '0-2 mucho mas alto que empate — posible sobre-urgencia');
}

// recent data quality
const recent = p.filter(x => x.timestamp && x.timestamp >= '2026-08-02');
const withL = recent.filter(x => x._lambda != null).length;
const with15 = recent.filter(x => x.predictedProbability15 != null).length;
const alerts = recent.filter(x => (x.predictedProbability || 0) >= 80);
const pending = p.filter(x => x.predictionCorrect === null);
console.log('recent', recent.length, 'lambda', withL, 'p15', with15, 'alerts>=80', alerts.length, 'pending', pending.length);
if (recent.length > 20 && withL / recent.length < 0.3) {
  hit('ALTO', 'pocas preds nuevas con _lambda (' + withL + '/' + recent.length + ')');
}

// Check if firstHalf at min 44 uses 45-min remaining correctly
const m40 = analyzeGoal(
  { rawName: 'A vs B', teamHome: 'A', teamAway: 'B', league: 'Test', matchId: '1', minute: 40, scoreHome: 0, scoreAway: 0, stats: fakeStats },
  { betas: B }, {}, null, getWindowType(40), null
);
console.log('min40 1T score=' + m40.score + ' wt=' + getWindowType(40));

// Snapshot original alert score missing?
const upd = recent.filter(x => x.lastAnalyzedAt && x.timestamp && x.lastAnalyzedAt !== x.timestamp);
console.log('preds updated after create', upd.length);

console.log('\n=== RESUMEN ===');
const by = { CRITICO: 0, ALTO: 0, MEDIO: 0, BAJO: 0 };
issues.forEach(i => { by[i.sev] = (by[i.sev] || 0) + 1; });
console.log(by);
console.log('TOTAL', issues.length);
if (!issues.length) console.log('NADA critico encontrado en esta pasada');
process.exit(issues.some(i => i.sev === 'CRITICO' || i.sev === 'ALTO') ? 2 : 0);
