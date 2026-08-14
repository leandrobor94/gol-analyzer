/**
 * _combos.js — busqueda sistematica de combinaciones de variables.
 *
 * EL PELIGRO DE ESTO, Y COMO SE CONTROLA
 *
 * Probar muchas combinaciones y quedarse con la mejor es la forma mas fiable de
 * encontrar algo que no existe. Con 100 pruebas sobre datos SIN señal, la mejor
 * saldra claramente por encima del azar solo por ser la mejor de 100.
 *
 * Por eso aqui se hacen tres cosas que casi nunca se hacen:
 *
 *   1. Particion TEMPORAL: se ajusta con el pasado y se mide en el futuro.
 *      Nunca se mide sobre lo mismo con lo que se ajusto.
 *
 *   2. Se genera una DISTRIBUCION NULA: se repite exactamente la misma busqueda
 *      —el mismo numero de combinaciones— sobre etiquetas BARAJADAS, donde por
 *      construccion no hay nada que encontrar. El mejor AUC de esa busqueda es
 *      el liston: cualquier resultado real por debajo de el es indistinguible
 *      del azar por muchos decimales que tenga.
 *
 *   3. Se reporta CUANTAS combinaciones se probaron. Un resultado sin ese numero
 *      no se puede interpretar.
 *
 * Sin el punto 2 esto seria una maquina de fabricar falsos hallazgos.
 */
const fs = require('fs');

// PRNG con semilla. El patron determinista que se uso antes en este proyecto
// (j*7919 + i*104729) % n producia SIEMPRE la misma remuestra: cero varianza.
let _s = 20260813;
const rnd = () => { _s = (1103515245 * _s + 12345) % 2147483648; return _s / 2147483648; };

const num = v => (v == null || Number.isNaN(v) ? 0 : v);

// ── Variables candidatas. Todas observables en el momento de decidir. ──
const VARS = {
  minuto:      d => d.min,
  restante:    d => (90 - d.min) / 90,
  golesYa:     d => d.gh + d.ga,
  difGoles:    d => Math.abs(d.gh - d.ga),
  empate:      d => (d.gh === d.ga ? 1 : 0),
  ligaRitmo:   d => num(d.liga) || 2.7,
  fuerza:      d => num(d.str) || 1,
  xg:          d => num(d.s.xgHome) + num(d.s.xgAway),
  xgPend:      d => (num(d.s.xgHome) + num(d.s.xgAway)) - (d.gh + d.ga),
  remates:     d => num(d.s.totalShotsHome) + num(d.s.totalShotsAway),
  aPuerta:     d => num(d.s.sotHome) + num(d.s.sotAway),
  ocasiones:   d => num(d.s.bigChancesHome) + num(d.s.bigChancesAway),
  corners:     d => num(d.s.cornersHome) + num(d.s.cornersAway),
  ataques:     d => num(d.s.attacksHome) + num(d.s.attacksAway),
  areaRem:     d => num(d.s.shotsInsideBoxHome) + num(d.s.shotsInsideBoxAway),
  rojas:       d => num(d.s.redCardsHome) + num(d.s.redCardsAway),
  ritmoRem:    d => (num(d.s.totalShotsHome) + num(d.s.totalShotsAway)) / Math.max(1, d.min),
  ritmoXg:     d => (num(d.s.xgHome) + num(d.s.xgAway)) / Math.max(1, d.min),
};

function auc(rows, score) {
  const p = rows.filter(r => r.y), n = rows.filter(r => !r.y);
  if (!p.length || !n.length) return 0.5;
  let s = 0;
  for (const a of p) for (const b of n) { const x = score(a), y2 = score(b); s += x > y2 ? 1 : x === y2 ? 0.5 : 0; }
  return s / (p.length * n.length);
}

/** Regresion logistica con descenso de gradiente y normalizacion z. */
function fit(train, keys) {
  const fs_ = keys.map(k => VARS[k]);
  const mu = fs_.map((f, i) => train.reduce((s, r) => s + f(r), 0) / train.length);
  const sd = fs_.map((f, i) => {
    const v = Math.sqrt(train.reduce((s, r) => s + Math.pow(f(r) - mu[i], 2), 0) / train.length);
    return v > 1e-9 ? v : 1;
  });
  const z = (r) => fs_.map((f, i) => (f(r) - mu[i]) / sd[i]);
  let w = new Array(keys.length).fill(0), b = 0;
  for (let it = 0; it < 900; it++) {
    const g = new Array(keys.length).fill(0); let gb = 0;
    for (const r of train) {
      const x = z(r);
      const p = 1 / (1 + Math.exp(-(x.reduce((s, xi, i) => s + w[i] * xi, 0) + b)));
      const e = p - r.y;
      for (let i = 0; i < keys.length; i++) g[i] += e * x[i];
      gb += e;
    }
    for (let i = 0; i < keys.length; i++) w[i] -= 0.25 * (g[i] / train.length + 0.02 * w[i]);
    b -= 0.25 * gb / train.length;
  }
  return (r) => { const x = z(r); return 1 / (1 + Math.exp(-(x.reduce((s, xi, i) => s + w[i] * xi, 0) + b))); };
}

