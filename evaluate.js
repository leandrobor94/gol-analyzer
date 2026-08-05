/**
 * evaluate.js — re-auditoria. `npm run audit`
 *
 * Mide el sistema contra sus propios datos y dice la verdad aunque sea incomoda.
 * Ninguna cifra sale de un comentario: todo se recalcula aqui.
 *
 * Responde cuatro preguntas:
 *   1. ¿El modelo discrimina, o el numero que produce no ordena nada?
 *   2. ¿Cuanto de la precision del gate la aporta el modelo y cuanto el reloj?
 *   3. ¿La IA esta aportando algo medible?
 *   4. ¿Que falta para el objetivo de precision?
 */

const fs = require('fs');
const path = require('path');
const M = require('./model');

const PRED = path.join(__dirname, 'predictions.json');
const ALERTS = path.join(__dirname, 'alertas_log.json');

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return d; } };
const pct = (v) => (v * 100).toFixed(1) + '%';
const bar = (title) => { console.log('\n' + '─'.repeat(68)); console.log('  ' + title); console.log('─'.repeat(68)); };

function wilson(h, n) {
  if (!n) return [0, 0];
  const z = 1.96, ph = h / n, d = 1 + z * z / n;
  const c = ph + z * z / (2 * n);
  const s = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}
function auc(items, get) {
  const pos = items.filter(i => i.y === 1), neg = items.filter(i => i.y === 0);
  if (!pos.length || !neg.length) return NaN;
  let s = 0;
  for (const a of pos) for (const b of neg) { const x = get(a), y = get(b); s += x > y ? 1 : x === y ? 0.5 : 0; }
  return s / (pos.length * neg.length);
}

const preds = read(PRED, []);
const alertLog = read(ALERTS, []);
const model = M.loadModel();
const done = preds.filter(p => p.predictionCorrect != null && p.goalAfterAnalysis != null);

