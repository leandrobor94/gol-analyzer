const fs = require('fs');
const path = require('path');
const { runLearning, updateTeamStats, adjustWeights, loadTeams, saveTeams, getWindowWeights } = require('./learn');
const notify = require('./notify');
const scores365 = require('./scores365');
const { fetchStatsBatch, extractMatchMomentum } = require('./flashscore_fetcher');

const PREDICTIONS_FILE = path.join(__dirname, 'predictions.json');
const WEIGHTS_FILE = path.join(__dirname, 'weights.json');
const TEAMS_FILE = path.join(__dirname, 'teams.json');
const ALERTAS_LOG_FILE = path.join(__dirname, 'alertas_log.json');

const DEFAULT_WEIGHTS = {
  version: 1, learningRate: 0.05,
  global: {
    xg: 30, shotsOnTarget: 25, shotsInsideBox: 18, bigChances: 15, totalShots: 10,
    xgot: 12, hitWoodwork: 10, xA: 8, touchesOppBox: 8,
    scoreNeeds: 10, timePressure: 8, corners: 5, possession: 5, saves: 5, goalsScored: -10,
    teamFactor: 8, leagueFactor: 5
  },
  byLeague: {},
  stats: { predictionsCount: 0, correctScore: 0, correctScorer: 0, createdCount: 0, verifiedCount: 0 }
};

function deepMerge(defaults, loaded) {
  const result = { ...defaults };
  for (const key of Object.keys(loaded)) {
    if (typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key])) {
      result[key] = deepMerge(defaults[key], loaded[key]);
    } else if (loaded[key] !== undefined) {
      result[key] = loaded[key];
    }
  }
  return result;
}

function loadWeights() {
  try {
    if (fs.existsSync(WEIGHTS_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8'));
      const merged = deepMerge(DEFAULT_WEIGHTS, loaded);
      // Ensure all global keys exist
      for (const k of Object.keys(DEFAULT_WEIGHTS.global)) {
        if (merged.global[k] === undefined) merged.global[k] = DEFAULT_WEIGHTS.global[k];
      }
      return merged;
    }
  } catch {}
  return { ...DEFAULT_WEIGHTS, global: { ...DEFAULT_WEIGHTS.global } };
}
function saveWeights(w) { w.lastUpdated = new Date().toISOString(); fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(w, null, 2)); }
function loadPredictions() {
  try { if (fs.existsSync(PREDICTIONS_FILE)) return JSON.parse(fs.readFileSync(PREDICTIONS_FILE, 'utf8')); } catch {}
  return [];
}
function savePredictions(p) { fs.writeFileSync(PREDICTIONS_FILE, JSON.stringify(p, null, 2)); }
function getLeagueWeights(weights, league, windowType) {
  const base = windowType ? getWindowWeights(weights, windowType) : (weights.globalFallback || weights.global || {});
  const w = { ...base };
  if (league && weights.byLeague && weights.byLeague[league]) Object.keys(w).forEach(k => { if (weights.byLeague[league][k] !== undefined) w[k] = weights.byLeague[league][k]; });
  return w;
}

/** Ajustar pesos por tramo temporal — DEPRECATED, reemplazado por score state en analyzeGoal */

/** Window-specific estimated odds */
const WINDOW_ODDS = {
  firstHalf: 3.0,
  earlySecondHalf: 2.5,
  late: 3.5,
};

/** Determine window type from minute */
function getWindowType(minute) {
  if (minute <= 44) return 'firstHalf';
  if (minute <= 65) return 'earlySecondHalf';
  return 'late';
}

/** Get fallback score when stats are mostly null — basado en intensidad minima */
function getFallbackScore(minute, scoreHome, scoreAway, league, match) {
  let base = 20;
  const gd = Math.abs(scoreHome - scoreAway);
  
  if (minute <= 44) {
    base = 30;
    if (gd === 0 && minute >= 25) base += 10;
    if (gd <= 1 && minute >= 30) base += 5;
    if (match.stats?.possessionHome !== null && match.stats?.possessionAway !== null) {
      const diff = Math.abs(match.stats.possessionHome - match.stats.possessionAway);
      if (diff > 15) base += 10;
    }
    if (match.stats?.attacksHome !== null || match.stats?.attacksAway !== null) {
      const total = (match.stats.attacksHome||0) + (match.stats.attacksAway||0);
      if (total > 60) base += 10;
    }
    if (match.stats?.cornersHome !== null || match.stats?.cornersAway !== null) {
      const total = (match.stats.cornersHome||0) + (match.stats.cornersAway||0);
      if (total >= 4) base += 10;
    }
  } else if (minute <= 70) {
    base = 25;
    if (gd === 0) base += 10;
  }
  
  // Cap 70: sin stats reales NUNCA debe acercarse al umbral de alerta (80%)
  return Math.min(70, base);
}

/** Check if match has meaningful stats for scoring */
function hasMeaningfulStats(stats) {
  if (!stats) return false;
  const xgTotal = (stats.xgHome||0) + (stats.xgAway||0);
  const sotTotal = (stats.sotHome||0) + (stats.sotAway||0);
  const shotsBoxTotal = (stats.shotsInsideBoxHome||0) + (stats.shotsInsideBoxAway||0);
  const bigChancesTotal = (stats.bigChancesHome||0) + (stats.bigChancesAway||0);
  const atkTotal = (stats.attacksHome||0) + (stats.attacksAway||0);
  return (xgTotal > 0.3 || sotTotal >= 3 || shotsBoxTotal >= 3 || bigChancesTotal >= 1 || atkTotal >= 50);
}

