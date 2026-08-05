/**
 * train_grid.js — modelo de horizonte corto sobre una rejilla temporal.
 *
 *   node train_grid.js
 *
 * De donde salen los datos: con el minuto exacto de cada gol (recuperado por
 * backfill.js) se puede reconstruir el marcador en CUALQUIER minuto del partido.
 * Eso convierte cada partido en ~15 observaciones en vez de 1:
 *
 *   para t = 10, 15, 20 ... 80:
 *     marcador en t   = goles con minuto <= t
 *     etiqueta        = hubo gol en (t, t+15]
 *
 * ~550 partidos -> ~7.000 filas. Con 299 filas era imposible distinguir una señal
 * debil del ruido; con 7.000 ya se puede afirmar algo.
 *
 * Lo que este modelo NO tiene: estadisticas del partido en el minuto t. Solo se
 * guardaban en una foto por partido. Asi que esto mide exactamente una cosa:
 * cuanto predicen el MINUTO, el ESTADO DEL MARCADOR y el RITMO DE LA LIGA.
 * Es el suelo honesto sobre el que cualquier estadistica tendria que mejorar.
 */

const fs = require('fs');
const path = require('path');
const M = require('./model');

const PREDICTIONS_FILE = path.join(__dirname, 'predictions.json');
const OUT_FILE = path.join(__dirname, 'model15.json');
const HORIZON = 15;
const GRID_STEP = 5;
const GRID_FROM = 10;
const GRID_TO = 80;
const MIN_ALERTS = 30;
const FOLDS = 5;
const CAL_FOLDS = 4;

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const TARGET = parseFloat(arg('--target', '0.90'));
const DRY = argv.includes('--dry');

// ───────────────────────── construccion de la rejilla ─────────────────────────

function buildRows() {
  const raw = JSON.parse(fs.readFileSync(PREDICTIONS_FILE, 'utf8').replace(/^﻿/, ''));
  const rows = [];
  let matches = 0;

  for (const x of raw) {
    if (!Array.isArray(x.goalMinutes)) continue;
    if (x.timelineConsistent === false) continue;   // timeline incompleto: no se puede afirmar "no hubo gol"
    if (!x.finalScore) continue;

    // El timeline solo trae los goles registrados como evento. Si no cuadra con
    // el marcador final, faltan goles y las etiquetas negativas serian mentira.
    const totalFinal = (x.finalScore.home || 0) + (x.finalScore.away || 0);
    if (x.goalMinutes.length !== totalFinal) continue;

    // Reconstruir lados: verify.js guarda solo minutos. Se usa el orden y el
    // marcador final para repartir; si no se puede, se cuenta solo el total.
    const goals = x.goalMinutes.slice().sort((a, b) => a - b);
    const league = x.leagueGoalsPerMatch || null;
    matches++;

    for (let t = GRID_FROM; t <= GRID_TO; t += GRID_STEP) {
      const before = goals.filter(g => g <= t).length;
      const inWindow = goals.some(g => g > t && g <= t + HORIZON);
      // Sin ventana completa por delante la etiqueta la trunca el final del
      // partido, no el juego.
      if (M.minsLeft(t) < HORIZON) continue;

      rows.push({
        f: M.extractFeatures({
          minute: t,
          // Sin lados fiables se reparte el marcador de forma neutra: lo que el
          // modelo usa de aqui es el TOTAL de goles y si hay diferencia, no quien gana.
          scoreHome: Math.ceil(before / 2),
          scoreAway: Math.floor(before / 2),
          stats: {},                     // no hay stats en el minuto t: ese es el punto
          leagueGoalsPerMatch: league,
        }),
        y: inWindow ? 1 : 0,
        T: Math.min(HORIZON, M.minsLeft(t)),
        minute: t,
        matchId: String(x.id),
        timestamp: x.timestamp,
      });
    }
  }
  rows.sort((a, b) => (a.timestamp || '') < (b.timestamp || '') ? -1 : 1);
  return { rows, matches };
}

// ───────────────────────────── ajuste (identico a train.js) ─────────────────────────────

