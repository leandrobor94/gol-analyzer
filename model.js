/**
 * model.js — motor de probabilidad. Compartido por entrenamiento y produccion.
 *
 * Estructura: proceso de Poisson no homogeneo.
 *
 *   lambda = exp(b0 + b·x)          intensidad de gol por minuto
 *   P(gol antes del final) = 1 - exp(-lambda · T)     T = minutos utiles restantes
 *
 * El tiempo restante entra por la estructura del modelo, NO como un regresor mas.
 * Esa es la diferencia con el motor anterior, que multiplicaba factores de urgencia
 * a mano y terminaba subiendo el score justo cuando la tasa real de gol se desploma.
 *
 * Los coeficientes NO se escriben a mano: salen de train.js sobre datos verificados
 * y se guardan en model.json. Si model.json no existe, aqui no se inventa nada:
 * se devuelve un modelo nulo y el gate no alerta.
 */

const fs = require('fs');
const path = require('path');

const MODEL_FILE = path.join(__dirname, 'model.json');

/** Minutos utiles que quedan por jugar. Es el termino T del Poisson. */
function minsLeft(minute) {
  const m = minute || 0;
  if (m <= 45) return (45 - m) + 2 + 47;   // resto del 1T + descuento + 2T entero
  if (m >= 90) return Math.max(1, 98 - m); // descuento del 2T
  return (90 - m) + 3;
}

const num = (v) => (v == null || Number.isNaN(v) ? 0 : v);

/**
 * Features. Todas son TASAS normalizadas (por 90 min, divididas por un valor tipico)
 * para que los coeficientes sean comparables y la regularizacion L2 sea justa.
 *
 * Orden fijo: es el contrato con model.json. Añadir features al final y reentrenar.
 */
const FEATURES = [
  'xgRate', 'sotRate', 'bcRate', 'boxRate', 'shotRate', 'atkRate',
  'goalRate', 'gd1', 'gd2', 'nil', 'reds', 'late', 'early', 'leagueRate',
];

/**
 * @param {object} m  { minute, scoreHome, scoreAway, stats, leagueGoalsPerMatch }
 */
function extractFeatures(m) {
  const s = m.stats || {};
  const minute = Math.max(m.minute || 1, 1);
  const gh = m.scoreHome ?? 0;
  const ga = m.scoreAway ?? 0;
  const goals = gh + ga;
  const gd = Math.abs(gh - ga);
  const per90 = (total, typical) => (total / minute) * 90 / typical;

  return {
    xgRate:   per90(num(s.xgHome) + num(s.xgAway), 2.5),
    sotRate:  per90(num(s.sotHome) + num(s.sotAway), 8),
    bcRate:   per90(num(s.bigChancesHome) + num(s.bigChancesAway), 2.5),
    boxRate:  per90(num(s.shotsInsideBoxHome) + num(s.shotsInsideBoxAway), 12),
    shotRate: per90(num(s.totalShotsHome) + num(s.totalShotsAway), 24),
    atkRate:  per90(num(s.attacksHome) + num(s.attacksAway), 120),
    goalRate: per90(goals, 2.7),
    gd1:  gd === 1 ? 1 : 0,
    gd2:  gd >= 2 ? 1 : 0,
    nil:  goals === 0 ? 1 : 0,
    reds: Math.min(num(s.redCardsHome) + num(s.redCardsAway), 2) / 2,
    late:  (m.minute || 0) >= 75 ? 1 : 0,
    early: (m.minute || 0) < 30 ? 1 : 0,
    // Prior de la competicion. 2.6 goles/partido es la media global; si no
    // conocemos la liga el termino queda en 0 y no mueve nada.
    leagueRate: m.leagueGoalsPerMatch ? (m.leagueGoalsPerMatch / 2.6 - 1) : 0,
  };
}

// ─────────────────────────── calibracion (Platt) ───────────────────────────
//
// Se usa Platt y no isotonica a proposito. Con ~500 muestras la isotonica crea
// mesetas planas que empatan casos distintos y DESTRUYEN el orden — medido:
// AUC 0.731 -> 0.709. Platt es una transformacion monotona de 2 parametros:
// corrige el nivel sin tocar el ranking, y no se sobreajusta con pocos datos.

const EPS = 1e-6;
const logit = (p) => {
  const q = Math.min(Math.max(p, EPS), 1 - EPS);
  return Math.log(q / (1 - q));
};

/** Ajusta a·logit(p)+b por descenso de gradiente sobre log-loss. */
function fitPlatt(pairs, { lr = 0.08, iters = 5000 } = {}) {
  let a = 1, b = 0;
  if (pairs.length < 20) return { a, b };
  for (let it = 0; it < iters; it++) {
    let ga = 0, gb = 0;
    for (const [p0, y] of pairs) {
      const lp = logit(p0);
      const q = 1 / (1 + Math.exp(-(a * lp + b)));
      const e = q - y;
      ga += e * lp; gb += e;
    }
    a -= lr * ga / pairs.length;
    b -= lr * gb / pairs.length;
  }
  return { a: Math.round(a * 1e6) / 1e6, b: Math.round(b * 1e6) / 1e6 };
}

function applyPlatt(cal, p) {
  if (!cal || typeof cal.a !== 'number') return p;
  return 1 / (1 + Math.exp(-(cal.a * logit(p) + cal.b)));
}

// ─────────────────────────────── scoring ───────────────────────────────

/** Probabilidad cruda del Poisson, sin calibrar. */
function rawProb(model, features, T) {
  let z = model.b0;
  for (let i = 0; i < model.features.length; i++) {
    z += model.b[i] * num(features[model.features[i]]);
  }
  const lambda = Math.exp(Math.min(z, 2.5));
  return { p: 1 - Math.exp(-lambda * T), lambda };
}

/**
 * Puntua un partido en vivo.
 * @returns {{ probability:number, score:number, lambda:number, minsLeft:number,
 *             raw:number, prob15:number, score15:number, trained:boolean }}
 */
function score(model, m) {
  const T = minsLeft(m.minute);
  if (!model || !model.trained) {
    return { probability: 0, score: 0, lambda: 0, minsLeft: T, raw: 0, prob15: 0, score15: 0, trained: false };
  }
  const f = extractFeatures(m);
  const { p, lambda } = rawProb(model, f, T);
  const cal = applyPlatt(model.calibration, p);
  const p15 = 1 - Math.exp(-lambda * Math.min(15, T));
  return {
    probability: cal,
    score: Math.round(cal * 100),
    lambda,
    minsLeft: T,
    raw: p,
    prob15: p15,
    score15: Math.round(p15 * 100),
    trained: true,
  };
}

function loadModel() {
  try {
    if (fs.existsSync(MODEL_FILE)) {
      const m = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8').replace(/^﻿/, ''));
      if (Array.isArray(m.b) && Array.isArray(m.features) && m.b.length === m.features.length) {
        m.trained = true;
        return m;
      }
    }
  } catch {}
  // Sin modelo entrenado no se inventan pesos: el gate vera trained=false y no alertara.
  return { trained: false, features: FEATURES, b: [], b0: 0, calibration: null, gates: [] };
}

module.exports = {
  FEATURES, minsLeft, extractFeatures,
  fitPlatt, applyPlatt, logit, rawProb, score, loadModel,
  MODEL_FILE,
};