function combinaciones(keys, k) {
  const out = [];
  const rec = (start, acc) => {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i < keys.length; i++) { acc.push(keys[i]); rec(i + 1, acc); acc.pop(); }
  };
  rec(0, []);
  return out;
}

(async () => {
  const P = JSON.parse(fs.readFileSync('predictions.json', 'utf8'));
  const D = P.filter(x => Array.isArray(x.goalMinutes) && x.timelineConsistent !== false &&
      x.stats && x.timestamp && x.analysisMinute >= 15 && x.analysisMinute <= 80)
    .map(x => ({
      ts: x.timestamp, min: x.analysisMinute,
      gh: (x.scoreAtAnalysis && x.scoreAtAnalysis.home) || 0,
      ga: (x.scoreAtAnalysis && x.scoreAtAnalysis.away) || 0,
      liga: x.leagueGoalsPerMatch, str: x.strength, s: x.stats,
      y: x.goalMinutes.some(v => v > x.analysisMinute && v <= x.analysisMinute + 15) ? 1 : 0,
    }));
  D.sort((a, b) => (a.ts < b.ts ? -1 : 1));

  const corte = Math.floor(D.length * 0.7);
  const train = D.slice(0, corte), test = D.slice(corte);
  console.log('OBJETIVO: gol en los proximos 15 minutos');
  console.log('  entrenamiento: ' + train.length + ' (hasta ' + train[train.length - 1].ts.slice(0, 10) + ')');
  console.log('  prueba       : ' + test.length + ' (desde ' + test[0].ts.slice(0, 10) + ')');
  console.log('  tasa base en prueba: ' + (test.filter(r => r.y).length / test.length * 100).toFixed(1) + '%');
  console.log('');

  const keys = Object.keys(VARS);
  const combos = [];
  for (const k of [1, 2, 3]) for (const c of combinaciones(keys, k)) combos.push(c);
  console.log('combinaciones a probar: ' + combos.length + ' (de 1, 2 y 3 variables sobre ' + keys.length + ')');

  const evaluar = (tr, te, etiqueta) => {
    const out = [];
    for (let i = 0; i < combos.length; i++) {
      out.push({ c: combos[i], a: auc(te, fit(tr, combos[i])) });
      if (i % 200 === 0) { console.log('  ' + etiqueta + ' ' + i + '/' + combos.length); }
    }
    return out.sort((x, y) => y.a - x.a);
  };

  const real = evaluar(train, test, 'real');

  // ── DISTRIBUCION NULA ──
  // Misma busqueda, mismo numero de combinaciones, etiquetas barajadas.
  // El mejor AUC de aqui es el liston que hay que superar.
  console.log('generando distribucion nula (misma busqueda sobre etiquetas barajadas)...');
  const mejoresNulos = [];
  for (let rep = 0; rep < 3; rep++) {
    const trB = train.map(r => ({ ...r })), teB = test.map(r => ({ ...r }));
    for (const arr of [trB, teB]) {
      const ys = arr.map(r => r.y);
      for (let i = ys.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ys[i], ys[j]] = [ys[j], ys[i]]; }
      arr.forEach((r, i) => { r.y = ys[i]; });
    }
    mejoresNulos.push(evaluar(trB, teB, 'nulo' + (rep + 1))[0].a);
  }
  const liston = Math.max(...mejoresNulos);

  console.log('');
  console.log('  LISTON DEL AZAR: el mejor de ' + combos.length + ' combinaciones sobre datos');
  console.log('  sin señal alcanza AUC ' + liston.toFixed(4) + ' (3 repeticiones: ' +
    mejoresNulos.map(v => v.toFixed(3)).join(', ') + ')');
  console.log('  Cualquier resultado por debajo de eso es indistinguible del azar.');
  console.log('');
  console.log('=== MEJORES COMBINACIONES (fuera de muestra) ===');
  console.log('   AUC     supera azar   variables');
  for (const r of real.slice(0, 15)) {
    console.log('  ' + r.a.toFixed(4) + '      ' + (r.a > liston ? '  SI ' : '  no ') + '        ' + r.c.join(' + '));
  }
  console.log('');
  console.log('=== REFERENCIAS ===');
  for (const c of [['minuto'], ['restante'], ['minuto', 'golesYa'], ['minuto', 'fuerza'], ['minuto', 'xgPend'], ['minuto', 'ritmoRem']]) {
    console.log('  ' + auc(test, fit(train, c)).toFixed(4) + '  ' + c.join(' + '));
  }
  const gan = real.filter(r => r.a > liston).length;
  console.log('');
  console.log('VEREDICTO: ' + gan + ' de ' + combos.length + ' combinaciones superan el liston del azar' +
    (gan === 0 ? ' — ninguna. No hay combinacion que aporte.' : ''));
})();