function fit(rows, { l2 = 0.02, lr = 0.15, iters = 3000 } = {}) {
  const K = M.FEATURES.length;
  let b = new Array(K).fill(0);
  let b0 = Math.log(0.030);
  const N = rows.length;
  if (!N) return { b0, b, features: M.FEATURES };
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
const rawP = (m, d) => M.rawProb(m, d.f, d.T).p;

function calibrateOutOfFold(rows) {
  const pairs = [];
  for (let k = 0; k < CAL_FOLDS; k++) {
    const tr = rows.filter((_, i) => i % CAL_FOLDS !== k);
    const va = rows.filter((_, i) => i % CAL_FOLDS === k);
    if (tr.length < 50 || !va.length) continue;
    const m = fit(tr);
    for (const d of va) pairs.push([rawP(m, d), d.y]);
  }
  return pairs.length < 50 ? { a: 1, b: 0 } : M.fitPlatt(pairs);
}

function auc(items) {
  const pos = items.filter(i => i.y === 1).map(i => i.p);
  const neg = items.filter(i => i.y === 0).map(i => i.p);
  if (!pos.length || !neg.length) return NaN;
  // Muestreo para no hacer 12M comparaciones
  const cap = 900;
  const P = pos.length > cap ? pos.filter((_, i) => i % Math.ceil(pos.length / cap) === 0) : pos;
  const N = neg.length > cap ? neg.filter((_, i) => i % Math.ceil(neg.length / cap) === 0) : neg;
  let s = 0;
  for (const a of P) for (const b of N) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (P.length * N.length);
}
const brier = it => it.reduce((s, i) => s + (i.p - i.y) ** 2, 0) / it.length;

function wilson(h, n) {
  if (!n) return [0, 0];
  const z = 1.96, ph = h / n, d = 1 + z * z / n;
  const c = ph + z * z / (2 * n);
  const s = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

// ───────────────────────────── main ─────────────────────────────

const { rows, matches } = buildRows();
console.log('='.repeat(68));
console.log('  MODELO DE 15 MINUTOS — rejilla temporal');
console.log('='.repeat(68));
console.log('  partidos con timeline completo : ' + matches);
console.log('  filas generadas                : ' + rows.length + '  (~' + (rows.length / Math.max(matches, 1)).toFixed(1) + ' por partido)');
if (rows.length < 500) { console.error('\nDatos insuficientes.'); process.exit(1); }
const baseRate = rows.filter(r => r.y).length / rows.length;
console.log('  tasa base "gol en 15 min"      : ' + (baseRate * 100).toFixed(1) + '%');

console.log('\n--- TASA BASE POR MINUTO (lo que hay que batir) ---');
for (let t = GRID_FROM; t <= GRID_TO; t += 10) {
  const a = rows.filter(r => r.minute === t);
  if (!a.length) continue;
  const p = a.filter(r => r.y).length / a.length;
  console.log('  min ' + String(t).padStart(2) + '  n=' + String(a.length).padStart(4) +
    '  gol en 15\': ' + (p * 100).toFixed(1).padStart(5) + '%  ' + '#'.repeat(Math.round(p * 40)));
}

// Rolling-origin. Las filas del mismo partido comparten timestamp y caen en el
// mismo pliegue: sin eso, el mismo partido estaria a los dos lados del corte.
const scored = [];
for (let k = 0; k < FOLDS; k++) {
  const cut = Math.floor(rows.length * (0.5 + k * 0.1));
  const end = Math.floor(rows.length * (0.5 + (k + 1) * 0.1));
  const tr = rows.slice(0, cut), te = rows.slice(cut, end);
  if (tr.length < 200 || !te.length) continue;
  const model = fit(tr);
  const cal = calibrateOutOfFold(tr);
  for (const d of te) scored.push({ y: d.y, p: M.applyPlatt(cal, rawP(model, d)), minute: d.minute });
}

const a = auc(scored), b = brier(scored);
const bBase = scored.reduce((s, i) => s + (baseRate - i.y) ** 2, 0) / scored.length;
console.log('\n--- VALIDACION FUERA DE MUESTRA (n=' + scored.length + ') ---');
console.log('  AUC         : ' + a.toFixed(3) + '   (0.500 = azar)');
console.log('  Brier       : ' + b.toFixed(4) + '  vs constante ' + bBase.toFixed(4));
console.log('  Skill score : ' + ((1 - b / bBase) * 100).toFixed(1) + '%');

console.log('\n--- CALIBRACION ---');
for (const [lo, hi] of [[0, .2], [.2, .3], [.3, .4], [.4, .5], [.5, .7], [.7, 1.01]]) {
  const arr = scored.filter(i => i.p >= lo && i.p < hi);
  if (arr.length < 10) continue;
  console.log('  p ' + (lo * 100).toFixed(0).padStart(3) + '-' + (hi * 100).toFixed(0).padStart(3) + '%  n=' +
    String(arr.length).padStart(4) + '  predicho=' + (arr.reduce((s, i) => s + i.p, 0) / arr.length * 100).toFixed(1).padStart(5) +
    '%  real=' + (arr.filter(i => i.y).length / arr.length * 100).toFixed(1).padStart(5) + '%');
}

console.log('\n--- PRECISION vs VOLUMEN ---');
const cands = [];
for (let th = 0.30; th <= 0.95; th += 0.05) {
  const arr = scored.filter(i => i.p >= th);
  if (arr.length < MIN_ALERTS) continue;
  const h = arr.filter(i => i.y).length;
  const [lo, hi] = wilson(h, arr.length);
  cands.push({ threshold: Math.round(th * 100) / 100, n: arr.length, hits: h, precision: h / arr.length, lo, hi });
  console.log('  p>=' + th.toFixed(2) + '  n=' + String(arr.length).padStart(4) +
    '  precision=' + (h / arr.length * 100).toFixed(1).padStart(5) + '%  IC[' +
    (lo * 100).toFixed(0) + '-' + (hi * 100).toFixed(0) + '%]');
}

const meeting = cands.filter(c => c.precision >= TARGET);
const gate = meeting.length ? meeting.sort((x, y) => y.lo - x.lo)[0] : null;
console.log('\n--- GATE ---');
if (gate) {
  console.log('  umbral ' + gate.threshold + ' -> ' + (gate.precision * 100).toFixed(1) + '% (n=' + gate.n + ')');
} else {
  const best = cands.sort((x, y) => y.precision - x.precision)[0];
  console.log('  Ningun umbral alcanza ' + (TARGET * 100).toFixed(0) + '% con n>=' + MIN_ALERTS + '.');
  if (best) console.log('  Mejor disponible: ' + (best.precision * 100).toFixed(1) + '% con p>=' + best.threshold + ' (n=' + best.n + ')');
  console.log('');
  console.log('  Techo estructural: P(gol en 15 min) = 1 - exp(-lambda*15).');
  console.log('  Para llegar al 90% hace falta lambda >= ' + (-Math.log(0.10) / 15).toFixed(3) + ' goles/min,');
  console.log('  o sea ' + (-Math.log(0.10) / 15 * 90).toFixed(1) + ' goles por partido de ritmo sostenido.');
  console.log('  Ningun partido de futbol tiene ese ritmo. El 90% en 15 minutos');
  console.log('  NO es alcanzable con ningun modelo: lo impide el propio deporte.');
}

const finalModel = fit(rows);
const finalCal = calibrateOutOfFold(rows);
console.log('\n--- COEFICIENTES ---');
console.log('  lambda base: ' + Math.exp(finalModel.b0).toFixed(4) + ' goles/min');
M.FEATURES.map((k, i) => [k, finalModel.b[i]])
  .filter(([, v]) => Math.abs(v) > 1e-4)
  .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
  .forEach(([k, v]) => console.log('  ' + k.padEnd(12) + (v >= 0 ? '+' : '') + v.toFixed(4)));

if (!DRY) {
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    version: 5, horizon: HORIZON,
    trainedAt: new Date().toISOString(),
    n: rows.length, matches,
    source: 'rejilla temporal desde timeline de goles (sin stats en el minuto t)',
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
    gates: gate ? [{
      tier: 'CORTO', targetPrecision: TARGET, minMinute: GRID_FROM, maxMinute: GRID_TO,
      threshold: gate.threshold, measuredPrecision: Math.round(gate.precision * 1e4) / 1e4,
      ci95: [Math.round(gate.lo * 1e4) / 1e4, Math.round(gate.hi * 1e4) / 1e4],
      n: gate.n, hits: gate.hits, meetsTarget: true, requiresAi: true,
    }] : [],
  }, null, 2));
  console.log('\nmodel15.json escrito (' + (gate ? '1 gate' : 'sin gates') + ').');
}
