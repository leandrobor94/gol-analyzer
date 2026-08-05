/**
 * alert_gate.js — decide que se alerta.
 *
 * Aqui NO hay umbrales escritos a mano. Las reglas salen de model.json, que las
 * deriva train.js midiendo precision fuera de muestra sobre datos verificados.
 * Cambiar el criterio de alerta = reentrenar, no editar este archivo.
 *
 * Dos tiers, con proposito distinto y medido por separado:
 *
 *   PRECISION  ventana temprana. Alta precision medida (>=90%). Responde
 *              "este partido tendra gol", no "viene un gol ya".
 *   VALOR      ventana media/tardia. Precision estructuralmente menor, pero es
 *              la ventana donde una cuota en vivo todavia paga. Pasa por IA.
 */

const num = (v) => (v == null || Number.isNaN(v) ? 0 : v);

function xgRemaining(stats, scoreHome, scoreAway) {
  const xg = num(stats && stats.xgHome) + num(stats && stats.xgAway);
  return xg - (num(scoreHome) + num(scoreAway));
}

function bigChances(stats) {
  return num(stats && stats.bigChancesHome) + num(stats && stats.bigChancesAway);
}

/**
 * Calidad 0-100. Solo ordena candidatos dentro de un mismo tier cuando hay que
 * recortar a los N mejores. No decide si se alerta — eso lo hace el tier.
 */
function alertQuality(r) {
  const p = r.probability != null ? r.probability : (r.score || 0) / 100;
  let q = 0;
  q += Math.max(0, Math.min(50, (p - 0.5) * 125));
  q += Math.max(0, Math.min(20, xgRemaining(r.stats, r.scoreHome, r.scoreAway) * 10));
  q += Math.max(0, Math.min(15, bigChances(r.stats) * 4));
  q += Math.max(0, Math.min(15, (r.prob15 || 0) * 40));
  return Math.round(q);
}

/**
 * @param {object} r      resultado de model.score() mezclado con datos del partido
 * @param {function} hasMeaningfulStats
 * @param {object} model  model.json cargado
 */
function classifyAlert(r, hasMeaningfulStats, model) {
  const minute = r.minute || 0;
  const p = r.probability != null ? r.probability : (r.score || 0) / 100;
  const base = {
    probability: Math.round(p * 1000) / 1000,
    minute,
    xgRemaining: Math.round(xgRemaining(r.stats, r.scoreHome, r.scoreAway) * 100) / 100,
    gd: Math.abs(num(r.scoreHome) - num(r.scoreAway)),
    quality: alertQuality(r),
  };

  if (!model || !model.trained || !Array.isArray(model.gates) || !model.gates.length) {
    return Object.assign({ tier: 'REJECT', reason: 'sin modelo entrenado (corre: npm run train)' }, base);
  }
  if (!hasMeaningfulStats(r.stats)) {
    return Object.assign({ tier: 'REJECT', reason: 'sin stats fiables' }, base);
  }

  // Los gates vienen en orden de prioridad: PRECISION primero.
  for (const g of model.gates) {
    if (minute < g.minMinute || minute > g.maxMinute) continue;
    if (p < g.threshold) continue;
    return Object.assign({
      tier: g.tier,
      reason: 'min ' + g.minMinute + '-' + g.maxMinute + ', p>=' + g.threshold,
      gate: g,
      requiresAi: !!g.requiresAi,
      expectedPrecision: g.measuredPrecision,
      ci95: g.ci95,
    }, base);
  }

  const why = model.gates.map(function (g) {
    return (minute >= g.minMinute && minute <= g.maxMinute)
      ? g.tier + ': falta p>=' + g.threshold + ' (tiene ' + p.toFixed(2) + ')'
      : g.tier + ': fuera de ventana ' + g.minMinute + '-' + g.maxMinute;
  }).join(' | ');
  return Object.assign({ tier: 'REJECT', reason: why }, base);
}

/**
 * Gate de VALOR: decide con valor esperado, no con precision.
 *
 * El criterio anterior premiaba la certeza, y la certeza se paga a 1.05. Un
 * aviso al 95% con cuota 1.05 arriesga 100 para ganar 5: no es un producto.
 *
 * Aqui manda NUESTRO analisis. La cuota no sustituye a nuestra probabilidad:
 * solo dice a cuanto nos pagan por ella.
 *
 *   EV = p_nuestra x cuota - 1
 *
 * Con p=55% y cuota 3.00 el EV es +65%, aunque la casa crea que es un 33%.
 * Ese desacuerdo es exactamente lo que se busca: si el mercado y nosotros
 * pensaramos igual, no habria nada que apostar.
 *
 * @param {object} edge   salida de model.marketEdge()
 * @param {object} opts   { minOdds, minEv }
 */
function classifyValue(edge, opts) {
  const minOdds = (opts && opts.minOdds) || 1.5;
  const minEv = (opts && opts.minEv) || 0.05;
  if (!edge) return { tier: 'REJECT', reason: 'sin mercado de goles' };

  const sides = [
    { side: 'OVER', pick: 'Más de ' + edge.line, p: edge.pOver, odds: edge.bookOver, ev: edge.evOver, edge: edge.edgeOver, fair: edge.fairOver },
    { side: 'UNDER', pick: 'Menos de ' + edge.line, p: edge.pUnder, odds: edge.bookUnder, ev: edge.evUnder, edge: edge.edgeUnder, fair: edge.fairUnder },
  ].filter(s => s.odds && s.ev != null);

  if (!sides.length) return { tier: 'REJECT', reason: 'sin cuotas utilizables' };

  const best = sides.sort((a, b) => b.ev - a.ev)[0];

  if (best.odds < minOdds) {
    return { tier: 'REJECT', reason: 'cuota ' + best.odds + ' < ' + minOdds + ' (riesgo/premio absurdo)', best };
  }
  if (best.ev < minEv) {
    return { tier: 'REJECT', reason: 'EV ' + (best.ev * 100).toFixed(1) + '% < ' + (minEv * 100).toFixed(0) + '%', best };
  }
  return {
    tier: 'VALOR',
    reason: 'EV +' + (best.ev * 100).toFixed(1) + '% a cuota ' + best.odds,
    best,
    line: edge.line,
    goalsNeeded: edge.goalsNeeded,
    requiresAi: true,
  };
}

module.exports = { xgRemaining, bigChances, alertQuality, classifyAlert, classifyValue };
