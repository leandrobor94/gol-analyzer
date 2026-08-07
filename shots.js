/**
 * shots.js — prediccion del TOTAL DE REMATES del partido.
 *
 * POR QUE EXISTE ESTO, que es lo importante:
 *
 * Toda la auditoria del proyecto concluyo que las estadisticas en vivo no
 * predicen los goles (aporte 0.000 de AUC sobre el reloj, n=245 fuera de
 * muestra). Buscando por que, se descompuso el partido por tipo de evento
 * comparando el ritmo hasta el minuto X con lo que pasa despues (n=259):
 *
 *   remates   corr  0.607   <- señal fuerte
 *   tarjetas  corr  0.162
 *   goles     corr  0.130
 *   corners   corr -0.030
 *
 * Es decir: el TEMPO del partido es estable y predecible. Lo aleatorio es que
 * el remate entre. Durante toda la auditoria estuvimos midiendo la capa
 * aleatoria (goles) y concluyendo "no hay señal" — la señal esta en la capa de
 * debajo.
 *
 * VALIDACION (5 cortes temporales, ajuste solo en train, n_test=178):
 *
 *   media global (no mira el partido)   MAE 6.02
 *   proyeccion del ritmo (trivial)      MAE 5.01
 *   este modelo                         MAE 4.02
 *
 * Bate al baseline trivial por ~1 remate. Esa comparacion es obligatoria: sin
 * ella, "predecir remates" es solo repetir el ritmo actual con otro nombre.
 *
 * ADVERTENCIA HONESTA SOBRE EL 90.7%:
 * En simulacion, apostando solo cuando el modelo se aleja >=5 remates de la
 * linea, acierta el 90.7% (n=75, IC 82-95%). PERO la "linea" de esa simulacion
 * es la media global redondeada, que es un proxy naive de lo que pondria una
 * casa de apuestas. Una casa real pone una linea mas afilada, con modelos
 * pre-partido. Contra una linea real la ventaja seria MENOR — cuanto, no se
 * sabe, porque 365scores no publica cuotas de remates.
 *
 * Es decir: el modelo tiene señal demostrada, pero el margen contra el mercado
 * REAL sigue sin medir.
 */

const fs = require('fs');
const path = require('path');

const MODEL_FILE = path.join(__dirname, 'shots_model.json');
const num = (v) => (v == null || Number.isNaN(v) ? 0 : v);

/** Mismo orden que en el entrenamiento. Es el contrato con shots_model.json. */
function features(m) {
  const s = m.stats || {};
  const minuto = Math.max(m.minute || 1, 1);
  const ahora = num(s.totalShotsHome) + num(s.totalShotsAway);
  return [
    (ahora / minuto) * 92,                                              // proyeccion trivial
    Math.max(1, 92 - minuto) / 92,
    (num(s.sotHome) + num(s.sotAway)) / minuto * 92 / 8,
    (num(s.cornersHome) + num(s.cornersAway)) / minuto * 92 / 10,
    ((m.scoreHome || 0) + (m.scoreAway || 0)) / 3,
    (num(s.attacksHome) + num(s.attacksAway)) / minuto * 92 / 120,
    1,
  ];
}

function loadModel() {
  try {
    const m = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8').replace(/^﻿/, ''));
    if (Array.isArray(m.w) && m.w.length === 7 && m.sigma > 0) {
      m.trained = true;
      return m;
    }
  } catch {}
  return { trained: false };
}

/**
 * @returns {{ total:number, ahora:number, restantes:number, sigma:number }|null}
 */
function predict(model, m) {
  if (!model || !model.trained) return null;
  const s = m.stats || {};
  const ahora = num(s.totalShotsHome) + num(s.totalShotsAway);
  // Sin remates todavia no hay ritmo que proyectar: el modelo no aplica.
  if (ahora < 3 || (m.minute || 0) < 20) return null;
  const f = features(m);
  let total = 0;
  for (let i = 0; i < f.length; i++) total += model.w[i] * f[i];
  // El total nunca puede ser menor que los remates que ya hay.
  total = Math.max(total, ahora);
  return {
    total: Math.round(total * 10) / 10,
    ahora,
    restantes: Math.round((total - ahora) * 10) / 10,
    sigma: model.sigma,
  };
}

/**
 * Decide si hay apuesta sobre una linea Over/Under de remates.
 *
 * `margen` es la distancia minima entre nuestra prediccion y la linea. Medido:
 * con margen 3 el acierto simulado es 87.1%; con 5, 90.7%. Cuanto mayor el
 * margen, menos apuestas y mas acierto.
 *
 * @param {number} linea   la linea de la casa (ej. 22.5)
 * @param {number} margen  remates de distancia exigidos
 */
function classify(pred, linea, margen) {
  if (!pred || !(linea > 0)) return { tier: 'REJECT', reason: 'sin prediccion o sin linea' };
  const M = margen || 4;
  const dist = pred.total - linea;
  if (Math.abs(dist) < M) {
    return {
      tier: 'REJECT',
      reason: 'a ' + Math.abs(dist).toFixed(1) + ' remates de la linea, hace falta ' + M,
      total: pred.total, linea,
    };
  }
  // Acierto medido en simulacion segun el margen alcanzado.
  const acierto = Math.abs(dist) >= 5 ? 0.907 : Math.abs(dist) >= 4 ? 0.890 : Math.abs(dist) >= 3 ? 0.871 : 0.855;
  return {
    tier: 'REMATES',
    lado: dist > 0 ? 'OVER' : 'UNDER',
    bet: (dist > 0 ? 'Más de ' : 'Menos de ') + linea + ' remates',
    total: pred.total,
    ahora: pred.ahora,
    linea,
    distancia: Math.round(Math.abs(dist) * 10) / 10,
    aciertoEsperado: acierto,
    reason: 'prediccion ' + pred.total + ' vs linea ' + linea,
  };
}

module.exports = { loadModel, predict, classify, features, MODEL_FILE };
