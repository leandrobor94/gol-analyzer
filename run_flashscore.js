/**
 * run_flashscore.js — ciclo en vivo: analizar, alertar, etiquetar.
 *
 * Separacion de responsabilidades (antes todo vivia aqui, en 1100 lineas):
 *   model.js    probabilidad. Coeficientes de model.json, no escritos a mano.
 *   alert_gate.js  que se alerta. Umbrales de model.json, medidos fuera de muestra.
 *   verify.js   etiqueta predicciones con partidos terminados.
 *   train.js    aprende (offline, bajo demanda). NO se aprende en vivo.
 *
 * Por que no se aprende en vivo: el motor anterior ajustaba pesos cada ronda
 * con 1-5 partidos. Con esa muestra el gradiente es ruido, y el ruido quedaba
 * publicado en el repo. Ahora el modelo solo cambia cuando alguien corre
 * `npm run train`, que valida fuera de muestra antes de escribir nada.
 */

const fs = require('fs');
const path = require('path');
const scores365 = require('./scores365');
const M = require('./model');
const { alertQuality, classifyBet } = require('./alert_gate');
const verify = require('./verify');
const notify = require('./notify');
const aiFilter = require('./ai_filter');

const PREDICTIONS_FILE = path.join(__dirname, 'predictions.json');
const STATE_FILE = path.join(__dirname, 'state.json');
const SNAPSHOTS_FILE = path.join(__dirname, 'snapshots.jsonl');

// Flashscore (Playwright) es la parte cara del ciclo. Solo se usa para intentar
// conseguir xG REAL de los candidatos del tier VALOR, y como mucho cada 20 min.
// Sigue activo para poder medir algun dia si el xG real aporta: el xG estimado
// de 365scores, medido, no aporta nada (corr -0.04).
const FLASHSCORE_ENABLED = process.env.ENABLE_FLASHSCORE !== '0';
const FLASHSCORE_MAX = 5;

// ───────────────────────────── persistencia ─────────────────────────────

function readJson(file, def) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {}
  return def;
}

function loadPredictions() {
  const p = readJson(PREDICTIONS_FILE, []);
  return Array.isArray(p) ? p : [];
}

function savePredictions(preds) {
  // Las verificadas se conservan 90 dias: son el dataset de entrenamiento.
  // Las pendientes nunca se tiran.
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const kept = (preds || []).filter(p => {
    if (p.predictionCorrect == null) return true;
    if (!p.timestamp) return true;
    return new Date(p.timestamp).getTime() > cutoff;
  });
  fs.writeFileSync(PREDICTIONS_FILE, JSON.stringify(kept, null, 2));
  return kept;
}

/**
 * Guarda una foto del partido en CADA ronda, en un fichero append-only.
 *
 * predictions.json guarda una sola fila por partido (la ultima). Eso pierde la
 * trayectoria, que es justo donde podria vivir la señal que falta: no importa
 * tanto que un equipo lleve 8 remates como que lleve 5 en los ultimos 10 minutos.
 *
 * Con estas fotos, cada partido pasa a aportar ~10 filas en vez de 1, con minutos
 * repartidos por todo el encuentro, y se pueden calcular features de tendencia
 * (remates/ataques en la ultima ventana) que hoy son imposibles.
 *
 * JSONL append-only a proposito: escribir sin releer, y un diff por ronda que es
 * solo las lineas nuevas.
 */
