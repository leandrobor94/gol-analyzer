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

/**
 * Fase del partido y horizonte de la apuesta.
 *
 * No se pregunta lo mismo en el minuto 20 que en el 80. Cada fase tiene su
 * horizonte natural, y de ahi sale una apuesta distinta:
 *
 *   1T      (min < 45)   ¿gol ANTES DEL DESCANSO?  -> quedan pocos minutos
 *   2T      (45-70)      ¿otro gol en lo que queda?
 *   FINAL   (> 70)       ¿gol en general?          -> horizonte corto por si solo
 *
 * Esto ademas arregla el problema del precio: en el 1T el horizonte es corto,
 * asi que la probabilidad cae sola al rango apostable (en el minuto 20 quedan
 * ~27 min de primera parte -> ~55%, cuota justa 1.8) en vez de dispararse al
 * 95% que ninguna casa paga.
 */
function phase(minute) {
  const m = minute || 0;
  if (m < 45) {
    return {
      key: '1T',
      T: Math.max(1, (45 - m) + 2),          // resto del 1T + descuento tipico
      options: ['ANY', 'TEAM'],              // gol de cualquiera o de uno concreto
    };
  }
  if (m <= 70) {
    return {
      key: '2T',
      T: Math.max(1, (90 - m) + 3),
      // SOLO equipo concreto. "Gol de cualquiera" aqui ronda el 65% y se paga
      // a 1.5: correcto pero sin premio. Estrechar a un equipo es lo que deja
      // la apuesta en un rango que compensa el riesgo.
      options: ['TEAM'],
    };
  }
  return {
    key: 'FINAL',
    T: m >= 90 ? Math.max(1, 98 - m) : Math.max(1, (90 - m) + 4),
    // Con poco tiempo por delante "gol en general" ya se paga bien. Se ofrecen
    // las dos y se elige aquella en la que estemos mas convencidos.
    options: ['ANY', 'TEAM'],
  };
}

/**
 * Reparto de la intensidad de gol entre los dos equipos.
 *
 * lambda es del partido; para apostar "marca el local" hace falta lambda_local.
 * Se reparte segun la produccion ofensiva de cada lado (remates a puerta, dentro
 * del area, xG y ataques), suavizado hacia 50/50 para no fiarlo todo a una
 * muestra corta de minutos.
 *
 * NOTA: este reparto todavia NO esta validado contra datos. verify.js ya guarda
 * el lado de cada gol (goalSides), asi que se podra medir en cuanto haya
 * suficientes partidos. Hasta entonces, tratarlo como una estimacion razonable
 * y no como un numero calibrado.
 */
function teamSplit(stats) {
  const s = stats || {};
  const n = (v) => (v == null || Number.isNaN(v) ? 0 : v);
  const peso = (sot, box, xg, atk) => n(sot) * 3 + n(box) * 1.5 + n(xg) * 8 + n(atk) * 0.05;
  const h = peso(s.sotHome, s.shotsInsideBoxHome, s.xgHome, s.attacksHome);
  const a = peso(s.sotAway, s.shotsInsideBoxAway, s.xgAway, s.attacksAway);
  const total = h + a;
  if (total <= 0) return { home: 0.5, away: 0.5, confident: false };
  // Suavizado: 60% de la evidencia + 40% de un reparto neutro.
  const raw = h / total;
  const share = 0.6 * raw + 0.4 * 0.5;
  return {
    home: Math.round(share * 1e4) / 1e4,
    away: Math.round((1 - share) * 1e4) / 1e4,
    confident: total >= 12,
  };
}

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

/**
 * P(caigan al menos `k` goles mas en T minutos), con intensidad lambda.
 *
 * El modelo ES un proceso de Poisson, asi que el numero de goles restantes
 * sigue Poisson(lambda*T). Hasta ahora solo se usaba el caso k=1 ("habra otro
 * gol"). Con k general se puede responder a la pregunta que hace el mercado:
 * "¿pasara el total de 2.5?" cuando ya hay 1 gol son k=2 goles mas.
 *
 * Esto es lo que permite comparar el modelo con la cuota Over/Under en sus
 * propios terminos, en vez de con una linea distinta.
 */
function probAtLeast(lambda, T, k) {
  if (k <= 0) return 1;
  const mu = Math.max(lambda, 0) * Math.max(T, 0);
  if (mu <= 0) return 0;
  // P(N >= k) = 1 - sum_{i=0}^{k-1} e^-mu mu^i / i!
  let term = Math.exp(-mu);
  let cum = term;
  for (let i = 1; i < k; i++) {
    term *= mu / i;
    cum += term;
  }
  return Math.min(1, Math.max(0, 1 - cum));
}

/**
 * Compara el modelo con una cuota de mercado Over/Under.
 *
 * @param {number} lambda   intensidad estimada (goles/min)
 * @param {number} T        minutos utiles restantes
 * @param {number} goalsNow goles ya marcados
 * @param {object} market   { line, over, under } cuotas decimales
 * @returns {object|null}   probabilidades, cuota justa y ventaja
 */
function marketEdge(lambda, T, goalsNow, market) {
  if (!market || !market.line || !market.over) return null;
  // Goles adicionales necesarios para superar la linea.
  const needed = Math.ceil(market.line - goalsNow + 1e-9);
  if (needed <= 0) return null;                 // ya esta superada: no hay apuesta
  const pOver = probAtLeast(lambda, T, needed);
  const pUnder = 1 - pOver;

  // Probabilidad implicita SIN el margen de la casa (se reparte proporcional).
  let impOver = 1 / market.over;
  if (market.under) {
    const s = impOver + 1 / market.under;
    if (s > 0) impOver = impOver / s;
  }
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  return {
    line: market.line,
    goalsNeeded: needed,
    pOver: r4(pOver),
    pUnder: r4(pUnder),
    fairOver: pOver > 0 ? Math.round((1 / pOver) * 100) / 100 : null,
    fairUnder: pUnder > 0 ? Math.round((1 / pUnder) * 100) / 100 : null,
    bookOver: market.over,
    bookUnder: market.under || null,
    impliedOver: r4(impOver),
    // Ventaja: cuanto mas probable lo cree el modelo de lo que lo paga la casa.
    edgeOver: r4(pOver - impOver),
    edgeUnder: r4(pUnder - (1 - impOver)),
    // Valor esperado por unidad apostada.
    evOver: r4(pOver * market.over - 1),
    evUnder: market.under ? r4(pUnder * market.under - 1) : null,
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
  probAtLeast, marketEdge, phase, teamSplit,
  MODEL_FILE,
};
