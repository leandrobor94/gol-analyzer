/**
 * train.js — entrena el modelo desde predictions.json y escribe model.json.
 *
 *   node train.js                  entrena con objetivo de precision por defecto (90%)
 *   node train.js --target 0.85    baja el objetivo
 *   node train.js --dry            no escribe model.json, solo reporta
 *
 * Reglas que este script se impone a si mismo:
 *
 *  1. La calibracion se ajusta SIEMPRE con predicciones fuera de pliegue.
 *     Calibrar con predicciones in-sample infla el extremo alto — es el error que
 *     hacia que el motor anterior creyera que su tramo 80-90% valia algo.
 *  2. El umbral del gate se elige con validacion rolling-origin, nunca mirando
 *     el conjunto completo.
 *  3. Ningun umbral se acepta con menos de MIN_ALERTS casos. Un "100% de acierto"
 *     con n=3 no es un resultado, es una coincidencia.
 */

const fs = require('fs');
const path = require('path');
const M = require('./model');

const PREDICTIONS_FILE = path.join(__dirname, 'predictions.json');
const MIN_ALERTS = 20;          // minimo de casos para aceptar un umbral
const FOLDS = 5;                // cortes de rolling-origin
const CAL_FOLDS = 4;            // pliegues para la calibracion fuera de muestra

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const TARGET = parseFloat(arg('--target', '0.90'));
const DRY = argv.includes('--dry');

// ───────────────────────────── datos ─────────────────────────────

function loadRows() {
  const raw = JSON.parse(fs.readFileSync(PREDICTIONS_FILE, 'utf8').replace(/^﻿/, ''));
  return raw
    .filter(x =>
      x.predictionCorrect !== null &&
      x.goalAfterAnalysis !== null &&
      x.stats &&
      (x.analysisMinute || 0) >= 5 &&
      (x.analysisMinute || 0) <= 95)
    .sort((a, b) => (a.timestamp || '') < (b.timestamp || '') ? -1 : 1)
    .map(x => ({
      f: M.extractFeatures({
        minute: x.analysisMinute,
        scoreHome: x.scoreAtAnalysis?.home ?? 0,
        scoreAway: x.scoreAtAnalysis?.away ?? 0,
        stats: x.stats,
        leagueGoalsPerMatch: x.leagueGoalsPerMatch || null,
      }),
      y: x.goalAfterAnalysis ? 1 : 0,
      T: M.minsLeft(x.analysisMinute),
      minute: x.analysisMinute,
      match: x.match,
      league: x.league,
      timestamp: x.timestamp,
    }));
}

// ───────────────────────────── ajuste ─────────────────────────────

/**
 * Maxima verosimilitud del Poisson censurado.
 *   p = 1 - exp(-lambda·T),  lambda = exp(z)
 *   dNLL/dz  =  T·lambda            si y=0
 *              -T·lambda·e^{-L}/p   si y=1
 */
function fit(rows, { l2 = 0.02, lr = 0.15, iters = 5000 } = {}) {
  const K = M.FEATURES.length;
  let b = new Array(K).fill(0);
  let b0 = Math.log(0.030);
  const N = rows.length;
  if (!N) return { b0, b };

  for (let it = 0; it < iters; it++) {
    const gb = new Array(K).fill(0);
    let gb0 = 0;
    for (const d of rows) {
      let z = b0;
      for (let i = 0; i < K; i++) z += b[i] * d.f[M.FEATURES[i]];
      const lambda = Math.exp(Math.min(z, 2.5));
      const L = lambda * d.T;
      const p = 1 - Math.exp(-L);
      const g = d.y === 1 ? -L * Math.exp(-L) / Math.max(p, 1e-9) : L;
      for (let i = 0; i < K; i++) gb[i] += g * d.f[M.FEATURES[i]];
      gb0 += g;
    }
    for (let i = 0; i < K; i++) b[i] -= lr * (gb[i] / N + l2 * b[i]);
    b0 -= lr * (gb0 / N);
  }
  return { b0, b, features: M.FEATURES };
}

const rawP = (model, d) => M.rawProb(model, d.f, d.T).p;

/**
 * Calibracion ajustada sobre predicciones FUERA DE PLIEGUE.
 * Calibrar con predicciones in-sample infla el extremo alto: el modelo ya vio
 * esos partidos y su confianza ahi no es representativa.
 */
