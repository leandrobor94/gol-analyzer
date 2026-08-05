/**
 * verify.js — cierra el ciclo: convierte predicciones pendientes en datos etiquetados.
 *
 * Reemplaza a learn.js. El motor viejo intentaba "aprender" en vivo ajustando
 * pesos en cada ronda; eso perseguia ruido y ademas estaba roto (ReferenceError
 * en learn.js:318 mataba la verificacion entera en cuanto una prediccion fallaba).
 *
 * Ahora la separacion es limpia:
 *   verify.js  (en la nube, cada ronda)  -> etiqueta datos
 *   train.js   (offline, bajo demanda)   -> aprende de datos etiquetados
 *
 * Se calculan DOS etiquetas por prediccion:
 *   goalAfterAnalysis  hubo gol entre el analisis y el final.  <- etiqueta historica
 *   goalWithin15       hubo gol en los 15 min siguientes.      <- la que sirve de verdad
 *
 * La segunda solo es posible desde que se capturan los minutos reales de gol
 * (scores365.fetchGameDetail). Antes se rellenaba con lastSeenMinute, que es el
 * ultimo minuto observado y no el minuto en que se marco.
 */

const fs = require('fs');
const path = require('path');
const scores365 = require('./scores365');

const ALERTAS_LOG_FILE = path.join(__dirname, 'alertas_log.json');
const HORIZON = 15;

function readJson(file, def) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {}
  return def;
}

/** Registra una alerta ya resuelta para poder medir precision real por tier. */
function logAlert(pred, detail) {
  try {
    let log = readJson(ALERTAS_LOG_FILE, []);
    if (!Array.isArray(log)) log = [];
    log.push({
      match: pred.match || (pred.teamHome + ' vs ' + pred.teamAway),
      league: pred.league,
      tier: pred.alertTier || null,
      probability: pred.alertProbability != null ? pred.alertProbability : pred.probability,
      minute: pred.alertMinute != null ? pred.alertMinute : pred.analysisMinute,
      scoreAtAlert: pred.scoreAtAnalysis ? (pred.scoreAtAnalysis.home + '-' + pred.scoreAtAnalysis.away) : null,
      finalScore: pred.finalScore ? (pred.finalScore.home + '-' + pred.finalScore.away) : null,
      goalAfterAlert: pred.goalAfterAnalysis,
      goalWithin15: pred.goalWithin15,
      // Decision de la IA guardada al alertar, para poder medir SU aporte por separado
      ai: pred.aiDecision || null,
      goalMinutes: (detail && detail.goals ? detail.goals.map(g => g.minute) : null),
      timestamp: new Date().toISOString(),
      alertTimestamp: pred.timestamp,
    });
    if (log.length > 1000) log = log.slice(-1000);
    fs.writeFileSync(ALERTAS_LOG_FILE, JSON.stringify(log, null, 2));
  } catch (e) {
    console.log('  (no se pudo guardar log de alerta: ' + (e.message || e) + ')');
  }
}

/**
 * Aplica las etiquetas a una prediccion usando el detalle del partido terminado.
 * @returns {boolean} true si quedo etiquetada
 */
