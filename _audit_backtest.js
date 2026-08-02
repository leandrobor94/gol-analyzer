/**
 * Auditoria / backtest offline sobre predictions.json
 * NO modifica produccion. Solo mide.
 */
const fs = require('fs');
const path = require('path');

// Cargar analyzeGoal actual
const mod = require('./run_flashscore');
const { analyzeGoal, getWindowType, hasMeaningfulStats } = mod;

const p = JSON.parse(fs.readFileSync(path.join(__dirname, 'predictions.json'), 'utf8'));
const verified = p.filter(x => x.predictionCorrect === true || x.predictionCorrect === false);

const DEFAULT_BETAS = {
  baseline: 0.030, xgWeight: 0.8, bcWeight: 1.2, sotWeight: 0.4,
  redCardMult: 1.5, urgency60: 1.30, urgency75: 1.50, lead2Mult: 0.50, lead1LateMult: 0.70
};

function replay(betas, label, analyzeFn) {
  const fn = analyzeFn || analyzeGoal;
  const w = { betas };
  let brier = 0, n = 0;
  const all = [];
  const alerts = [];
  for (const pred of verified) {
    if (!pred.stats || !hasMeaningfulStats(pred.stats)) continue;
    const match = {
      rawName: pred.match, teamHome: pred.teamHome, teamAway: pred.teamAway,
      league: pred.league, matchId: pred.id,
      minute: pred.analysisMinute || 0,
      scoreHome: pred.scoreAtAnalysis?.home ?? 0,
      scoreAway: pred.scoreAtAnalysis?.away ?? 0,
      stats: pred.stats
    };
    const wt = getWindowType(match.minute);
    const r = fn(match, w, {}, null, wt, null);
    const y = pred.goalAfterAnalysis ? 1 : 0;
    brier += Math.pow(r.score / 100 - y, 2);
    n++;
    all.push({ score: r.score, y, minute: match.minute, match: pred.match, old: pred.predictedProbability });
    if (r.score >= 80) alerts.push({ score: r.score, y, minute: match.minute, match: pred.match });
  }
  if (!n) { console.log(label + ': sin datos'); return null; }
  const aHit = alerts.filter(x => x.y).length;
  const mean = all.reduce((s, x) => s + x.score, 0) / all.length;
  const gr = all.filter(x => x.y).length / all.length * 100;
  let ece = 0;
  for (const [a, b] of [[0, 20], [20, 40], [40, 60], [60, 80], [80, 101]]) {
    const arr = all.filter(x => x.score >= a && x.score < b);
    if (!arr.length) continue;
    const ap = arr.reduce((s, x) => s + x.score, 0) / arr.length;
    const ar = arr.filter(x => x.y).length / arr.length * 100;
    ece += arr.length * Math.abs(ap - ar);
  }
  ece /= all.length;
  console.log(
    label.padEnd(32) +
    ' n=' + String(n).padStart(3) +
    ' Brier=' + (brier / n).toFixed(4) +
    ' ECE=' + ece.toFixed(1).padStart(5) +
    ' meanP=' + mean.toFixed(0).padStart(3) +
    ' goal%=' + gr.toFixed(0).padStart(3) +
    ' alerts=' + String(alerts.length).padStart(2) +
    ' hit=' + aHit +
    ' (' + (alerts.length ? (aHit / alerts.length * 100).toFixed(0) : '0') + '%)'
  );
  return { brier: brier / n, ece, mean, gr, alerts: alerts.length, hit: aHit, all, alertList: alerts };
}

console.log('========== BASELINE MODELO ACTUAL ==========');
const base = replay(DEFAULT_BETAS, 'ACTUAL defaults');

// Modelo viejo (scores guardados)
{
  let brier = 0, n = 0, alerts = 0, hit = 0, sum = 0;
  for (const pred of verified) {
    const pr = (pred.predictedProbability || 0) / 100;
    const y = pred.goalAfterAnalysis ? 1 : 0;
    brier += Math.pow(pr - y, 2); n++; sum += pred.predictedProbability || 0;
    if ((pred.predictedProbability || 0) >= 80) { alerts++; if (y) hit++; }
  }
  console.log(
    'VIEJO (scores guardados)'.padEnd(32) +
    ' n=' + String(n).padStart(3) +
    ' Brier=' + (brier / n).toFixed(4) +
    ' ECE=  n/a' +
    ' meanP=' + (sum / n).toFixed(0).padStart(3) +
    ' goal%= n/a' +
    ' alerts=' + String(alerts).padStart(2) +
    ' hit=' + hit
  );
}

console.log('\n========== CALIBRACION ACTUAL ==========');
if (base) {
  for (const [a, b] of [[0, 30], [30, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 101]]) {
    const arr = base.all.filter(x => x.score >= a && x.score < b);
    if (!arr.length) continue;
    const gr = arr.filter(x => x.y).length / arr.length * 100;
    const avg = arr.reduce((s, x) => s + x.score, 0) / arr.length;
    console.log(
      String(a).padStart(3) + '-' + String(b - 1).padEnd(3) +
      ' n=' + String(arr.length).padStart(2) +
      ' goalRate=' + gr.toFixed(0).padStart(3) + '%' +
      ' avgP=' + avg.toFixed(0).padStart(3) + '%' +
      ' gap=' + (avg - gr).toFixed(0)
    );
  }
  console.log('\nAlertas detalle:');
  base.alertList.forEach(a =>
    console.log('  ' + a.score + '% min' + a.minute + ' goal=' + !!a.y + ' ' + a.match)
  );
}

