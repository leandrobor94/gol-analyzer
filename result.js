/**
 * result.js — modelo 1X2 en vivo: quien gana el partido.
 *
 * EL HALLAZGO MAS IMPORTANTE DEL PROYECTO, y llego el ultimo.
 *
 * Toda la auditoria pregunto "habra gol" y las estadisticas callaban: aporte
 * 0.000 de AUC sobre el reloj. Nunca se les pregunto "quien gana". Y ahi si
 * hablan:
 *
 *   AUC para "gana el local"
 *     marcador actual        0.844
 *     xG relativo            0.634
 *     remates a puerta rel   0.625
 *     posesion               0.616
 *     ataques relativos      0.582
 *
 *   Ablacion fuera de muestra (n=271):
 *     solo marcador + minuto   AUC 0.821
 *     + estadisticas           AUC 0.851
 *     aporte de las stats      +0.030   <- positivo por primera vez
 *
 * VALIDACION (5 cortes temporales, n=575):
 *
 *   gana local      AUC 0.870   Brier 0.1416   skill +42.6%
 *   gana visitante  AUC 0.854   Brier 0.1385   skill +37.3%
 *   empate          AUC 0.515                  skill  -0.7%   <- impredecible
 *
 *   Precision por conviccion (gana local, fuera de muestra):
 *     p>=0.70   n=78   92.3%   IC[84-96%]
 *     p>=0.80   n=45   93.3%   IC[82-98%]
 *     p>=0.90   n=30   93.3%   IC[79-98%]
 *
 * Es el unico >90% del proyecto con señal real y no con el reloj. Y el 1X2 es
 * el mercado mas profundo que existe, publicado por 365scores para TODOS los
 * partidos (ya se captura en scores365.extractOdds).
 *
 * LO QUE FALTA, Y ES LO QUE DECIDE SI ESTO ES UN PRODUCTO:
 *
 * No esta medido si le ganamos AL MERCADO EN VIVO. Buena parte del AUC 0.870
 * viene del marcador actual (0.844 el solo), y la casa tambien conoce el
 * marcador. Nuestra ventaja real es el +0.030 que aportan las estadisticas, y
 * eso es modesto.
 *
 * Las cuotas de partidos terminados SI se pueden recuperar (verificado, 6/6)
 * pero son PRE-PARTIDO: compararnos contra ellas seria hacer trampa, porque
 * nosotros conocemos el marcador y ellas no. La comparacion honesta necesita
 * cuotas EN VIVO del minuto del analisis, que solo se pueden capturar hacia
 * delante — y ya se estan capturando.
 *
 * Hasta que esa medicion exista, este modelo es una prediccion buena, no una
 * ventaja demostrada.
 */

const fs = require('fs');
const path = require('path');

const MODEL_FILE = path.join(__dirname, 'result_model.json');
const num = (v) => (v == null || Number.isNaN(v) ? 0 : v);

/** Mismo orden que en el entrenamiento. Contrato con result_model.json. */
function features(m) {
  const s = m.stats || {};
  const minuto = Math.max(m.minute || 1, 1);
  const gh = m.scoreHome || 0, ga = m.scoreAway || 0;
  const atkH = num(s.attacksHome), atkA = num(s.attacksAway), tot = atkH + atkA;
  const minRest = (92 - minuto) / 92;
  return [
    (gh - ga) / 2,
    minRest,
    (gh - ga) / 2 * minRest,
    (num(s.sotHome) - num(s.sotAway)) / minuto * 92 / 8,
    (num(s.shotsInsideBoxHome) - num(s.shotsInsideBoxAway)) / minuto * 92 / 12,
    (num(s.xgHome) - num(s.xgAway)) / minuto * 92 / 2,
    (tot > 0 ? (atkH - atkA) / tot : 0) * 2,
    ((s.possessionHome != null ? s.possessionHome : 0.5) - 0.5) * 4,
    num(s.redCardsAway) - num(s.redCardsHome),
    1,
  ];
}

function loadModel() {
  try {
    const m = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8').replace(/^﻿/, ''));
    if (Array.isArray(m.wHome) && m.wHome.length === 10) { m.trained = true; return m; }
  } catch {}
  return { trained: false };
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/**
 * @returns {{pHome:number,pAway:number,pDraw:number}|null}
 */
function predict(model, m) {
  if (!model || !model.trained) return null;
  if ((m.minute || 0) < 25 || (m.minute || 0) > 85) return null;
  const f = features(m);
  const z = (w) => w.reduce((s, wi, i) => s + wi * f[i], 0);
  const pH = sigmoid(z(model.wHome));
  const pA = sigmoid(z(model.wAway));
  // Los dos modelos son independientes: se normalizan para que sumen <= 1 y el
  // resto sea el empate. El empate NO se modela (AUC 0.515: no se puede).
  const suma = pH + pA;
  const esc = suma > 0.98 ? 0.98 / suma : 1;
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  return { pHome: r4(pH * esc), pAway: r4(pA * esc), pDraw: r4(1 - (pH + pA) * esc) };
}

/**
 * Decide si hay aviso. `odds` es opcional: si esta, se calcula EV.
 * Umbrales medidos: p>=0.70 -> 92.3% (n=78); p>=0.80 -> 93.3% (n=45).
 */
function classify(pred, opts) {
  const minProb = (opts && opts.minProb) || 0.70;
  const odds = (opts && opts.odds) || null;
  if (!pred) return { tier: 'REJECT', reason: 'fuera de ventana 25-85 o sin modelo' };

  const lados = [
    { lado: 'HOME', p: pred.pHome, cuota: odds && odds.home },
    { lado: 'AWAY', p: pred.pAway, cuota: odds && odds.away },
  ].sort((a, b) => b.p - a.p);
  const mejor = lados[0];

  if (mejor.p < minProb) {
    return { tier: 'REJECT', reason: 'conviccion ' + Math.round(mejor.p * 100) + '% < ' + Math.round(minProb * 100) + '%' };
  }
  const out = {
    tier: 'RESULTADO',
    lado: mejor.lado,
    p: mejor.p,
    fair: Math.round((1 / mejor.p) * 100) / 100,
    aciertoEsperado: mejor.p >= 0.80 ? 0.933 : 0.923,
    reason: 'conviccion ' + Math.round(mejor.p * 100) + '%',
  };
  if (mejor.cuota) {
    out.odds = mejor.cuota;
    out.ev = Math.round((mejor.p * mejor.cuota - 1) * 1e4) / 1e4;
    out.implicita = Math.round((1 / mejor.cuota) * 1e4) / 1e4;
  }
  return out;
}

module.exports = { loadModel, predict, classify, features, MODEL_FILE };