function label(pred, detail) {
  if (!detail) return false;
  const analysisMin = pred.analysisMinute || 0;
  const before = (pred.scoreAtAnalysis?.home ?? 0) + (pred.scoreAtAnalysis?.away ?? 0);
  const final = (detail.home ?? 0) + (detail.away ?? 0);

  pred.finalScore = { home: detail.home, away: detail.away };
  pred.goalAfterAnalysis = final > before;

  const goals = Array.isArray(detail.goals) ? detail.goals : [];
  if (goals.length) {
    pred.goalMinutes = goals.map(g => g.minute);
    // El lado de cada gol permite validar el reparto por equipo (model.teamSplit),
    // que hoy es una estimacion sin calibrar.
    pred.goalSides = goals.map(g => g.side);
    const next = goals.find(g => g.minute > analysisMin);
    pred.nextGoalMinute = next ? next.minute : null;
    pred.goalWithin15 = !!next && (next.minute - analysisMin) <= HORIZON;
    // Con timeline real el marcador previo se puede reconstruir; si el numero de
    // goles posteriores no cuadra con el marcador, el timeline esta incompleto.
    const after = goals.filter(g => g.minute > analysisMin).length;
    pred.timelineConsistent = (final - before) === after;
  } else {
    // Sin timeline no se puede afirmar nada del horizonte corto. null != false.
    pred.goalMinutes = null;
    pred.nextGoalMinute = null;
    pred.goalWithin15 = null;
    pred.timelineConsistent = null;
  }

  // Quien marco (para el marcador previsto)
  if (pred.goalAfterAnalysis) {
    const ph = pred.scoreAtAnalysis?.home ?? 0;
    const pa = pred.scoreAtAnalysis?.away ?? 0;
    if (detail.home > ph && detail.away > pa) pred.actualScorer = null;
    else if (detail.home > ph) pred.actualScorer = 'home';
    else if (detail.away > pa) pred.actualScorer = 'away';
    else pred.actualScorer = null;
  } else {
    pred.actualScorer = null;
  }

  // predictionCorrect: acierto binario calibrado en 50%. Metrica general.
  const p = pred.probability != null ? pred.probability : (pred.predictedProbability || 0) / 100;
  pred.predictionCorrect = pred.goalAfterAnalysis ? (p >= 0.5) : (p < 0.5);

  // ── resolver la apuesta de fase ──
  // Cada fase apuesta a algo distinto, asi que cada una se resuelve distinto.
  if (pred.bet && pred.bet.phase) {
    const b = pred.bet;
    const desde = pred.alertMinute != null ? pred.alertMinute : (pred.analysisMinute || 0);
    const posteriores = goals.filter(g => g.minute > desde);
    let gano = null;
    if (b.phase === '1T') {
      // Gol antes del descanso: cuenta solo hasta el 45 (+descuento).
      gano = posteriores.some(g => g.minute <= 47);
    } else if (b.kind === 'TEAM') {
      gano = posteriores.some(g => g.side === b.side);
    } else {
      gano = posteriores.length > 0;
    }
    if (goals.length || pred.timelineConsistent !== false) {
      b.won = gano;
      b.profit = b.odds ? Math.round((gano ? b.odds - 1 : -1) * 1000) / 1000 : null;
    }
  }

  // alertCorrect solo tiene sentido si REALMENTE se alerto
  if (pred.alertTier) {
    pred.alertCorrect = pred.goalAfterAnalysis;
    pred.alertCorrect15 = pred.goalWithin15;
    logAlert(pred, detail);
  }
  return true;
}

/**
 * Verifica las predicciones pendientes cuyo partido ya no esta en vivo.
 * @param {Array} predictions
 * @param {Array} liveData  partidos actualmente en vivo
 */
async function verifyPending(predictions, liveData) {
  const liveIds = new Set((liveData || []).map(m => String(m.gameId)));
  const pending = predictions.filter(p => {
    if (p.predictionCorrect != null) return false;
    if (liveIds.has(String(p.id))) return false;          // aun en juego
    if ((p.analysisMinute || 0) >= 10) return true;
    if (p.timestamp) return (Date.now() - new Date(p.timestamp).getTime()) / 60000 >= 30;
    return false;
  });

  const result = { checked: pending.length, verified: 0, newlyVerified: [], withTimeline: 0 };
  for (const pred of pending) {
    const gameId = parseInt(pred.id, 10);
    if (Number.isNaN(gameId)) {
      console.log('  ? ' + pred.match + ' | id invalido: ' + pred.id);
      continue;
    }
    let detail;
    try {
      detail = await scores365.verifyFinishedMatch(gameId);
    } catch (e) {
      console.log('  ? ' + pred.match + ' | error al verificar: ' + (e.message || e));
      continue;
    }
    if (!detail) continue;                                 // aun no finalizado
    if (!label(pred, detail)) continue;

    result.verified++;
    result.newlyVerified.push(pred);
    if (pred.goalMinutes) result.withTimeline++;

    const icon = pred.predictionCorrect ? '✓' : '✗';
    const h15 = pred.goalWithin15 === true ? ' 15min:SI' : pred.goalWithin15 === false ? ' 15min:NO' : '';
    const tier = pred.alertTier ? ' [' + pred.alertTier + (pred.alertCorrect ? ' HIT' : ' MISS') + ']' : '';
    // Las predicciones del motor anterior guardan predictedProbability (0-100),
    // las del actual guardan probability (0-1). Mostrar la que exista.
    const shown = pred.probability != null ? pred.probability : (pred.predictedProbability || 0) / 100;
    console.log('  ' + icon + ' ' + pred.match + ' | final ' + detail.home + '-' + detail.away +
      ' | p=' + Math.round(shown * 100) + '%' + h15 + tier);
  }
  return result;
}

module.exports = { verifyPending, label, logAlert, HORIZON };