function appendSnapshots(rows) {
  if (!rows.length) return;
  const ts = new Date().toISOString();
  const n = (v) => (v == null ? null : v);
  const lines = rows.map(a => JSON.stringify({
    id: a.matchId, ts, minute: a.minute,
    sh: a.scoreHome, sa: a.scoreAway,
    p: a.probability != null ? Math.round(a.probability * 1e4) / 1e4 : null,
    lg: a.leagueGoalsPerMatch ? Math.round(a.leagueGoalsPerMatch * 100) / 100 : null,
    s: {
      xg: n(a.stats.xgHome), xga: n(a.stats.xgAway), xgSrc: a.stats.xgSource || 'est',
      sot: n(a.stats.sotHome), sota: n(a.stats.sotAway),
      sh: n(a.stats.totalShotsHome), sha: n(a.stats.totalShotsAway),
      box: n(a.stats.shotsInsideBoxHome), boxa: n(a.stats.shotsInsideBoxAway),
      bc: n(a.stats.bigChancesHome), bca: n(a.stats.bigChancesAway),
      cor: n(a.stats.cornersHome), cora: n(a.stats.cornersAway),
      atk: n(a.stats.attacksHome), atka: n(a.stats.attacksAway),
      pos: n(a.stats.possessionHome),
      red: n(a.stats.redCardsHome), reda: n(a.stats.redCardsAway),
    },
  })).join('\n') + '\n';
  try {
    fs.appendFileSync(SNAPSHOTS_FILE, lines);
    // Tope de tamaño. A ~900 lineas/dia esto son mas de un año de historia; sin
    // el, el fichero crece sin limite y acabamos con el mismo problema de bloat
    // que tenia teams.json. Se comprueba por tamaño para no leerlo cada ronda.
    if (fs.statSync(SNAPSHOTS_FILE).size > 24 * 1024 * 1024) {
      const kept = fs.readFileSync(SNAPSHOTS_FILE, 'utf8').trim().split('\n').slice(-300000);
      fs.writeFileSync(SNAPSHOTS_FILE, kept.join('\n') + '\n');
      console.log('  (snapshots.jsonl recortado a las ultimas 300k lineas)');
    }
  } catch (e) {
    console.log('  (no se pudo guardar snapshots: ' + (e.message || e) + ')');
  }
}

const loadState = () => readJson(STATE_FILE, { alertedMatches: {}, counters: {} });
function saveState(s) {
  s.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function writeSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n'); } catch {}
  }
}

/** ¿Hay stats suficientes para que el modelo signifique algo? */
function hasMeaningfulStats(stats) {
  if (!stats) return false;
  const n = (v) => (v == null ? 0 : v);
  return (n(stats.xgHome) + n(stats.xgAway) > 0.3)
    || (n(stats.sotHome) + n(stats.sotAway) >= 3)
    || (n(stats.shotsInsideBoxHome) + n(stats.shotsInsideBoxAway) >= 3)
    || (n(stats.bigChancesHome) + n(stats.bigChancesAway) >= 1)
    || (n(stats.attacksHome) + n(stats.attacksAway) >= 50);
}

/** Congela la apuesta tal como se anuncio, para poder resolverla despues. */
function betOf(a) {
  const g = a.gate || {};
  if (!g.bet) return null;
  return {
    phase: g.phase, kind: g.kind, side: g.side, team: g.team,
    bet: g.bet, horizon: g.horizon,
    modelProb: g.p, fair: g.fair, target: g.target,
    odds: g.hasOdds ? g.odds : null,
    ev: g.hasOdds ? g.ev : null,
    bookmaker: g.bookmaker || null,
    minuteAtBet: a.minute,
    goalsAtBet: (a.scoreHome || 0) + (a.scoreAway || 0),
  };
}

function alertsEnabled() {
  const local = readJson(path.join(__dirname, 'alertas.json'), null);
  if (local && typeof local.enabled === 'boolean') return local.enabled;
  return true;
}

// ───────────────────────────── enriquecimiento ─────────────────────────────

async function enrichWithFlashscore(candidates) {
  if (!FLASHSCORE_ENABLED || !candidates.length) return 0;
  let fetcher;
  try { fetcher = require('./flashscore_fetcher'); } catch { return 0; }
  const targets = candidates.slice(0, FLASHSCORE_MAX).map(r => ({ teamHome: r.teamHome, teamAway: r.teamAway }));
  let updated = 0;
  try {
    const xg = await fetcher.fetchXgBatch(targets);
    for (const r of candidates) {
      const v = xg[r.teamHome + ' vs ' + r.teamAway];
      if (!v || v.home == null || v.away == null) continue;
      if (v.home > 6 || v.away > 6) continue;              // dato corrupto
      r.stats.xgHome = v.home;
      r.stats.xgAway = v.away;
      r.stats.xgSource = 'flashscore';
      updated++;
    }
  } catch (e) {
    console.log('  -> Flashscore no disponible: ' + (e.message || e));
  }
  return updated;
}