function analyzeGoal(match, w, teams, leagueContext, windowType) {
  const s = match.stats;
  const minute = match.minute || 0;
  const goals = (match.scoreHome || 0) + (match.scoreAway || 0);
  const gd = Math.abs(match.scoreHome - match.scoreAway);
  const minsLeft = Math.max(1, 90 - minute);
  const reasons = [];
  const toRate = (v) => minute > 0 ? v / minute : 0;

  // ─── LAMBDA: intensidad de gol por minuto ───
  // Baseline calibrado: 0.030 goles/min (~2.7 por partido, ligeramente optimista)
  // Se ajusta por liga si hay datos
  let lambda = 0.030;
  if (leagueContext && leagueContext.goalsPerMatch) {
    const leagueAvg = leagueContext.goalsPerMatch;
    if (leagueAvg > 0) lambda = 0.030 * (leagueAvg / 2.7);
  }

  // 1. xG — EL predictor. Peso 1.5 sobre baseline
  const xgTotal = (s.xgHome || 0) + (s.xgAway || 0);
  const xgRate = toRate(xgTotal);
  const xgRemaining = xgTotal - goals;
  if (xgRate > 0.03) {
    lambda += (xgRate - 0.03) * 1.5;
  } else if (xgRate < 0.015) {
    lambda *= 0.7; // partido muerto ofensivamente
  }
  if (xgRemaining > 1.5) reasons.push('Alto xG restante (' + xgRemaining.toFixed(2) + ')');
  else if (xgRemaining > 0.8) reasons.push('xG restante ' + xgRemaining.toFixed(2));

  // 2. Big Chances — predictor #2. Umbral: al menos 1 BC en 50 min para activar
  const bcTotal = (s.bigChancesHome || 0) + (s.bigChancesAway || 0);
  const bcRate = toRate(bcTotal);
  if (bcRate > 0.02) lambda += bcRate * 2.0;

  // 3. SoT — señal débil porque xG ya lo cubre. Solo suma si hay volumen real
  const sotTotal = (s.sotHome || 0) + (s.sotAway || 0);
  const sotRate = toRate(sotTotal);
  if (sotRate > 0.04) lambda += (sotRate - 0.04) * 0.8;

  // 4. xGOT — calidad de tiro (complementa xG, no disponible en 365scores sin Flashscore)
  if (s.xgotHome !== null && s.xgotAway !== null) {
    const xgotRate = toRate(s.xgotHome + s.xgotAway);
    if (xgotRate > 0.015) lambda += xgotRate * 0.5;
  }

  // 5. Red cards — el multiplicador más fuerte en fútbol
  const reds = (s.redCardsHome || 0) + (s.redCardsAway || 0);
  if (reds > 0) {
    lambda *= (1 + reds * 1.5);
    reasons.push(reds + ' roja(s) — partido roto!');
  }

  // 6. SCORE STATE — urgencia real según marcador y minuto
  const homeTrails = match.scoreHome < match.scoreAway;
  const awayTrails = match.scoreAway < match.scoreHome;
  const trailing = homeTrails || awayTrails;
  
  if (trailing) {
    const urgency = minute >= 75 ? 1.50 : minute >= 60 ? 1.30 : minute >= 40 ? 1.15 : 1.05;
    lambda *= urgency;
    reasons.push((homeTrails ? 'Local' : 'Visitante') + ' necesita gol (\u00d7' + urgency.toFixed(1) + ')');
  }
  if (gd >= 2 && !trailing) {
    lambda *= 0.50;
    reasons.push('Ventaja c\u00f3moda');
  } else if (gd === 1 && !trailing && minute >= 75) {
    lambda *= 0.70;
    reasons.push('Cuidando resultado');
  }

  // 7. Goles acumulados — más goles = menos necesidad de otro
  if (goals >= 4) lambda *= 0.30;
  else if (goals >= 3 && minute >= 70) lambda *= 0.40;
  else if (goals >= 2 && minute >= 80) lambda *= 0.50;

  // 8. S\u00edndrome del 0-0: si llegamos a 80' sin goles, la presi\u00f3n sube
  if (goals === 0 && minute >= 80) lambda *= 1.15;
  if (goals === 0 && minute >= 70 && bcTotal === 0 && xgTotal < 1.0) lambda *= 0.70;

  // ─── PROBABILIDAD POISSON ───
  const prob = 1 - Math.exp(-lambda * minsLeft);
  let score = Math.round(Math.min(100, prob * 100));

  // ─── SCORER PREDICTION ───
  let predictedScorer = null;
  const scorerReasons = [];
  if (s.xgHome !== null && s.xgAway !== null) {
    if (s.xgHome > s.xgAway + 0.3) { predictedScorer = 'home'; scorerReasons.push('xG superior'); }
    else if (s.xgAway > s.xgHome + 0.3) { predictedScorer = 'away'; scorerReasons.push('xG superior'); }
  }
  if (!predictedScorer && homeTrails) { predictedScorer = 'home'; scorerReasons.push('necesita gol'); }
  if (!predictedScorer && awayTrails) { predictedScorer = 'away'; scorerReasons.push('necesita gol'); }

  // ─── TIME WINDOW ───
  let timeWindow = '';
  if (minute < 25) timeWindow = 'GOL 1T';
  else if (minute < 40) timeWindow = score >= 60 ? 'Gol antes del descanso!' : '1T';
  else if (minute < 50) timeWindow = score >= 60 ? 'Gol inicio 2T!' : 'Inicio 2T';
  else if (minute < 65) timeWindow = score >= 60 ? 'Gol 2T!' : '2T';
  else if (minute < 80) timeWindow = score >= 60 ? 'GOL inminente!' : 'Tramo final';
  else timeWindow = score >= 40 ? 'Descuento!' : 'Defini\u00e9ndose';

  const verdict = score >= 80 ? 'MUY PROBABLE \u2014 casi seguro proximo gol'
    : score >= 60 ? 'PROBABLE \u2014 buenos indicios'
    : score >= 40 ? 'POSIBLE \u2014 atentos'
    : score >= 20 ? 'DUDOSO \u2014 poca actividad'
    : 'IMPROBABLE \u2014 muy pocas ocasiones';

  let whoText = '';
  if (predictedScorer && scorerReasons.length > 0 && score >= 30) {
    whoText = '\n     Proximo gol: ' + (predictedScorer === 'home' ? (match.teamHome || 'Local') : (match.teamAway || 'Visitante')) + ' (' + scorerReasons.join(', ') + ')';
  } else if (predictedScorer && score >= 45) {
    whoText = '\n     Proximo gol: ' + (predictedScorer === 'home' ? (match.teamHome || 'Local') : (match.teamAway || 'Visitante'));
  }

  return {
    match: match.rawName, teamHome: match.teamHome, teamAway: match.teamAway,
    league: match.league, matchId: match.matchId,
    score, verdict, timeWindow, whoText, reasons,
    minute, scoreHome: match.scoreHome, scoreAway: match.scoreAway,
    predictedScorer: predictedScorer && score >= 25 ? predictedScorer : null,
    stats: s, pressure: Math.round(lambda * 100),
  };
}

function writeSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n'); } catch {}
  }
}

function logAlertVerification(pred, correct) {
  try {
    let log = [];
    if (fs.existsSync(ALERTAS_LOG_FILE)) {
      log = JSON.parse(fs.readFileSync(ALERTAS_LOG_FILE, 'utf8'));
    }
    log.push({
      match: pred.match || (pred.teamHome + ' vs ' + pred.teamAway),
      league: pred.league,
      probability: pred.predictedProbability,
      minute: pred.analysisMinute,
      scoreAtAlert: pred.scoreAtAnalysis ? (pred.scoreAtAnalysis.home + '-' + pred.scoreAtAnalysis.away) : null,
      finalScore: pred.finalScore ? (pred.finalScore.home + '-' + pred.finalScore.away) : null,
      goalAfterAlert: pred.goalAfterAnalysis,
      correct: correct,
      windowType: pred.windowType,
      timestamp: new Date().toISOString(),
      alertTimestamp: pred.timestamp
    });
    // Keep last 500 entries
    if (log.length > 500) log = log.slice(-500);
    fs.writeFileSync(ALERTAS_LOG_FILE, JSON.stringify(log, null, 2));
  } catch (e) {
    console.log('  (no se pudo guardar log de alerta: ' + (e.message || e) + ')');
  }
}

function alertsEnabled() {
  if (process.env.CI) {
    // Nube: consultar GitHub directo (evita checkout desactualizado)
    try {
      const raw = require('child_process').execSync('curl -s https://raw.githubusercontent.com/leandrobor94/gol-analyzer/main/alertas.json', { timeout: 5000, stdio: 'pipe' }).toString();
      const { enabled } = JSON.parse(raw);
      return enabled !== false;
    } catch {}
    return true;
  }
  // Local: archivo
  try {
    if (fs.existsSync('alertas.json')) {
      const { enabled } = JSON.parse(fs.readFileSync('alertas.json', 'utf8'));
      return enabled !== false;
    }
  } catch {}
  return true;
}

function doSync() {
  if (process.env.NO_SYNC) return;
  const cp = require('child_process');
  try {
    // pull --rebase para auto-resolver divergencias; si falla, abortar rebase
    // para no dejar el repo en estado roto (antes: pull --ff-only fallaba para siempre)
    try {
      cp.execSync('git pull --rebase', { stdio: 'ignore', timeout: 20000 });
    } catch {
      try { cp.execSync('git rebase --abort', { stdio: 'ignore', timeout: 5000 }); } catch {}
    }
  } catch {}
  try {
    cp.execSync('git config user.email "sofastats-bot@users.noreply.github.com"', { stdio: 'ignore', timeout: 5000 });
    cp.execSync('git config user.name "sofastats-bot"', { stdio: 'ignore', timeout: 5000 });
    // Solo agregar archivos que existen (antes: git add de archivo inexistente
    // lanzaba error y el sync completo fallaba silenciosamente en local)
    const files = ['predictions.json', 'weights.json', 'teams.json', 'alertas.json', 'alertas_log.json', 'telegram-offset.txt', 'last-local-run.json']
      .filter(f => fs.existsSync(f));
    if (files.length > 0) {
      cp.execSync('git add ' + files.join(' '), { stdio: 'ignore', timeout: 5000 });
    }
    // Solo commit y push si hay algo que commitear
    const hasChanges = cp.execSync('git status --porcelain', { encoding: 'utf8', timeout: 5000 }).trim();
    if (hasChanges) {
      cp.execSync('git commit -m "sync: datos ronda [skip ci]"', { stdio: 'ignore', timeout: 5000 });
      cp.execSync('git push', { stdio: 'ignore', timeout: 15000 });
      console.log('  Sync: commit + push exitoso');
    } else {
      console.log('  Sync: sin cambios nuevos');
    }
  } catch (e) {
    console.log('  Sync: ' + (e.message || 'error').split('\n')[0]);
  }
}