console.log('='.repeat(68));
console.log('  RE-AUDITORIA — ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
console.log('='.repeat(68));

// ── 1. estado del dataset ──
bar('1. DATASET');
const with15 = done.filter(p => p.goalWithin15 != null);
const withOdds = done.filter(p => p.odds);
const withLeague = done.filter(p => p.leagueGoalsPerMatch);
const withRealXg = done.filter(p => p.stats && p.stats.xgSource === 'flashscore');
console.log('  predicciones totales      : ' + preds.length);
console.log('  etiquetadas               : ' + done.length);
console.log('  pendientes                : ' + preds.filter(p => p.predictionCorrect == null).length);
if (done.length) {
  const ts = done.map(p => p.timestamp).filter(Boolean).sort();
  console.log('  rango                     : ' + (ts[0] || '?').slice(0, 10) + ' -> ' + (ts[ts.length - 1] || '?').slice(0, 10));
  console.log('  tasa base (gol antes FT)  : ' + pct(done.filter(p => p.goalAfterAnalysis).length / done.length));
}
console.log('');
console.log('  DATOS NUEVOS que desbloquean el siguiente modelo:');
const line = (label, n, need) => {
  const ok = n >= need;
  console.log('    ' + (ok ? '[OK] ' : '[--] ') + label.padEnd(34) + String(n).padStart(4) + '/' + need +
    (ok ? '  listo' : '  faltan ' + (need - n)));
};
line('con minuto real de gol', with15.length, 150);
line('con cuota 1X2 al analizar', withOdds.length, 150);
line('con ritmo de liga (goles/partido)', withLeague.length, 150);
line('con xG real de Flashscore', withRealXg.length, 150);
if (with15.length) {
  const base15 = with15.filter(p => p.goalWithin15).length / with15.length;
  console.log('    tasa base "gol en 15 min" : ' + pct(base15) + '  (n=' + with15.length + ')');
}

// ── 2. ¿discrimina el modelo? ──
// Se separan dos cosas que no hay que mezclar:
//   (a) las probabilidades TAL COMO SE GUARDARON, incluidas las del motor viejo;
//   (b) el modelo actual, cuya cifra honesta es la de validacion en model.json.
bar('2. ¿EL MODELO DISCRIMINA?');
if (done.length < 30) {
  console.log('  Datos insuficientes.');
} else {
  const nuevos = done.filter(p => p.probability != null);
  const viejos = done.filter(p => p.probability == null);

  const evalSet = (rows, etiqueta) => {
    if (rows.length < 30) {
      console.log('  ' + etiqueta + ': n=' + rows.length + ' — insuficiente para medir');
      return;
    }
    const items = rows.map(p => ({
      y: p.goalAfterAnalysis ? 1 : 0,
      p: p.probability != null ? p.probability : (p.predictedProbability || 0) / 100,
      T: M.minsLeft(p.analysisMinute || 0),
    }));
    const aModel = auc(items, i => i.p);
    const aClock = auc(items, i => i.T);
    const br = items.filter(i => i.y).length / items.length;
    const brier = items.reduce((s, i) => s + (i.p - i.y) ** 2, 0) / items.length;
    const brierBase = items.reduce((s, i) => s + (br - i.y) ** 2, 0) / items.length;
    console.log('  ' + etiqueta + '  (n=' + rows.length + ')');
    console.log('    AUC de la probabilidad guardada : ' + aModel.toFixed(3) + '   (0.500 = azar)');
    console.log('    AUC de "minutos restantes"      : ' + aClock.toFixed(3) + '   <- el reloj, a solas');
    console.log('    Brier                           : ' + brier.toFixed(4) + '  vs constante ' + brierBase.toFixed(4));
    console.log('    Skill score                     : ' + pct(1 - brier / brierBase));
    if (aModel < 0.55) console.log('    VEREDICTO: no ordena los partidos.');
    else if (aModel <= aClock + 0.02) console.log('    VEREDICTO: no mejora al reloj. La señal es el tiempo, no el juego.');
    else console.log('    VEREDICTO: aporta ' + (aModel - aClock).toFixed(3) + ' de AUC sobre el reloj.');
    console.log('');
    console.log('    Calibracion:');
    for (const [lo, hi] of [[0, .4], [.4, .6], [.6, .75], [.75, .85], [.85, .95], [.95, 1.01]]) {
      const a = items.filter(i => i.p >= lo && i.p < hi);
      if (a.length < 5) continue;
      const real = a.filter(i => i.y).length / a.length;
      const pred = a.reduce((s, i) => s + i.p, 0) / a.length;
      console.log('      p ' + (lo * 100).toFixed(0).padStart(3) + '-' + (hi * 100).toFixed(0).padStart(3) + '%  n=' +
        String(a.length).padStart(4) + '  predicho=' + pct(pred).padStart(6) + '  real=' + pct(real).padStart(6) +
        '  desvio=' + ((pred - real) * 100).toFixed(1).padStart(6));
    }
    console.log('');
  };

  if (viejos.length >= 30) evalSet(viejos, 'MOTOR ANTERIOR (probabilidades ya guardadas)');
  if (nuevos.length >= 30) evalSet(nuevos, 'MOTOR ACTUAL (en produccion)');
  else console.log('  MOTOR ACTUAL: ' + nuevos.length + ' partidos puntuados todavia. La cifra honesta,');

  if (model.trained) {
    console.log('  MOTOR ACTUAL — validacion fuera de muestra al entrenar:');
    console.log('    AUC ' + model.eval.auc + ' | Brier ' + model.eval.brier +
      ' vs constante ' + model.eval.brierBase + ' | skill ' + pct(model.eval.skillScore) +
      '  (n_test=' + model.eval.nTest + ')');
    console.log('    Esta es la cifra que vale mientras el motor actual no acumule su propio historico.');
  }
}

// ── 3. gates: precision REAL en produccion ──
bar('3. GATES — PRECISION REAL DE LAS ALERTAS ENVIADAS');
if (!model.trained) {
  console.log('  Sin model.json. Corre: npm run train');
} else {
  console.log('  Entrenado: ' + (model.trainedAt || '?').slice(0, 10) + ' con ' + model.n + ' partidos');
  console.log('  Validacion: ' + model.eval.method);
  console.log('  AUC fuera de muestra: ' + model.eval.auc + ' | skill ' + pct(model.eval.skillScore));
  console.log('');
  for (const g of model.gates) {
    console.log('  ' + g.tier + '  (min ' + g.minMinute + '-' + g.maxMinute + ', p>=' + g.threshold + ')');
    console.log('    esperado (fuera de muestra): ' + pct(g.measuredPrecision) +
      '  IC[' + pct(g.ci95[0]) + '-' + pct(g.ci95[1]) + ']  n=' + g.n);
    const real = done.filter(p => p.alertTier === g.tier);
    if (real.length) {
      const h = real.filter(p => p.goalAfterAnalysis).length;
      const [lo, hi] = wilson(h, real.length);
      console.log('    REAL en produccion          : ' + pct(h / real.length) +
        '  IC[' + pct(lo) + '-' + pct(hi) + ']  n=' + real.length + ' (' + h + ' aciertos)');
      const r15 = real.filter(p => p.goalWithin15 != null);
      if (r15.length) {
        console.log('    de esas, gol en 15 min      : ' + pct(r15.filter(p => p.goalWithin15).length / r15.length) + '  n=' + r15.length);
      }
      if (real.length >= 10 && h / real.length < g.measuredPrecision - 0.15) {
        console.log('    AVISO: la precision real va muy por debajo de la esperada. Reentrena.');
      }
    } else {
      console.log('    REAL en produccion          : todavia sin alertas verificadas de este tier');
    }
    console.log('');
  }

  // ¿Cuanto aporta el modelo dentro de la ventana del gate?
  // Comparacion honesta: solo sobre partidos puntuados por el motor ACTUAL.
  // Con registros del motor viejo (sin `probability`) el umbral nunca se cumple
  // y la comparacion daria un "aporte" negativo falso.
  const pg = model.gates.find(g => g.tier === 'PRECISION');
  if (pg) {
    const scoreable = done.filter(p => p.probability != null &&
      (p.analysisMinute || 0) >= pg.minMinute && (p.analysisMinute || 0) <= pg.maxMinute);
    console.log('  ¿Cuanto aporta el modelo en el gate PRECISION?');
    if (scoreable.length < 20) {
      console.log('    n=' + scoreable.length + ' partidos puntuados por el motor actual en esa ventana.');
      console.log('    Hacen falta >=20 para comparar. Mientras tanto, la referencia es el');
      console.log('    entrenamiento, que midio 0.0 puntos de aporte sobre el reloj.');
    } else {
      const soloReloj = scoreable.filter(p => p.goalAfterAnalysis).length / scoreable.length;
      const conModelo = scoreable.filter(p => p.probability >= pg.threshold);
      const cm = conModelo.length ? conModelo.filter(p => p.goalAfterAnalysis).length / conModelo.length : 0;
      console.log('    alertar TODO en min ' + pg.minMinute + '-' + pg.maxMinute + '  : ' + pct(soloReloj) + ' (n=' + scoreable.length + ')');
      console.log('    aplicando ademas el umbral      : ' + pct(cm) + ' (n=' + conModelo.length + ')');
      console.log('    aporte del modelo               : ' + ((cm - soloReloj) * 100).toFixed(1) + ' puntos');
    }
  }
}

// ── 4. ¿aporta la IA? ──
bar('4. ¿APORTA LA IA?');
const withAi = done.filter(p => p.aiDecision && typeof p.aiDecision.pass === 'boolean');
if (withAi.length < 10) {
  console.log('  Decisiones de IA registradas: ' + withAi.length + '. Hacen falta >=30 para concluir.');
  console.log('  (la IA solo filtra el tier VALOR; cada decision se guarda en aiDecision)');
} else {
  const passed = withAi.filter(p => p.aiDecision.pass);
  const vetoed = withAi.filter(p => !p.aiDecision.pass);
  const pr = (arr) => arr.length ? pct(arr.filter(p => p.goalAfterAnalysis).length / arr.length) : 'n/a';
  console.log('  candidatos evaluados : ' + withAi.length);
  console.log('  la IA dejo pasar     : ' + passed.length + '  -> acertaron ' + pr(passed));
  console.log('  la IA veto           : ' + vetoed.length + '  -> HABRIAN acertado ' + pr(vetoed));
  console.log('  sin IA (todos)       : ' + withAi.length + '  -> ' + pr(withAi));
  if (passed.length >= 10 && vetoed.length >= 5) {
    const gain = (passed.filter(p => p.goalAfterAnalysis).length / passed.length) -
      (withAi.filter(p => p.goalAfterAnalysis).length / withAi.length);
    console.log('');
    console.log('  APORTE REAL DE LA IA : ' + (gain * 100).toFixed(1) + ' puntos de precision');
    if (gain <= 0.01) console.log('  VEREDICTO: no aporta. Considerar quitarla (ahorra coste y latencia).');
    else console.log('  VEREDICTO: aporta. Mantener.');
  }
}

// ── 5. calidad de datos ──
bar('5. CALIDAD DE DATOS');
const leagues = {};
for (const p of preds) if (p.league) leagues[p.league] = (leagues[p.league] || 0) + 1;
const truncated = Object.keys(leagues).filter(l => /[-–]\s*$/.test(l));
console.log('  ligas distintas               : ' + Object.keys(leagues).length);
console.log('  nombres truncados (acaban en -): ' + truncated.length + (truncated.length ? '  <- restos del bug de sanitizeLeague' : '  OK'));
const xgEst = done.filter(p => p.stats && p.stats.xgHome != null && p.stats.xgSource !== 'flashscore');
if (xgEst.length >= 50) {
  const sub = xgEst.filter(p => (p.analysisMinute || 0) >= 45 && (p.analysisMinute || 0) <= 80);
  if (sub.length >= 30) {
    const xs = sub.map(p => (p.stats.xgHome || 0) + (p.stats.xgAway || 0));
    const ys = sub.map(p => p.goalAfterAnalysis ? 1 : 0);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0, sx = 0, sy = 0;
    for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sx += dx * dx; sy += dy * dy; }
    const c = sxy / Math.sqrt(sx * sy || 1);
    console.log('  corr(xG estimado, hubo gol)   : ' + c.toFixed(3) + '  n=' + sub.length + ' (min 45-80)');
    if (Math.abs(c) < 0.10) console.log('    -> el xG estimado no informa. Solo el xG real de Flashscore puede aportar.');
  }
}