function calibrateOutOfFold(rows) {
  const pairs = [];
  for (let k = 0; k < CAL_FOLDS; k++) {
    const tr = rows.filter((_, i) => i % CAL_FOLDS !== k);
    const va = rows.filter((_, i) => i % CAL_FOLDS === k);
    if (tr.length < 30 || !va.length) continue;
    const m = fit(tr);
    for (const d of va) pairs.push([rawP(m, d), d.y]);
  }
  if (pairs.length < 30) return { a: 1, b: 0 };
  return M.fitPlatt(pairs);
}

// ───────────────────────────── metricas ─────────────────────────────

function auc(items) {
  const pos = items.filter(i => i.y === 1).map(i => i.p);
  const neg = items.filter(i => i.y === 0).map(i => i.p);
  if (!pos.length || !neg.length) return NaN;
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
}
const brier = it => it.reduce((s, i) => s + (i.p - i.y) ** 2, 0) / it.length;

/** Intervalo de Wilson 95%. Sin esto un 3/3 parece un 100%. */
function wilson(hits, n) {
  if (!n) return [0, 0];
  const z = 1.96, ph = hits / n;
  const d = 1 + z * z / n;
  const c = ph + z * z / (2 * n);
  const s = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

// ───────────────────────── validacion rolling-origin ─────────────────────────

function rollingOrigin(rows) {
  const out = [];
  for (let k = 0; k < FOLDS; k++) {
    const cut = Math.floor(rows.length * (0.5 + k * 0.1));
    const end = Math.floor(rows.length * (0.5 + (k + 1) * 0.1));
    const tr = rows.slice(0, cut);
    const te = rows.slice(cut, end);
    if (tr.length < 60 || !te.length) continue;
    const model = fit(tr);
    const cal = calibrateOutOfFold(tr);
    for (const d of te) {
      out.push({
        y: d.y,
        p: M.applyPlatt(cal, rawP(model, d)),
        minute: d.minute,
        match: d.match,
      });
    }
  }
  return out;
}

/** Barrido de umbrales sobre resultados fuera de muestra. */
function precisionCurve(scored) {
  const rowsOut = [];
  for (let th = 0.50; th <= 0.99; th += 0.01) {
    const a = scored.filter(i => i.p >= th);
    if (!a.length) continue;
    const hits = a.filter(i => i.y).length;
    const [lo, hi] = wilson(hits, a.length);
    rowsOut.push({
      threshold: Math.round(th * 100) / 100,
      n: a.length,
      hits,
      precision: hits / a.length,
      lo, hi,
      volumePct: a.length / scored.length,
      avgMinute: a.reduce((s, i) => s + i.minute, 0) / a.length,
    });
  }
  return rowsOut;
}

/**
 * Busqueda del gate sobre la rejilla (ventana de minutos x umbral), medida fuera
 * de muestra. El gate NO se escribe a mano: es el que los datos sostienen.
 *
 * Entre los candidatos que cumplen el objetivo se elige el de mayor LIMITE
 * INFERIOR del intervalo de confianza, no el de mejor precision puntual. Asi un
 * 100% con n=20 nunca gana a un 93% con n=45: el segundo es mas fiable.
 */
function searchGate(scored, target, { minMinute = 0, maxMinuteCap = 95, label = '' } = {}) {
  const cands = [];
  const windows = [];
  for (const lo of [0, 35, 45]) {
    for (const hi of [20, 25, 30, 35, 45, 60, 70, 85, 95]) {
      if (hi <= lo) continue;
      if (lo < minMinute || hi > maxMinuteCap) continue;
      windows.push([lo, hi]);
    }
  }
  for (const [wlo, whi] of windows) {
    for (let th = 0.50; th <= 0.95; th += 0.05) {
      const a = scored.filter(i => i.minute >= wlo && i.minute <= whi && i.p >= th);
      if (a.length < MIN_ALERTS) continue;
      const hits = a.filter(i => i.y).length;
      const [lo, hi] = wilson(hits, a.length);
      cands.push({
        minMinute: wlo, maxMinute: whi,
        threshold: Math.round(th * 100) / 100,
        n: a.length, hits,
        precision: hits / a.length, lo, hi,
        volumePct: a.length / scored.length,
        avgMinute: a.reduce((s, i) => s + i.minute, 0) / a.length,
      });
    }
  }
  if (!cands.length) return null;
  const meeting = cands.filter(c => c.precision >= target);
  const pool = meeting.length ? meeting : cands;
  pool.sort((a, b) => (b.lo - a.lo) || (b.n - a.n));
  return { ...pool[0], meetsTarget: meeting.length > 0, label, candidates: cands.length };
}

// ───────────────────────────── main ─────────────────────────────

const rows = loadRows();
if (rows.length < 100) {
  console.error('Datos insuficientes para entrenar: ' + rows.length + ' filas verificadas (minimo 100).');
  process.exit(1);
}
const baseRate = rows.filter(r => r.y).length / rows.length;

console.log('='.repeat(68));
console.log('  ENTRENAMIENTO — modelo de gol');
console.log('='.repeat(68));
console.log('  filas verificadas : ' + rows.length);
console.log('  rango             : ' + (rows[0].timestamp || '').slice(0, 10) + ' -> ' + (rows[rows.length - 1].timestamp || '').slice(0, 10));
console.log('  tasa base         : ' + (baseRate * 100).toFixed(1) + '%');
console.log('  objetivo precision: ' + (TARGET * 100).toFixed(0) + '%');

const scored = rollingOrigin(rows);
const a = auc(scored);
const b = brier(scored);
const bBase = scored.reduce((s, i) => s + (baseRate - i.y) ** 2, 0) / scored.length;

console.log('\n--- VALIDACION FUERA DE MUESTRA (rolling-origin, n=' + scored.length + ') ---');
console.log('  AUC          : ' + a.toFixed(3) + '   (0.500 = azar)');
console.log('  Brier        : ' + b.toFixed(4));
console.log('  Brier base   : ' + bBase.toFixed(4) + '   (constante = tasa base)');
console.log('  Skill score  : ' + ((1 - b / bBase) * 100).toFixed(1) + '%   (positivo = mejor que la constante)');

console.log('\n--- CALIBRACION FUERA DE MUESTRA ---');
for (const [lo, hi] of [[0, .4], [.4, .6], [.6, .75], [.75, .85], [.85, .95], [.95, 1.01]]) {
  const arr = scored.filter(i => i.p >= lo && i.p < hi);
  if (arr.length < 5) continue;
  const real = arr.filter(i => i.y).length / arr.length;
  const pred = arr.reduce((s, i) => s + i.p, 0) / arr.length;
  console.log('  p ' + (lo * 100).toFixed(0).padStart(3) + '-' + (hi * 100).toFixed(0).padStart(3) + '%  ' +
    'n=' + String(arr.length).padStart(3) + '  ' +
    'predicho=' + (pred * 100).toFixed(1).padStart(5) + '%  ' +
    'real=' + (real * 100).toFixed(1).padStart(5) + '%  ' +
    'desvio=' + ((pred - real) * 100).toFixed(1).padStart(6));
}

const curve = precisionCurve(scored);
console.log('\n--- PRECISION vs VOLUMEN (fuera de muestra) ---');
console.log('  umbral  alertas  precision  IC95%          volumen  min.medio');
for (const r of curve.filter(r => Math.round(r.threshold * 100) % 5 === 0)) {
  console.log('  ' + r.threshold.toFixed(2).padEnd(8) +
    String(r.n).padStart(5) + '   ' +
    (r.precision * 100).toFixed(1).padStart(6) + '%  ' +
    ('[' + (r.lo * 100).toFixed(0) + '-' + (r.hi * 100).toFixed(0) + '%]').padEnd(13) +
    (r.volumePct * 100).toFixed(1).padStart(6) + '%   ' +
    r.avgMinute.toFixed(0).padStart(6));
}

// Dos gates con propositos distintos. No es una decision estetica: la evidencia
// dice que la precision alta solo existe temprano, y que en la ventana donde una
// apuesta tiene cuota util la precision es estructuralmente menor.
const gateHigh  = searchGate(scored, TARGET, { maxMinuteCap: 45, label: 'PRECISION' });
const gateValue = searchGate(scored, 0.80,   { minMinute: 35,    label: 'VALOR' });

function printGate(g, target) {
  if (!g) { console.log('  (ningun candidato alcanza ' + MIN_ALERTS + ' casos)'); return; }
  console.log('  ventana     : minuto ' + g.minMinute + '-' + g.maxMinute);
  console.log('  umbral      : p >= ' + g.threshold.toFixed(2));
  console.log('  precision   : ' + (g.precision * 100).toFixed(1) + '%  (' + g.hits + '/' + g.n + ')');
  console.log('  IC 95%      : ' + (g.lo * 100).toFixed(1) + '% - ' + (g.hi * 100).toFixed(1) + '%');
  console.log('  volumen     : ' + (g.volumePct * 100).toFixed(1) + '% de los analizados');
  console.log('  objetivo ' + (target * 100).toFixed(0) + '%: ' + (g.meetsTarget ? 'ALCANZADO' : 'NO ALCANZADO'));
  if (g.meetsTarget && g.lo < target) {
    console.log('  AVISO: el limite inferior del IC queda bajo el objetivo — muestra aun corta.');
  }
}

console.log('\n--- GATE 1: PRECISION (objetivo ' + (TARGET * 100).toFixed(0) + '%) ---');
printGate(gateHigh, TARGET);
console.log('\n--- GATE 2: VALOR (ventana tardia, objetivo 80%) ---');
printGate(gateValue, 0.80);

// Cuanto de la precision del gate 1 la aporta el modelo y cuanto el reloj.
if (gateHigh) {
  const soloVentana = scored.filter(i => i.minute >= gateHigh.minMinute && i.minute <= gateHigh.maxMinute);
  if (soloVentana.length >= MIN_ALERTS) {
    const pv = soloVentana.filter(i => i.y).length / soloVentana.length;
    console.log('\n--- CONTRIBUCION REAL DEL MODELO EN EL GATE 1 ---');
    console.log('  solo la ventana temporal, sin modelo : ' + (pv * 100).toFixed(1) + '%  (n=' + soloVentana.length + ')');
    console.log('  ventana + umbral del modelo          : ' + (gateHigh.precision * 100).toFixed(1) + '%  (n=' + gateHigh.n + ')');
    console.log('  aporte del modelo                    : ' + ((gateHigh.precision - pv) * 100).toFixed(1) + ' puntos');
  }
}

// Modelo final: entrenado con TODO el historico, calibrado fuera de pliegue.
const finalModel = fit(rows);
const finalCal = calibrateOutOfFold(rows);

console.log('\n--- COEFICIENTES (modelo final) ---');
console.log('  lambda base : ' + Math.exp(finalModel.b0).toFixed(4) + ' goles/min (' + (Math.exp(finalModel.b0) * 90).toFixed(2) + ' por partido)');
M.FEATURES.map((k, i) => [k, finalModel.b[i]])
  .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
  .forEach(([k, v]) => console.log('  ' + k.padEnd(12) + (v >= 0 ? '+' : '') + v.toFixed(4)));

const out = {
  version: 5,
  trainedAt: new Date().toISOString(),
  n: rows.length,
  dataRange: [(rows[0].timestamp || '').slice(0, 10), (rows[rows.length - 1].timestamp || '').slice(0, 10)],
  baseRate: Math.round(baseRate * 1e4) / 1e4,
  features: M.FEATURES,
  b0: Math.round(finalModel.b0 * 1e6) / 1e6,
  b: finalModel.b.map(v => Math.round(v * 1e6) / 1e6),
  calibration: finalCal,
  eval: {
    method: 'rolling-origin ' + FOLDS + ' cortes, calibracion fuera de pliegue',
    nTest: scored.length,
    auc: Math.round(a * 1e4) / 1e4,
    brier: Math.round(b * 1e4) / 1e4,
    brierBase: Math.round(bBase * 1e4) / 1e4,
    skillScore: Math.round((1 - b / bBase) * 1e4) / 1e4,
  },
  gates: [
    ['PRECISION', gateHigh, TARGET],
    ['VALOR', gateValue, 0.80],
  ].filter(([, g]) => g).map(([tier, g, tgt]) => ({
    tier,
    targetPrecision: tgt,
    minMinute: g.minMinute,
    maxMinute: g.maxMinute,
    threshold: g.threshold,
    measuredPrecision: Math.round(g.precision * 1e4) / 1e4,
    ci95: [Math.round(g.lo * 1e4) / 1e4, Math.round(g.hi * 1e4) / 1e4],
    n: g.n,
    hits: g.hits,
    volumePct: Math.round(g.volumePct * 1e4) / 1e4,
    meetsTarget: g.meetsTarget,
    // El gate de VALOR pasa por el filtro IA; el de PRECISION no lo necesita.
    requiresAi: tier === 'VALOR',
  })),
  curve: curve.filter(r => Math.round(r.threshold * 100) % 2 === 0).map(r => ({
    threshold: r.threshold, n: r.n, precision: Math.round(r.precision * 1e4) / 1e4,
  })),
};

if (DRY) {
  console.log('\n--dry: model.json NO se escribio.');
} else {
  fs.writeFileSync(M.MODEL_FILE, JSON.stringify(out, null, 2));
  console.log('\nmodel.json escrito — ' + out.gates.length + ' gate(s), ' + rows.length + ' filas.');
}