// Sensibilidad baseline (1 param)
console.log('\n========== SENSIBILIDAD baseline (1 param) ==========');
for (const bl of [0.022, 0.026, 0.030, 0.034, 0.038]) {
  replay({ ...DEFAULT_BETAS, baseline: bl }, 'baseline=' + bl);
}

// Sensibilidad xgWeight
console.log('\n========== SENSIBILIDAD xgWeight ==========');
for (const xw of [0.8, 1.0, 1.2, 1.5]) {
  replay({ ...DEFAULT_BETAS, xgWeight: xw }, 'xgWeight=' + xw);
}

// Diagnostico: underconfidence root
console.log('\n========== DIAGNOSTICO UNDERCONFIDENCE ==========');
if (base) {
  const under = base.all.filter(x => x.y && x.score < 50);
  const over = base.all.filter(x => !x.y && x.score >= 70);
  console.log('Goles con score<50 (FN suave):', under.length, '/', base.all.filter(x => x.y).length);
  console.log('Sin gol con score>=70 (FP):', over.length);
  // by minute underconfidence
  for (const m of [0, 30, 45, 60, 75]) {
    const arr = base.all.filter(x => x.minute >= m && x.minute < m + 15);
    if (!arr.length) continue;
    const mean = arr.reduce((s, x) => s + x.score, 0) / arr.length;
    const gr = arr.filter(x => x.y).length / arr.length * 100;
    console.log('min ' + m + '-' + (m + 14) + ': meanP=' + mean.toFixed(0) + ' goal%=' + gr.toFixed(0) + ' gap=' + (mean - gr).toFixed(0) + ' n=' + arr.length);
  }
}

console.log('\n========== BUGS ESTRUCTURALES ==========');
const src = fs.readFileSync(path.join(__dirname, 'run_flashscore.js'), 'utf8');
const learn = fs.readFileSync(path.join(__dirname, 'learn.js'), 'utf8');
const yml = fs.readFileSync(path.join(__dirname, '.github/workflows/analyze.yml'), 'utf8');
const s365 = fs.readFileSync(path.join(__dirname, 'scores365.js'), 'utf8');

const htPenalties = (src.match(/if \(isHalftime\) lambda \*= 0\.55/g) || []).length;
console.log('CRITICO: isHalftime lambda*=0.55 aparece', htPenalties, 'veces (debe ser 1)');
const htTrans = (src.match(/minute >= 44 && minute <=/g) || []).length;
console.log('CRITICO: bloques transicion HT (minute>=44):', htTrans, '(debe ser 1)');

// stale alert
const staleBug = src.includes('realMinSinceAnalysis') && src.includes('predEntry.timestamp') && src.includes('predEntry.analysisMinute');
console.log('CRITICO: stale-check usa timestamp creacion + analysisMinute ya actualizado:', staleBug, '→ bloquea TODAS las alertas tras 10min una vez se guarden preds');

// adjustBetas in runLearning
const rlStart = learn.indexOf('async function runLearning');
const rlBody = learn.slice(rlStart, learn.indexOf('module.exports'));
console.log('CRITICO: runLearning NO llama adjustBetas:', !/adjustBetas\s*\(/.test(rlBody));

// workflow
console.log('ALTO: workflow NO commitea alertas_log.json:', !yml.includes('alertas_log'));
console.log('ALTO: workflow timeout-minutes:', (yml.match(/timeout-minutes:\s*\d+/) || ['?'])[0]);
console.log('ALTO: playwright install en CADA run:', yml.includes('playwright install'));
console.log('ALTO: scores365 descarta min>=90 (descuento):', s365.includes('gameTime < 90'));

// BOM
const alRaw = fs.readFileSync(path.join(__dirname, 'alertas_log.json'));
console.log('MEDIO: alertas_log.json tiene BOM UTF-8:', alRaw[0] === 0xEF && alRaw[1] === 0xBB && alRaw[2] === 0xBF);

// weights
const w = JSON.parse(fs.readFileSync(path.join(__dirname, 'weights.json'), 'utf8'));
console.log('CRITICO: weights sin betas (aprendizaje lambda muerto):', !w.betas);
console.log('CRITICO: 0 predicciones nuevas desde', p.map(x => x.timestamp).filter(Boolean).sort().slice(-1)[0]);
console.log('CRITICO: pending sin verificar:', p.filter(x => x.predictionCorrect === null).length);

// Double count path
console.log('MEDIO: verificacion duplicada learn.js + [4/4] puede doble-contar stats');

// predictionCorrect threshold 70 vs alert 80
console.log('MEDIO: predictionCorrect usa umbral 70%, alertas usan 80% — metricas de accuracy no miden alertas');

console.log('\nDone.');