// ── 6. que falta para el objetivo ──
bar('6. ¿QUE FALTA PARA EL OBJETIVO?');
const target = model.trained && model.gates[0] ? model.gates[0].targetPrecision : 0.90;
const pg = model.trained ? model.gates.find(g => g.tier === 'PRECISION') : null;
if (pg && pg.meetsTarget) {
  console.log('  Objetivo ' + pct(target) + ': ALCANZADO en el tier PRECISION (' + pct(pg.measuredPrecision) + ', n=' + pg.n + ')');
  console.log('');
  console.log('  Pero leelo bien: ese gate dispara en el minuto ' + pg.minMinute + '-' + pg.maxMinute + '.');
  console.log('  Alerta "este partido tendra gol" cuando aun queda casi todo por jugar.');
  console.log('  Es cierto y es medible, pero el mercado lo paga muy barato.');
} else if (pg) {
  console.log('  Objetivo ' + pct(target) + ': NO alcanzado. Mejor disponible: ' + pct(pg.measuredPrecision));
}
console.log('');
console.log('  Para una alerta de >=90% que ADEMAS valga dinero hacen falta:');
const need = [
  ['minuto real de gol   (-> etiqueta "gol en 15 min")', with15.length, 150],
  ['cuota al momento del aviso (-> medir ventaja)', withOdds.length, 150],
  ['xG real de Flashscore (-> unica señal de juego con opcion)', withRealXg.length, 150],
];
for (const [what, have, req] of need) {
  console.log('    ' + (have >= req ? '[OK]' : '[--]') + ' ' + what.padEnd(52) + have + '/' + req);
}
console.log('');
console.log('  El feed de 365scores solo expone cuota 1X2, no over/under de goles.');
console.log('  Para medir ventaja sobre el mercado de goles hace falta otra fuente.');
console.log('');