// ───────────────────────────────── main ─────────────────────────────────

async function main() {
  console.log('\n' + '='.repeat(66));
  console.log('  ANALISIS — ' + new Date().toISOString());
  console.log('='.repeat(66));

  const coHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' })).getHours();
  if ((coHour < 7 || coHour >= 22) && !process.env.FORCE_RUN) {
    console.log('Fuera de horario Colombia (' + coHour + ':00).');
    writeSummary('## Skip — fuera de horario (' + coHour + ':00 Colombia)');
    return;
  }

  const model = M.loadModel();
  if (!model.trained) {
    console.log('AVISO: no hay model.json entrenado. Se analiza y se guardan datos,');
    console.log('       pero NO se envian alertas. Corre: npm run train');
  } else {
    console.log('Modelo v' + model.version + ' (' + model.n + ' partidos, AUC ' + model.eval.auc + ')');
    for (const g of model.gates) {
      console.log('  gate ' + g.tier.padEnd(9) + ' min ' + g.minMinute + '-' + g.maxMinute +
        ' p>=' + g.threshold + '  precision medida ' + (g.measuredPrecision * 100).toFixed(1) +
        '% (n=' + g.n + ', IC ' + (g.ci95[0] * 100).toFixed(0) + '-' + (g.ci95[1] * 100).toFixed(0) + '%)');
    }
  }

  let predictions = loadPredictions();
  const state = loadState();
  let liveData = [];

  // ── 1. partidos en vivo ──
  console.log('\n[1/4] Partidos en vivo...');
  try {
    liveData = await scores365.fetchLiveMatches();
  } catch (e) {
    console.log('  Error al obtener partidos: ' + (e.message || e));
  }
  console.log('  -> ' + liveData.length + ' en vivo');
  writeSummary('## Analisis ' + new Date().toISOString() + '\n- Partidos: ' + liveData.length);

  const analyzed = [];
  if (liveData.length) {
    // ── 2. stats + contexto de liga ──
    console.log('\n[2/4] Stats y contexto...');
    const leagueCtx = {};
    for (const compId of [...new Set(liveData.map(m => m.competitionId).filter(Boolean))]) {
      try {
        const ctx = await scores365.fetchLeagueContext(compId);
        if (ctx && ctx.goalsPerMatch) leagueCtx[compId] = ctx.goalsPerMatch;
      } catch {}
    }
    console.log('  -> contexto de ' + Object.keys(leagueCtx).length + '/' +
      new Set(liveData.map(m => m.competitionId)).size + ' ligas');

    for (const m of liveData) {
      // Descartar marcadores imposibles (datos corruptos del feed)
      const goals = (m.scoreHome ?? 0) + (m.scoreAway ?? 0);
      if ((m.minute <= 10 && goals >= 3) || (m.minute <= 30 && goals >= 6)) {
        console.log('  [SKIP] ' + m.homeTeam + ' vs ' + m.awayTeam + ' — marcador imposible');
        continue;
      }
      let stats = null;
      try {
        const raw = await scores365.fetchMatchStats(m.gameId, m.homeId, m.awayId);
        if (raw) stats = scores365.toInternalFormat(raw, m);
      } catch {}
      if (!stats || !hasMeaningfulStats(stats)) {
        stats = Object.assign({}, scores365.NULL_STATS, stats || {});
      }
      analyzed.push({
        matchId: String(m.gameId),
        teamHome: m.homeTeam, teamAway: m.awayTeam,
        league: m.league, competitionId: m.competitionId,
        leagueGoalsPerMatch: leagueCtx[m.competitionId] || null,
        minute: m.minute || 0,
        scoreHome: m.scoreHome ?? 0, scoreAway: m.scoreAway ?? 0,
        stats,
        odds: m.odds || null,
      });
    }

    // ── 3. puntuar ──
    console.log('\n[3/4] Puntuando ' + analyzed.length + ' partidos...');
    const scoreAll = () => {
      for (const a of analyzed) Object.assign(a, M.score(model, a));
      analyzed.sort((x, y) => (y.probability || 0) - (x.probability || 0));
    };
    scoreAll();

    // xG real solo para los que rondan el tier VALOR, y como mucho cada 20 min
    if (new Date().getUTCMinutes() % 20 === 0 && model.trained) {
      const valor = model.gates.find(g => g.tier === 'VALOR');
      if (valor) {
        const near = analyzed.filter(a =>
          a.minute >= valor.minMinute && a.minute <= valor.maxMinute &&
          a.probability >= valor.threshold - 0.10 && hasMeaningfulStats(a.stats));
        if (near.length) {
          const n = await enrichWithFlashscore(near);
          if (n) { console.log('  -> xG real de Flashscore en ' + n + ' partidos, re-puntuando'); scoreAll(); }
        }
      }
    }

    for (const a of analyzed.slice(0, 12)) {
      const pct = Math.round((a.probability || 0) * 100);
      const bar = '#'.repeat(Math.round(pct / 5)) + '-'.repeat(20 - Math.round(pct / 5));
      const xg = a.stats.xgHome != null ? a.stats.xgHome.toFixed(2) + '-' + a.stats.xgAway.toFixed(2) : '?-?';
      console.log('  [' + String(pct).padStart(3) + '%] ' + bar + '  ' +
        a.teamHome + ' vs ' + a.teamAway + '  ' + a.minute + "' " + a.scoreHome + '-' + a.scoreAway +
        ' | xG ' + xg + (a.leagueGoalsPerMatch ? ' | liga ' + a.leagueGoalsPerMatch.toFixed(2) + ' g/p' : ''));
    }

    // Una foto por ronda de TODOS los partidos, alerten o no.
    appendSnapshots(analyzed);

    // ── 3b. apuesta por fase, con la cuota como extra opcional ──
    const MIN_ODDS = parseFloat(process.env.MIN_ODDS || '1.5');
    const MAX_ODDS = parseFloat(process.env.MAX_ODDS || '3.5');
    const MIN_EV = parseFloat(process.env.MIN_EV || '0.05');

    for (const a of analyzed) {
      const ph = M.phase(a.minute);
      a.phase = ph;
      a.split = M.teamSplit(a.stats);
      // Probabilidad de la apuesta ANY para esta fase (referencia para decidir
      // a quien vale la pena pedirle cuota).
      a.phaseP = a.lambda > 0 ? 1 - Math.exp(-a.lambda * ph.T) : 0;
    }

    // Solo se pide la cuota a los que ya caen en la banda apostable: cada
    // consulta es una llamada extra y no tiene sentido gastarla en descartados.
    const mktTargets = analyzed.filter(a => {
      if (!a.phaseP) return false;
      const fair = 1 / a.phaseP;
      return fair >= MIN_ODDS && fair <= MAX_ODDS && hasMeaningfulStats(a.stats);
    }).slice(0, 12);

    if (mktTargets.length && model.trained) {
      console.log('\n  Consultando cuota de goles en ' + mktTargets.length + ' candidatos...');
      let conCuota = 0;
      for (const a of mktTargets) {
        let mk = null;
        try { mk = await scores365.fetchGoalsMarket(a.matchId); } catch {}
        if (!mk) continue;
        conCuota++;
        a.goalsMarket = mk;
        const goles = (a.scoreHome || 0) + (a.scoreAway || 0);
        const me = M.marketEdge(a.lambda, a.minsLeft, goles, mk);
        // La cuota Over/Under es del TOTAL del partido; solo es comparable con
        // nuestra apuesta cuando ambas preguntan lo mismo: un gol mas hasta el
        // final. En el 1T preguntamos por el descanso, que es otra cosa.
        if (me) a.edge = { odds: me.bookOver, bookmaker: mk.bookmaker, line: me.line, goalsNeeded: me.goalsNeeded };
      }
      console.log('  -> cuota comparable en ' + conCuota + '/' + mktTargets.length);
    }

    // ── 4. gate + IA ──
    const candidates = [];
    const aiOn = aiFilter.isAvailable();
    for (const a of analyzed) {
      const g = classifyBet(
        { phase: a.phase, lambda: a.lambda, split: a.split, edge: a.edge,
          teamHome: a.teamHome, teamAway: a.teamAway,
          minute: a.minute, informed: hasMeaningfulStats(a.stats) },
        { minOdds: MIN_ODDS, maxOdds: MAX_ODDS, minEv: MIN_EV });
      a.gate = g;
      if (g.tier === 'REJECT') continue;
      if (g.requiresAi && aiOn) {
        const ai = await aiFilter.reviewAlert(a, g);
        a.aiDecision = ai.error ? null
          : { pass: !!ai.alert, confidence: ai.confidence || 0, reason: ai.reason || '', provider: ai.provider || null };
        console.log('  IA ' + (ai.provider || '?') + ': ' + a.teamHome + ' vs ' + a.teamAway +
          ' -> ' + (ai.error ? 'NO DISPONIBLE (pasa sin filtrar)' : (ai.alert ? 'PASA' : 'VETA')) +
          ' ' + (ai.reason || ''));
        if (!ai.alert) continue;
      }
      a.alertQuality = alertQuality(a);
      candidates.push(a);
    }
    candidates.sort((x, y) => (y.alertQuality || 0) - (x.alertQuality || 0));

    // Dedup: no repetir el mismo partido en el mismo tier
    const toSend = [];
    for (const c of candidates) {
      const key = c.matchId + '_' + c.gate.tier;
      const last = state.alertedMatches[key];
      if (last) {
        const realMin = (Date.now() - last.timestamp) / 60000;
        const gameAdvance = (c.minute || 0) - (last.minute || 0);
        if (realMin < 45 && gameAdvance < 25) continue;
      }
      toSend.push(c);
      if (toSend.length >= 5) break;
    }

    if (!candidates.length) {
      const best = analyzed[0];
      if (best) console.log('\nSin alerta. Mejor: ' + Math.round(best.probability * 100) + '% — ' + best.gate.reason);
      writeSummary('- Alerta: no (' + (best ? best.gate.reason : 'sin partidos') + ')');
    } else if (!toSend.length) {
      console.log('\nTodos los candidatos ya alertados (dedup)');
      writeSummary('- Alerta: dedup');
    } else if (!alertsEnabled()) {
      console.log('\nAlertas desactivadas por el usuario (alertas.json)');
      writeSummary('- Alerta: desactivada');
    } else if (!process.env.CI) {
      console.log('\nCandidatos (local, no se envia Telegram): ' + toSend.length);
      // Mostrar la probabilidad DE LA APUESTA, no la del partido entero: son
      // cosas distintas y confundirlas es lo que hacia parecer util un 95%.
      toSend.forEach(c => {
        const g = c.gate;
        console.log('  [' + g.phase + '] ' + (c.teamHome + ' vs ' + c.teamAway).slice(0, 34).padEnd(34) +
          ' ' + c.minute + "'  " + g.bet.slice(0, 30).padEnd(30) +
          ' p=' + Math.round(g.p * 100) + '%  justa ' + g.fair +
          (g.hasOdds ? '  casa ' + g.odds + ' EV ' + (g.ev >= 0 ? '+' : '') + (g.ev * 100).toFixed(0) + '%'
                     : '  desde ' + g.target));
      });
    } else {
      const msg = notify.buildMessage(toSend, model);
      if (msg && await notify.sendTelegram(msg)) {
        for (const c of toSend) {
          state.alertedMatches[c.matchId + '_' + c.gate.tier] = { timestamp: Date.now(), minute: c.minute || 0, tier: c.gate.tier };
          c.alerted = true;
        }
        writeSummary('- Alerta ENVIADA: ' + toSend.map(c => c.gate.tier).join(','));
      }
    }
    // Limpiar dedup viejo
    const cutoff = Date.now() - 3 * 60 * 60 * 1000;
    for (const [k, v] of Object.entries(state.alertedMatches)) {
      if (!v || v.timestamp < cutoff) delete state.alertedMatches[k];
    }

    // ── persistir predicciones ──
    const now = new Date().toISOString();
    let created = 0;
    for (const a of analyzed) {
      const existing = predictions.find(p => String(p.id) === a.matchId && p.predictionCorrect == null);
      const snapshot = {
        probability: a.probability, probability15: a.prob15,
        analysisMinute: a.minute,
        scoreAtAnalysis: { home: a.scoreHome, away: a.scoreAway },
        stats: a.stats,
        leagueGoalsPerMatch: a.leagueGoalsPerMatch,
        odds: a.odds,
        lambda: a.lambda,
        lastAnalyzedAt: now,
      };
      if (existing) {
        // El minuto nunca retrocede: si lo hace, el feed va stale
        if ((a.minute || 0) < (existing.analysisMinute || 0) - 2) continue;
        Object.assign(existing, snapshot);
        if (a.alerted && !existing.alertTier) {
          existing.alertTier = a.gate.tier;
          existing.alertProbability = a.probability;
          existing.alertMinute = a.minute;
          existing.aiDecision = a.aiDecision || null;
          // La apuesta concreta, congelada al alertar. Sin esto no se puede
          // calcular el ROI real despues: hace falta la cuota QUE HABIA.
          existing.bet = betOf(a);
        }
      } else {
        predictions.push(Object.assign({
          id: a.matchId,
          match: a.teamHome + ' vs ' + a.teamAway,
          teamHome: a.teamHome, teamAway: a.teamAway,
          league: a.league, competitionId: a.competitionId,
          timestamp: now,
          alertTier: a.alerted ? a.gate.tier : null,
          alertProbability: a.alerted ? a.probability : null,
          alertMinute: a.alerted ? a.minute : null,
          aiDecision: a.aiDecision || null,
          bet: a.alerted ? betOf(a) : null,
          finalScore: null, goalAfterAnalysis: null, goalWithin15: null,
          goalMinutes: null, nextGoalMinute: null,
          predictionCorrect: null, alertCorrect: null,
        }, snapshot));
        created++;
      }
    }
    console.log('\n  -> ' + created + ' predicciones nuevas, ' + (analyzed.length - created) + ' actualizadas');
  } else {
    console.log('  Sin partidos en vivo.');
  }

  // ── verificar terminados ──
  console.log('\n[4/4] Verificando partidos terminados...');
  let res = { checked: 0, verified: 0, withTimeline: 0 };
  try {
    res = await verify.verifyPending(predictions, liveData);
  } catch (e) {
    console.log('  Error al verificar: ' + (e.message || e) + '\n' + (e.stack || ''));
  }
  console.log('  Revisados ' + res.checked + ', etiquetados ' + res.verified +
    ' (' + res.withTimeline + ' con minuto real de gol)');

  predictions = savePredictions(predictions);

  const done = predictions.filter(p => p.predictionCorrect != null);
  const with15 = done.filter(p => p.goalWithin15 != null);
  state.counters = {
    total: predictions.length,
    verified: done.length,
    withGoalTimeline: with15.length,
    modelVersion: model.trained ? model.version : null,
  };
  saveState(state);

  console.log('\n  Dataset: ' + done.length + ' etiquetadas | ' + with15.length +
    ' con horizonte de 15 min' + (with15.length < 150 ? ' (hacen falta ~150 para entrenar ese modelo)' : ' — LISTO para entrenar el modelo de 15 min'));
  writeSummary('- Dataset: ' + done.length + ' etiquetadas, ' + with15.length + ' con timeline');
}

module.exports = { hasMeaningfulStats };

if (require.main === module) {
  main().catch(err => {
    console.error('Error fatal:', err.message, '\n' + err.stack);
    process.exit(1);
  });
}