async function main() {

  // Si es nube y hubo ejecución local hace < 10 min, saltar
  if (process.env.CI) {
    try {
      if (fs.existsSync('last-local-run.json')) {
        const { lastRun } = JSON.parse(fs.readFileSync('last-local-run.json', 'utf8'));
        const minSince = (Date.now() - new Date(lastRun).getTime()) / 60000;
        if (minSince < 10) {
          console.log(`Ejecucion local hace ${Math.round(minSince)} min. Saltando ciclo en la nube.`);
          writeSummary('## Skip ' + new Date().toISOString() + ' - ejecucion local reciente');
          return;
        }
      }
    } catch {}
  }

  // Traer ultimos cambios de la nube
  try { require('child_process').execSync('git pull --ff-only', { stdio: 'ignore', timeout: 15000 }); } catch {}

  console.log('\n' + '='.repeat(64));
  console.log('  ANALISIS — ' + new Date().toISOString());
  console.log('='.repeat(64));

  // Validar horario Colombia (7am-10pm)
  const co = new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' });
  const coHour = new Date(co).getHours();
  if (coHour < 7 || coHour >= 22) {
    console.log('Fuera de horario Colombia (' + coHour + ':00).');
    writeSummary('## Skip ' + new Date().toISOString() + ' - fuera de horario (' + coHour + ':00 Colombia)');
    return;
  }

  // Flashscore enrichment solo cada 4 ciclos (cada ~20 min) — Playwright es caro
  // Cron */5 corre a :00 :05 :10 :15 :20... → :00, :20, :40 → minuto % 20 === 0
  const fsCycle = new Date().getUTCMinutes() % 20 === 0;

    let liveData = [];

    try {
    let weights = loadWeights();
    let predictions = loadPredictions();
    let teams = {};
    try { if (fs.existsSync(TEAMS_FILE)) teams = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8')); } catch {}
    const analyzed = [];

    console.log('[1/3] Obteniendo partidos en vivo desde 365scores...');
    liveData = await scores365.fetchLiveMatches();
    console.log('  -> ' + liveData.length + ' partidos en vivo\n');

    writeSummary('## Analisis 365scores ' + new Date().toISOString() + '\n- Partidos: ' + liveData.length);

    if (liveData.length > 0) {
      console.log('[2/3] Obteniendo stats y analizando ' + liveData.length + ' partidos...\n');

      for (let i = 0; i < liveData.length; i++) {
        const m = liveData[i];
        const displayName = m.homeTeam + ' vs ' + m.awayTeam;
        const league = m.league;
        console.log('  [' + (i + 1) + '/' + liveData.length + '] ' + displayName + (league ? ' (' + league + ')' : ''));

        // Fetch match stats from 365scores
        let rawStats;
        try {
          rawStats = await scores365.fetchMatchStats(m.gameId, m.homeId, m.awayId);
        } catch (e) {
          console.log('     -> Error al obtener stats: ' + (e.message || e) + '\n');
          continue;
        }
        let internalStats;
        let statsAvailable = false;
        if (rawStats) {
          internalStats = scores365.toInternalFormat(rawStats, m);
          statsAvailable = hasMeaningfulStats(internalStats);
        }
        if (!rawStats || !statsAvailable) {
          // NULL_STATS tiene TODAS las claves en null — evita que `undefined !== null`
          // pase como true en analyzeGoal (bug que dejaba entrar NaN a los calculos)
          internalStats = { ...scores365.NULL_STATS, ...(internalStats || {}) };
          console.log('     -> ' + m.minute + "' " + m.scoreHome + '-' + m.scoreAway + ' | Stats no disponibles, usando fallback');
        } else {
          const sotStr = internalStats.sotHome !== null ? internalStats.sotHome + '-' + internalStats.sotAway : '?-?';
          const boxStr = internalStats.shotsInsideBoxHome !== null ? 'Box:' + internalStats.shotsInsideBoxHome + '-' + internalStats.shotsInsideBoxAway : '';
          console.log('     -> ' + m.minute + "' " + m.scoreHome + '-' + m.scoreAway + ' | SOT:' + sotStr + (boxStr ? ' ' + boxStr : ''));
        }

        // Validar datos coherentes
        const totalGoals = (m.scoreHome ?? 0) + (m.scoreAway ?? 0);
        if (m.minute <= 10 && totalGoals >= 3) {
          console.log('  -> Score imposible: ' + m.scoreHome + '-' + m.scoreAway + ' en min ' + m.minute + ', saltando\n');
          continue;
        }
        if (m.minute <= 30 && totalGoals >= 6) {
          console.log('  -> Score imposible: ' + m.scoreHome + '-' + m.scoreAway + ' en min ' + m.minute + ', saltando\n');
          continue;
        }

        analyzed.push({
          rawName: displayName, teamHome: m.homeTeam, teamAway: m.awayTeam,
          league, matchId: String(m.gameId), minute: m.minute || 0,
          scoreHome: m.scoreHome ?? 0, scoreAway: m.scoreAway ?? 0,
          stats: internalStats,
          competitionId: m.competitionId
        });
      }

      // Flashscore: enriquecimiento solo en ciclos cada 20 min para ahorrar Playwright
      // (a) partidos sin stats de 365scores y (b) hasta 8 partidos en ventana de alerta
      const noStats = analyzed.filter(m => !hasMeaningfulStats(m.stats));
      const enrichable = analyzed.filter(m => hasMeaningfulStats(m.stats) && m.minute >= 25 && m.minute <= 70).slice(0, 8);
      const needFlashscore = fsCycle ? [...noStats, ...enrichable.filter(m => !noStats.includes(m))] : [];
      if (needFlashscore.length > 0) {
        console.log('\n  -> ' + needFlashscore.length + ' partidos a enriquecer en Flashscore (' + noStats.length + ' sin stats)...');
        const fsTargets = needFlashscore.map(m => ({ teamHome: m.teamHome, teamAway: m.teamAway, matchId: m.matchId, minute: m.minute }));
        try {
          const fsStats = await fetchStatsBatch(fsTargets);
          let merged = 0;
          for (const match of needFlashscore) {
            const key = match.matchId;
            const fs = fsStats[key];
            if (!fs || !fs.stats || Object.keys(fs.stats).length === 0) continue;
            const s = match.stats;
            // Map Flashscore stat names to internal format.
            // overwrite:true => el dato real de Flashscore REEMPLAZA el estimado de 365scores
            const fsm = {
              'Expected goals (xG)': { h: v => parseFloat(v), a: v => parseFloat(v), k: 'xg', overwrite: true },
              'Expected goals on target (xGOT)': { h: v => parseFloat(v), a: v => parseFloat(v), k: 'xgot', overwrite: true },
              'Expected assists (xA)': { h: v => parseFloat(v), a: v => parseFloat(v), kh: 'xgHomeA', ka: 'xgAwayA', overwrite: true },
              'Touches in opposition box': { h: parseInt, a: parseInt, k: 'touchesOppBox' },
              'Goalkeeper saves': { h: parseInt, a: parseInt, k: 'saves' },
              'Ball possession': { h: v => parseInt(v)/100, a: v => parseInt(v)/100, k: 'possession' },
              'Total shots': { h: parseInt, a: parseInt, k: 'totalShots' },
              'Shots on target': { h: parseInt, a: parseInt, k: 'shotsOnTarget' },
              'Big chances': { h: parseInt, a: parseInt, k: 'bigChances' },
              'Corner kicks': { h: parseInt, a: parseInt, k: 'corners' },
              'Fouls': { h: parseInt, a: parseInt, k: 'fouls' },
              'Yellow cards': { h: parseInt, a: parseInt, k: 'yellowCards' },
              'Red cards': { h: parseInt, a: parseInt, k: 'redCards' },
              'Shots off target': { h: parseInt, a: parseInt, k: 'shotsOffTarget' },
              'Shots inside box': { h: parseInt, a: parseInt, k: 'shotsInsideBox' },
              'Blocked shots': { h: parseInt, a: parseInt, k: 'blockedShots' },
              'Hit woodwork': { h: parseInt, a: parseInt, k: 'hitWoodwork' },
              'Saves': { h: parseInt, a: parseInt, k: 'saves' },
            };
            let anyNew = false;
            for (const [fsName, mapping] of Object.entries(fsm)) {
              if (fs.stats[fsName]) {
                const hVal = mapping.h(fs.stats[fsName].home);
                const aVal = mapping.a(fs.stats[fsName].away);
                if (isNaN(hVal) || isNaN(aVal)) continue;
                // Filtro de outliers: xG/xGOT/xA > 6 son datos corruptos
                if (/xG|xg|xA/.test(mapping.k || mapping.kh) && (hVal > 6 || aVal > 6)) continue;
                const kh = mapping.kh || (mapping.k + 'Home');
                const ka = mapping.ka || (mapping.k + 'Away');
                const existing = s[kh];
                if (mapping.overwrite || existing === null || existing === undefined) {
                  s[kh] = hVal;
                  s[ka] = aVal;
                  anyNew = true;
                }
              }
            }
            if (anyNew) {
              merged++;
              console.log('     -> Stats Flashscore mergeadas para ' + match.teamHome + ' vs ' + match.teamAway);
            }
          }
          console.log('  -> Flashscore: stats mergeadas para ' + merged + '/' + needFlashscore.length + ' partidos');
        } catch (e) {
          console.log('  -> Error Flashscore: ' + (e.message || e));
        }
      }

      // Fetch league context from 365scores
      const uniqueComps = [...new Set(analyzed.map(m => m.competitionId).filter(Boolean))];
      const leagueContextMap = {};
      for (const compId of uniqueComps) {
        try {
          const ctx = await scores365.fetchLeagueContext(compId);
          if (ctx) {
            const leagueName = analyzed.find(m => m.competitionId === compId)?.league || '';
            ctx.name = leagueName;
            leagueContextMap[compId] = ctx;
          }
        } catch (e) {
          console.log('     -> Error contexto liga ' + compId + ': ' + (e.message || e));
        }
      }
      if (Object.keys(leagueContextMap).length > 0) {
        console.log('  -> Contexto 365scores para ' + Object.keys(leagueContextMap).length + ' ligas');
      }

    const ranked = analyzed.map(m => {
      const compCtx = leagueContextMap[m.competitionId];
      const windowType = getWindowType(m.minute);
      const w = getLeagueWeights(weights, m.league, windowType);
      let result;

      if (hasMeaningfulStats(m.stats)) {
        result = analyzeGoal(m, w, teams, compCtx, windowType);
      } else {
        const fallbackScore = getFallbackScore(m.minute, m.scoreHome, m.scoreAway, m.league, m);
        result = {
          score: fallbackScore,
          timeWindow: windowType === 'firstHalf' ? 'Gol en 1T (fallback)' : windowType === 'earlySecondHalf' ? 'Gol 46-70 (fallback)' : 'Gol tarde (fallback)',
          verdict: fallbackScore >= 50 ? 'POSIBLE (stats insuficientes)' : 'DUDOSO (stats insuficientes)',
          whoText: '', reasons: ['Stats no disponibles, score basado en contexto'],
          teamHome: m.teamHome, teamAway: m.teamAway, league: m.league, matchId: m.matchId,
          minute: m.minute, scoreHome: m.scoreHome, scoreAway: m.scoreAway,
          stats: m.stats, predictedScorer: null, pressure: 0,
        };
      }

      // Save base score (pre-window) for training
      const baseScore = Math.min(100, Math.max(0, result.score));

      // Window classification (solo etiqueta, no modifica el score)
      if (windowType === 'firstHalf') {
        result.timeWindow = 'GOL 1T';
      } else if (windowType === 'earlySecondHalf') {
        result.timeWindow = 'GOL 46-70';
      } else {
        result.timeWindow = 'GOL TARDE';
      }

      result.score = baseScore;
      result.windowType = windowType;
      result.windowOdds = WINDOW_ODDS[windowType];
      result.ev = (baseScore / 100) * result.windowOdds - 1;
      result.competitionId = m.competitionId;

      return result;
    }).sort((a, b) => b.score - a.score);

    const now = new Date().toISOString();
    let newCount = 0;
    for (const r of ranked) {
      const existing = predictions.find(p => p.id === r.matchId && p.predictionCorrect === null);
      if (existing) {
        // Validar consistencia: el marcador no puede retroceder (goles no se borran)
        const prevGoals = (existing.lastSeenScore?.home || 0) + (existing.lastSeenScore?.away || 0);
        const newGoals = (r.scoreHome || 0) + (r.scoreAway || 0);
        const prevMin = existing.lastSeenMinute || 0;
        const newMin = r.minute || 0;
        // Si el minuto avanza pero el marcador retrocede, datos corruptos - no actualizar
        if (newMin > prevMin && newGoals < prevGoals) {
          console.log('  [SKIP] ' + r.match + ' - marcador inconsistente (prev=' + existing.lastSeenScore?.home + '-' + existing.lastSeenScore?.away + ' new=' + r.scoreHome + '-' + r.scoreAway + ')');
          continue;
        }
        // Si el minuto retrocede, datos stale - no actualizar
        if (newMin < prevMin - 2) {
          console.log('  [SKIP] ' + r.match + ' - minuto retrocede (prev=' + prevMin + ' new=' + newMin + ')');
          continue;
        }
        existing.lastSeenMinute = r.minute;
        existing.lastSeenScore = { home: r.scoreHome, away: r.scoreAway };
        const compScore = existing.predictedProbability;
        const diff = Math.abs(r.score - compScore);
        if (diff > 20 || (r.score >= 80) !== (compScore >= 80)) {
          existing.predictedProbability = r.score;
          existing.windowType = r.windowType;
          existing.predictedScorer = r.predictedScorer;
          existing.predictedTimeWindow = r.timeWindow;
          existing.stats = r.stats;
          existing.scoreAtAnalysis = { home: r.scoreHome, away: r.scoreAway };
          existing.analysisMinute = r.minute;
        }
      } else {
        // Solo guardar predicciones con potencial de alerta o stats completas
        const hasStats = r.stats && (hasMeaningfulStats(r.stats) || Object.keys(r.stats).filter(k => r.stats[k] !== null).length >= 15);
        const isAlertCandidate = r.score >= 60;
        if (hasStats || isAlertCandidate) {
          predictions.push({
            id: r.matchId, match: r.teamHome + ' vs ' + r.teamAway, league: r.league,
            teamHome: r.teamHome, teamAway: r.teamAway, timestamp: now,
            analysisMinute: r.minute, scoreAtAnalysis: { home: r.scoreHome, away: r.scoreAway }, stats: r.stats,
            predictedProbability: r.score, predictedScorer: r.predictedScorer, predictedTimeWindow: r.timeWindow,
            windowType: r.windowType, _lambda: r.pressure,
            finalScore: null, goalAfterAnalysis: null, actualGoalMinute: null, actualScorer: null, predictionCorrect: null,
            lastSeenMinute: r.minute, lastSeenScore: { home: r.scoreHome, away: r.scoreAway }
          });
          newCount++;
        }
      }
    }
    savePredictions(predictions);
    weights.stats.createdCount = (weights.stats.createdCount || 0) + newCount;
    saveWeights(weights);
    console.log('  -> ' + newCount + ' predicciones nuevas\n');

    // Actualizar lastSeen de predicciones existentes con datos actuales
    // BUG FIX: liveData tiene gameId (no url) — antes nunca encontraba el partido
    // y lastSeenMinute jamas se actualizaba
    for (const pred of predictions) {
      if (pred.predictionCorrect !== null) continue;
      const lm = liveData.find(m => String(m.gameId) === String(pred.id));
      if (lm) {
        pred.lastSeenMinute = lm.minute;
        pred.lastSeenScore = { home: lm.scoreHome ?? 0, away: lm.scoreAway ?? 0 };
      }
    }

    console.log('='.repeat(64));
    console.log('  PROXIMO GOL — ANALISIS EN VIVO (Flashscore)');
    console.log('='.repeat(64) + '\n');

    if (ranked.length > 0) {
      ranked.forEach((r, i) => {
        const medal = i === 0 ? '1.' : i === 1 ? '2.' : i === 2 ? '3.' : '  ' + (i + 1) + '.';
        const bar = '#'.repeat(Math.round(r.score / 5)) + '-'.repeat(20 - Math.round(r.score / 5));
        console.log('  ' + medal + ' [' + r.score + '%] ' + bar);
        console.log('     ' + r.teamHome + ' vs ' + r.teamAway + ' | ' + (r.minute ? r.minute + "'" : '') + ' ' + r.scoreHome + '-' + r.scoreAway);
        console.log('     ' + r.timeWindow);
        console.log('     ' + r.verdict + r.whoText);
        const xgS = r.stats.xgHome != null ? r.stats.xgHome.toFixed(2) + '-' + r.stats.xgAway.toFixed(2) : '?-?';
        const sotS = r.stats.sotHome != null ? r.stats.sotHome + '-' + r.stats.sotAway : '?-?';
        const bcS = r.stats.bigChancesHome != null ? r.stats.bigChancesHome + '-' + r.stats.bigChancesAway : '?-?';
        const boxS = r.stats.shotsInsideBoxHome != null ? r.stats.shotsInsideBoxHome + '-' + r.stats.shotsInsideBoxAway : '?-?';
        const woodS = r.stats.hitWoodworkHome != null ? r.stats.hitWoodworkHome + '-' + r.stats.hitWoodworkAway : '';
        const xgotS = r.stats.xgotHome != null ? r.stats.xgotHome.toFixed(2) + '-' + r.stats.xgotAway.toFixed(2) : '';
        const xaS = r.stats.xgHomeA != null ? 'xA:' + r.stats.xgHomeA.toFixed(2) + '-' + r.stats.xgAwayA.toFixed(2) : '';
        const touchesS = r.stats.touchesOppBoxHome != null ? 'Touches:' + r.stats.touchesOppBoxHome + '-' + r.stats.touchesOppBoxAway : '';
        const posS = r.stats.possessionHome != null ? Math.round(r.stats.possessionHome * 100) + '%-' + Math.round(r.stats.possessionAway * 100) + '%' : '?-?';
        console.log('     xG:' + xgS + ' SOT:' + sotS + ' OC:' + bcS + ' Box:' + boxS + (woodS ? ' Palo:' + woodS : '') + (xgotS ? ' xGOT:' + xgotS : '') + ' Pos:' + posS);
        if (xaS || touchesS) console.log('     ' + [xaS, touchesS].filter(Boolean).join(' '));
        if (r.reasons.length > 0) console.log('     ' + r.reasons.join(' | '));
      });

      const top = ranked[0];
      if (top.score >= 40) {
        console.log('\n  RECOMENDACION PRINCIPAL:');
        console.log('     ' + top.teamHome + ' vs ' + top.teamAway);
        console.log('     Confianza: ' + top.score + '% — ' + top.timeWindow);
        console.log('     ' + top.verdict);
        if (top.whoText) console.log('     ' + top.whoText.trim());
      } else {
        console.log('\n  Sin recomendaciones solidas ahora.');
      }
    }

    // --- Fetch real xG from Flashscore for top matches (solo ciclos cada 20 min) ---
    const topForXg = fsCycle ? ranked.filter(r => r.score >= 50 && r.stats.xgHome !== null && r.stats.xgAway !== null).slice(0, 5) : [];
    if (topForXg.length > 0) {
      console.log('\n--- Buscando xG real en Flashscore para ' + topForXg.length + ' partidos ---');
      const { fetchXgBatch } = require('./flashscore_fetcher');
      const targets = topForXg.map(r => ({ teamHome: r.teamHome, teamAway: r.teamAway }));
      let xgResults = {};
      let xgFound = 0;
      try {
        xgResults = await fetchXgBatch(targets);
      } catch (e) {
        console.log('  -> Error xG Flashscore: ' + (e.message || e));
      }
      for (const r of ranked) {
        const key = r.teamHome + ' vs ' + r.teamAway;
        const xg = xgResults[key];
        if (xg && xg.home !== null && xg.away !== null) {
          // Filter outliers: Flashscore a veces devuelve xG > 5.0 (datos corruptos)
          if (xg.home > 5.0 || xg.away > 5.0) {
            console.log('  * xG outlier ignorado: ' + r.teamHome + ' vs ' + r.teamAway + ' = ' + xg.home + '-' + xg.away);
            continue;
          }
          const prevXgH = r.stats.xgHome;
          const prevXgA = r.stats.xgAway;
          if (Math.abs(xg.home - prevXgH) > 0.1 || Math.abs(xg.away - prevXgA) > 0.1) {
            xgFound++;
            r.stats.xgHome = xg.home;
            r.stats.xgAway = xg.away;
            console.log('  * xG actualizado: ' + r.teamHome + ' vs ' + r.teamAway + ' | estimado: ' + prevXgH.toFixed(2) + '-' + prevXgA.toFixed(2) + ' -> real: ' + xg.home.toFixed(2) + '-' + xg.away.toFixed(2));
          }
        }
      }
      if (xgFound > 0) {
        // BUG FIX: el re-analisis pasaba leagueContext=null, perdiendo la normalizacion
        // por liga y haciendo el score inconsistente con el analisis original
        ranked.forEach(r => {
          const wt = getWindowType(r.minute);
          const updated = analyzeGoal(r, getLeagueWeights(weights, r.league, wt), teams, leagueContextMap[r.competitionId] || null, wt);
          r.score = updated.score; r.verdict = updated.verdict; r.timeWindow = updated.timeWindow; r.reasons = updated.reasons;
        });
        ranked.sort((a, b) => b.score - a.score);
      }
      console.log('  xG real obtenido para ' + xgFound + ' partidos\n');
    }

    // --- Telegram alert (probabilidad > 80%, top 5) - UMBRAL SUBIDO A 80% ---
    const topByScore = ranked.filter(r => r.score >= 80);
    if (topByScore.length > 0) {
      if (!process.env.CI) {
        // Local: no mandar Telegram, ya ves la terminal
      } else if (!alertsEnabled()) {
        console.log('\nAlertas desactivadas (alertas.json). Analisis sigue corriendo.');
        writeSummary('- Alerta: Desactivada por usuario');
      } else {
        // Dedup: deducir partidos ya alertados en misma ventana
        const filtered = [];
        for (const r of topByScore) {
          // Validacion de frescura: si el minuto del partido no avanzo en los ultimos 10 min, skip (datos stale)
          const predEntry = predictions.find(p => p.id === r.matchId);
          if (predEntry) {
            const realMinSinceAnalysis = (Date.now() - new Date(predEntry.timestamp).getTime()) / 60000;
            const minuteAdvance = (r.minute || 0) - (predEntry.analysisMinute || 0);
            // Si pasaron mas de 10 min reales y el minuto del partido no avanza, datos stale
            if (realMinSinceAnalysis > 10 && minuteAdvance < 2) {
              console.log('\n  [SKIP] ' + r.match + ' - datos stale (min=' + r.minute + ', sin avance en ' + realMinSinceAnalysis.toFixed(0) + ' min reales)');
              continue;
            }
          }
          const key = r.matchId + '_' + r.windowType;
          const lastAlert = weights.alertedMatches?.[key];
          let skip = false;
          if (lastAlert) {
            const realMin = (Date.now() - lastAlert.timestamp) / 60000;
            const gameMinAdvance = (r.minute || 0) - (lastAlert.minute || 0);
            // Dedup mas estricto: no reenviar si menos de 45 min reales O menos de 25 min de partido
            if (realMin < 45 && gameMinAdvance < 25) skip = true;
          }
          if (!skip) filtered.push(r);
          if (filtered.length >= 5) break;
        }

        if (filtered.length === 0) {
          console.log('\nAlertas: todos los partidos ya alertados (dedup)');
          writeSummary('- Alerta: Todos dedup');
        } else {
          const msg = notify.buildMessage(filtered);
          if (msg) {
            console.log('\nEnviando alerta Telegram con ' + filtered.length + ' partidos (prob>80%)...');
            await notify.sendTelegram(msg);
            weights.alertedMatches = weights.alertedMatches || {};
            for (const r of filtered) {
              const key = r.matchId + '_' + r.windowType;
              weights.alertedMatches[key] = { timestamp: Date.now(), minute: r.minute || 0 };
            }
            // Limpiar entradas viejas (> 2h)
            const cutoff = Date.now() - 2 * 60 * 60 * 1000;
            for (const [k, v] of Object.entries(weights.alertedMatches)) {
              if (v.timestamp < cutoff) delete weights.alertedMatches[k];
            }
            saveWeights(weights);
            writeSummary('- Alerta: ENVIADA (' + filtered.length + ' partidos)');
          }
        }
      }
    } else if (ranked.length > 0) {
      console.log('\nMejor probabilidad: ' + ranked[0].score + '% (umbral: 80%)');
      writeSummary('- Alerta: No enviada (mejor prob=' + ranked[0].score + '%)');
    }
  } else {
    console.log('  Sin partidos en vivo.');
  }

  // --- APRENDIZAJE: verificar predicciones anteriores contra datos actuales ---
  console.log('\n[3/3] Aprendiendo de predicciones anteriores...');
  let learningResult = { weights: null, adjustments: 0, insights: [] };
  try {
    learningResult = await runLearning(liveData);
  } catch (e) {
    console.log('  Error en aprendizaje: ' + (e.message || e));
  }
  weights = learningResult.weights || weights;
  if (learningResult.adjustments > 0) {
    console.log('  Pesos ajustados. Se usaran en el proximo analisis.');
  }
  writeSummary('- Aprendizaje: ' + learningResult.insights.length + ' fallos analizados');

  // --- VERIFICAR PARTIDOS TERMINADOS ---
  // Recargar predictions por si learn.js las modificó
  predictions = loadPredictions();
  const pendingVerify = predictions.filter(p => {
    if (p.predictionCorrect !== null) return false;
    // BUG FIX: excluir partidos AUN EN VIVO (antes usaba m.url que no existe)
    if (liveData.find(m => String(m.gameId) === String(p.id))) return false;
    if (p.analysisMinute && p.analysisMinute >= 10) return true;
    // Si analysisMinute < 10 pero pasaron > 30 min reales, verificar igual
    if (p.timestamp) {
      const elapsed = (Date.now() - new Date(p.timestamp).getTime()) / 60000;
      return elapsed >= 30;
    }
    return false;
  });
  if (pendingVerify.length > 0) {
    console.log('\n[4/4] Verificando ' + pendingVerify.length + ' partidos terminados (365scores)...');
    let verifiedCount = 0;
    const newlyVerified = [];
    const teamsData = loadTeams();
    const currentWeights = loadWeights();
    for (const pred of pendingVerify) {
      const gameId = parseInt(pred.id);
      if (isNaN(gameId)) {
        console.log('  ? ' + pred.match + ' | ID invalido: ' + pred.id);
        continue;
      }
      let score;
      try {
        score = await scores365.verifyFinishedMatch(gameId);
      } catch (e) {
        console.log('  ? ' + pred.match + ' | error al verificar: ' + (e.message || e));
        continue;
      }
      if (score) {
        const scoreChanged = score.home !== (pred.scoreAtAnalysis?.home ?? 0) || score.away !== (pred.scoreAtAnalysis?.away ?? 0);
        pred.finalScore = score;
        pred.goalAfterAnalysis = scoreChanged;
        // Determine who scored (actual scorer for training)
        if (scoreChanged) {
          const prevHome = pred.scoreAtAnalysis?.home ?? 0;
          const prevAway = pred.scoreAtAnalysis?.away ?? 0;
          if (score.home > prevHome && score.away > prevAway) {
            pred.actualScorer = null; // ambos
          } else if (score.home > prevHome) {
            pred.actualScorer = 'home';
          } else if (score.away > prevAway) {
            pred.actualScorer = 'away';
          } else {
            pred.actualScorer = null;
          }
          // Use lastSeenMinute as rough goal minute if available
          if (pred.lastSeenMinute && pred.lastSeenMinute > (pred.analysisMinute || 0)) {
            pred.actualGoalMinute = pred.lastSeenMinute;
          } else {
            pred.actualGoalMinute = null;
          }
        } else {
          pred.actualScorer = null;
          pred.actualGoalMinute = null;
        }
        const prob = (pred.predictedProbability || 0) / 100;
        const predictedGoal = prob >= 0.7;
        pred.predictionCorrect = (predictedGoal && scoreChanged) || (!predictedGoal && !scoreChanged);
        // Update stats counters (verifiedCount = verificadas, correctScore = acertadas)
        if (pred.predictionCorrect !== null) {
          currentWeights.stats.verifiedCount = (currentWeights.stats.verifiedCount || 0) + 1;
          if (pred.predictionCorrect) currentWeights.stats.correctScore = (currentWeights.stats.correctScore || 0) + 1;
        }
        const icon = pred.predictionCorrect ? '\u2713' : '\u2717';
        console.log('  ' + icon + ' ' + pred.match + ' | final ' + score.home + '-' + score.away + ' | pred=' + pred.predictedProbability + '%');
        // Log alerta verificada si fue alerta (>=80%)
        if ((pred.predictedProbability || 0) >= 80) {
          logAlertVerification(pred, pred.predictionCorrect);
        }
        // Analisis de fallos en predicciones >=70%
        if (!pred.predictionCorrect && pred.predictedProbability >= 70) {
          const dif = Math.abs((score.home - (pred.scoreAtAnalysis?.home ?? 0)) + (score.away - (pred.scoreAtAnalysis?.away ?? 0)));
          const min = pred.analysisMinute || 0;
          const estXg = (pred.stats?.xgHome ?? 0) + (pred.stats?.xgAway ?? 0);
          const sot = (pred.stats?.sotHome ?? 0) + (pred.stats?.sotAway ?? 0);
          const reasons = [];
          if (min >= 75 && score.home !== undefined && score.away !== undefined) {
            const gd = Math.abs(score.home - score.away);
            if (gd >= 3) reasons.push('goleada ' + score.home + '-' + score.away + ', ritmo bajo');
            if (score.home + score.away === 0 && estXg > 0) reasons.push('0-0 estancado pese a xG=' + estXg.toFixed(2));
          }
          if (estXg < 1) reasons.push('bajo xG=' + estXg.toFixed(2));
          if (sot === 0) reasons.push('sin tiros a puerta');
          if (reasons.length > 0) console.log('     fallo: ' + reasons.join(' | '));
        }
        verifiedCount++;
        newlyVerified.push(pred);
        if (teamsData) updateTeamStats(teamsData, pred, { scoreHome: score.home, scoreAway: score.away });
      } else {
        console.log('  ? ' + pred.match + ' | aun no finalizado o no encontrado en 365scores');
      }
    }
    if (verifiedCount > 0) {
      const adj = adjustWeights(currentWeights, newlyVerified, []);
      if (adj > 0) {
        saveWeights(currentWeights);
        if (teamsData) saveTeams(teamsData);
        console.log('  Pesos ajustados: ' + adj + ' cambios');
      }
      savePredictions(predictions);
    }
    console.log('  Verificados: ' + verifiedCount);
  }

  } catch (e) {
    console.log('\n!!! Error: ' + (e.message || e));
    writeSummary('- Error: ' + (e.message || e).substring(0, 200));
  }

  doSync();

  // Guardar timestamp local DESPUES del sync
  if (!process.env.CI && !module.parent) {
    fs.writeFileSync('last-local-run.json', JSON.stringify({ lastRun: new Date().toISOString() }));
  }
}

module.exports = { analyzeGoal, getLeagueWeights, getWindowType, hasMeaningfulStats };

if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err.message, '\n' + err.stack);
    process.exit(1);
  });
}
