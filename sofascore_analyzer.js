const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const notify = require('./notify');

const PREDICTIONS_FILE = path.join(__dirname, 'predictions.json');
const WEIGHTS_FILE = path.join(__dirname, 'weights.json');

// ─── Pesos por defecto ───
const DEFAULT_WEIGHTS = {
  version: 1,
  learningRate: 0.05,
  global: {
    xg: 30,
    shotsOnTarget: 25,
    bigChances: 15,
    totalShots: 10,
    scoreNeeds: 10,
    timePressure: 8,
    corners: 5,
    possession: 5,
    saves: 5,
    goalsScored: -10
  },
  byLeague: {},
  stats: { predictionsCount: 0, correctScore: 0, correctScorer: 0 }
};

function loadWeights() {
  try {
    if (fs.existsSync(WEIGHTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8'));
      return { ...DEFAULT_WEIGHTS, ...data };
    }
  } catch {}
  return { ...DEFAULT_WEIGHTS };
}

function saveWeights(weights) {
  weights.lastUpdated = new Date().toISOString();
  fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(weights, null, 2));
}

function loadPredictions() {
  try {
    if (fs.existsSync(PREDICTIONS_FILE)) {
      return JSON.parse(fs.readFileSync(PREDICTIONS_FILE, 'utf8'));
    }
  } catch {}
  return [];
}

function savePredictions(predictions) {
  fs.writeFileSync(PREDICTIONS_FILE, JSON.stringify(predictions, null, 2));
}

function getLeagueWeights(weights, league) {
  const w = { ...weights.global };
  if (league && weights.byLeague[league]) {
    for (const key of Object.keys(w)) {
      if (weights.byLeague[league][key] !== undefined) {
        w[key] = weights.byLeague[league][key];
      }
    }
  }
  return w;
}

// ─── Motor de análisis con pesos dinámicos ───
function analyzeGoal(match, w) {
  let score = 0;
  let reasons = [];
  let predictedScorer = null;
  let scorerReasons = [];

  const s = match.stats;
  const goals = (match.scoreHome || 0) + (match.scoreAway || 0);
  const minute = match.minute || 0;
  const homeNeeds = match.scoreHome < match.scoreAway;
  const awayNeeds = match.scoreAway < match.scoreHome;
  const draw = match.scoreHome === match.scoreAway;
  let pressure = 0;

  const wXG = w.xg;
  const wSOT = w.shotsOnTarget;
  const wShots = w.totalShots;
  const wBC = w.bigChances;
  const wNeed = w.scoreNeeds;
  const wTime = w.timePressure;
  const wCorners = w.corners;
  const wPoss = w.possession;
  const wSaves = w.saves;
  const wGoalsPenalty = w.goalsScored;

  // === 1. xG ===
  if (s.xgHome !== null && s.xgAway !== null) {
    const totalXG = s.xgHome + s.xgAway;
    const xgRemaining = totalXG - goals;
    if (xgRemaining > 1.5) { score += wXG * 1; pressure += 30; reasons.push(`Alto xG restante (${xgRemaining.toFixed(2)})`); }
    else if (xgRemaining > 0.8) { score += wXG * 0.75; pressure += 20; reasons.push(`xG restante ${xgRemaining.toFixed(2)}`); }
    else if (xgRemaining > 0.3) { score += wXG * 0.4; pressure += 10; }
    if (totalXG > 1.5 && goals === 0) { score += wXG * 0.5; pressure += 15; reasons.push('0-0 con alto xG!'); }
    if (totalXG > 1.0 && goals <= 1) { score += wXG * 0.25; }

    if (s.xgHome > s.xgAway + 0.5) { predictedScorer = 'home'; scorerReasons.push('xG superior'); }
    else if (s.xgAway > s.xgHome + 0.5) { predictedScorer = 'away'; scorerReasons.push('xG superior'); }
  }

  // === 2. Tiros a puerta ===
  if (s.sotHome !== null && s.sotAway !== null) {
    const totalSOT = s.sotHome + s.sotAway;
    if (totalSOT >= 8) { score += wSOT * 1; pressure += 20; reasons.push(`${totalSOT} tiros a puerta!`); }
    else if (totalSOT >= 5) { score += wSOT * 0.7; pressure += 15; reasons.push(`${totalSOT} a puerta`); }
    else if (totalSOT >= 3) { score += wSOT * 0.4; pressure += 8; }
    if (totalSOT >= 4 && goals === 0) { score += wSOT * 0.6; pressure += 10; reasons.push('Tiran a puerta pero no entran'); }
    if (totalSOT >= 6 && goals <= 1) { score += wSOT * 0.4; }

    if (!predictedScorer) {
      if (s.sotHome >= s.sotAway + 3) { predictedScorer = 'home'; scorerReasons.push('domina tiros a puerta'); }
      else if (s.sotAway >= s.sotHome + 3) { predictedScorer = 'away'; scorerReasons.push('domina tiros a puerta'); }
    }
  }

  // === 3. Tiros totales ===
  if (s.totalShotsHome !== null && s.totalShotsAway !== null) {
    const totalShots = s.totalShotsHome + s.totalShotsAway;
    if (totalShots >= 25) { score += wShots * 1; pressure += 10; reasons.push(`Alta frecuencia de ataque (${totalShots})`); }
    else if (totalShots >= 15) { score += wShots * 0.5; pressure += 5; }
    if (!predictedScorer) {
      if (s.totalShotsHome >= s.totalShotsAway + 8) { predictedScorer = 'home'; scorerReasons.push('domina tiros'); }
      else if (s.totalShotsAway >= s.totalShotsHome + 8) { predictedScorer = 'away'; scorerReasons.push('domina tiros'); }
    }
  }

  // === 4. Ocasiones claras ===
  if (s.bigChancesHome !== null && s.bigChancesAway !== null) {
    const totalBC = s.bigChancesHome + s.bigChancesAway;
    if (totalBC >= 5) { score += wBC * 1; pressure += 15; reasons.push(`${totalBC} ocasiones claras!`); }
    else if (totalBC >= 2) { score += wBC * 0.5; pressure += 8; }
    if (!predictedScorer) {
      if (s.bigChancesHome > s.bigChancesAway) { predictedScorer = 'home'; scorerReasons.push('más ocasiones claras'); }
      else if (s.bigChancesAway > s.bigChancesHome) { predictedScorer = 'away'; scorerReasons.push('más ocasiones claras'); }
    }
  }

  // === 5. Necesidad del marcador ===
  if (draw && goals > 0) { score += wNeed * 0.5; reasons.push('Empate, ambos buscan el gol'); }
  if (draw && goals === 0) { score += wNeed * 0.8; pressure += 5; reasons.push('0-0, cualquiera lo rompe'); }
  if (homeNeeds) { score += wNeed * 0.8; pressure += 5; reasons.push('Local necesita el gol'); if (!predictedScorer) { predictedScorer = 'home'; scorerReasons.push('necesita el gol'); } }
  if (awayNeeds) { score += wNeed * 0.8; pressure += 5; reasons.push('Visitante necesita el gol'); if (!predictedScorer) { predictedScorer = 'away'; scorerReasons.push('necesita el gol'); } }
  if (goals >= 4) { score += wGoalsPenalty; reasons.push('Goleada, el ritmo baja'); }

  // === 6. Tiempo + presión ===
  if (minute >= 80 && pressure >= 20) { score += wTime * 1; reasons.push(`Min ${minute}' — presión final!`); }
  else if (minute >= 70 && pressure >= 25) { score += wTime * 0.8; reasons.push(`Min ${minute}' — definición`); }
  else if (minute >= 60 && pressure >= 30) { score += wTime * 0.5; }
  else if (minute < 20 && pressure >= 25) { score += wTime * 0.5; reasons.push('Presión desde el inicio'); }

  // === 7. Corners ===
  if (s.cornersHome !== null && s.cornersAway !== null) {
    const total = s.cornersHome + s.cornersAway;
    if (total >= 12) { score += wCorners * 1; pressure += 5; reasons.push(`Presión constante (${total} corners)`); }
    else if (total >= 8) { score += wCorners * 0.6; }
    if (!predictedScorer) {
      if (s.cornersHome >= s.cornersAway + 4) { predictedScorer = 'home'; scorerReasons.push('domina corners'); }
      else if (s.cornersAway >= s.cornersHome + 4) { predictedScorer = 'away'; scorerReasons.push('domina corners'); }
    }
  }

  // === 8. Posesión ===
  if (s.possessionHome !== null && s.possessionAway !== null) {
    if (s.possessionAway > 58 && awayNeeds) { score += wPoss * 1; pressure += 5; reasons.push('Visitante domina y necesita'); if (!predictedScorer) { predictedScorer = 'away'; scorerReasons.push('domina y necesita'); } }
    if (s.possessionHome > 58 && homeNeeds) { score += wPoss * 1; pressure += 5; reasons.push('Local domina y necesita'); if (!predictedScorer) { predictedScorer = 'home'; scorerReasons.push('domina y necesita'); } }
    if (Math.abs(s.possessionHome - s.possessionAway) > 20 && goals === 0) { score += wPoss * 1; pressure += 5; reasons.push('Un equipo domina pero no concreta'); }
  }

  // === 9. Paradas ===
  if (s.savesHome !== null && s.savesAway !== null) {
    const total = s.savesHome + s.savesAway;
    if (total >= 8) { score += wSaves * 1; reasons.push('Porteros muy exigidos'); }
    else if (total >= 5) { score += wSaves * 0.6; }
    if (s.savesHome >= 5 && !predictedScorer) { predictedScorer = 'away'; scorerReasons.push('presión constante'); }
    if (s.savesAway >= 5 && !predictedScorer) { predictedScorer = 'home'; scorerReasons.push('presión constante'); }
  }

  // === Ventana de tiempo ===
  let timeWindow = '';
  if (minute < 25) {
    if (pressure >= 40) timeWindow = '⚡ Gol inminente — antes del descanso (30-45\')';
    else if (pressure >= 25) timeWindow = '⏰ Probable gol antes del descanso';
    else timeWindow = '🕐 Temprano, revaluar en 15-20 min';
  } else if (minute < 40) {
    if (pressure >= 40) timeWindow = '⚡ Gol antes del descanso (30-45\') — presión alta!';
    else if (pressure >= 25) timeWindow = '⏰ Posible gol en minutos finales del 1T';
    else timeWindow = '🕐 1T tranquilo, probable gol en 2T';
  } else if (minute < 50) {
    if (pressure >= 40) timeWindow = '⚡ Gol al inicio del 2T (45-60\')';
    else if (pressure >= 25) timeWindow = '⏰ Posible gol al inicio del 2T';
    else timeWindow = '🕐 Descanso sin mucha acción';
  } else if (minute < 65) {
    if (pressure >= 40) timeWindow = '⚡ Gol en próximos 15 min — presión alta!';
    else if (pressure >= 25) timeWindow = '⏰ Posible gol en recta final (70-85\')';
    else timeWindow = '🕐 Partido tácticamente cerrado';
  } else if (minute < 80) {
    if (pressure >= 40) timeWindow = '⚡ Gol inminente — últimos 15 minutos!';
    else if (pressure >= 25) timeWindow = '⏰ Posible gol en tramo final (75-90\')';
    else timeWindow = '🕐 Partido que se apaga';
  } else {
    if (pressure >= 25) timeWindow = '⚡ Gol en cualquier momento — descuento!';
    else timeWindow = '🕐 Partido prácticamente definido';
  }

  // === Veredicto ===
  const cappedScore = Math.min(Math.max(score, 0), 100);
  let verdict = '';
  if (cappedScore >= 60) verdict = '🎯 MUY PROBABLE — casi seguro próximo gol';
  else if (cappedScore >= 45) verdict = '✅ PROBABLE — buenos indicios';
  else if (cappedScore >= 30) verdict = '📊 POSIBLE — atentos';
  else if (cappedScore >= 15) verdict = '🔶 DUDOSO — poca actividad';
  else verdict = '🔴 IMPROBABLE — muy pocas ocasiones';

  let whoText = '';
  if (predictedScorer && scorerReasons.length > 0 && cappedScore >= 30) {
    const name = predictedScorer === 'home' ? (match.teamHome || 'Local') : (match.teamAway || 'Visitante');
    whoText = `\n     ⚽ Próximo gol: ${name} (${scorerReasons.join(', ')})`;
  } else if (predictedScorer && cappedScore >= 45) {
    const name = predictedScorer === 'home' ? (match.teamHome || 'Local') : (match.teamAway || 'Visitante');
    whoText = `\n     ⚽ Próximo gol: ${name}`;
  }

  return {
    match: match.rawName, teamHome: match.teamHome, teamAway: match.teamAway,
    league: match.league, matchId: match.matchId,
    score: cappedScore, verdict, timeWindow, whoText, reasons,
    minute, scoreHome: match.scoreHome, scoreAway: match.scoreAway,
    predictedScorer: predictedScorer && cappedScore >= 25 ? predictedScorer : null,
    stats: s, pressure
  };
}

// ─── Extraer estadísticas del API de SofaScore ───
function extractStatsFromApi(statisticsItems) {
  const stats = {
    xgHome: null, xgAway: null,
    sotHome: null, sotAway: null,
    totalShotsHome: null, totalShotsAway: null,
    bigChancesHome: null, bigChancesAway: null,
    cornersHome: null, cornersAway: null,
    possessionHome: null, possessionAway: null,
    savesHome: null, savesAway: null,
    foulsHome: null, foulsAway: null,
    yellowCardsHome: null, yellowCardsAway: null,
    shotsInsideBoxHome: null, shotsInsideBoxAway: null
  };
  if (!statisticsItems) return stats;
  for (const item of statisticsItems) {
    const h = item.homeValue;
    const a = item.awayValue;
    if (h === undefined && a === undefined) continue;
    switch (item.key) {
      case 'expectedGoals':
        stats.xgHome = typeof h === 'number' ? h : parseFloat(h);
        stats.xgAway = typeof a === 'number' ? a : parseFloat(a);
        break;
      case 'shotsOnGoal':
        stats.sotHome = typeof h === 'number' ? h : parseInt(h);
        stats.sotAway = typeof a === 'number' ? a : parseInt(a);
        break;
      case 'totalShotsOnGoal':
        stats.totalShotsHome = typeof h === 'number' ? h : parseInt(h);
        stats.totalShotsAway = typeof a === 'number' ? a : parseInt(a);
        break;
      case 'bigChanceCreated':
        stats.bigChancesHome = typeof h === 'number' ? h : parseInt(h);
        stats.bigChancesAway = typeof a === 'number' ? a : parseInt(a);
        break;
      case 'cornerKicks':
        stats.cornersHome = typeof h === 'number' ? h : parseInt(h);
        stats.cornersAway = typeof a === 'number' ? a : parseInt(a);
        break;
      case 'ballPossession':
        stats.possessionHome = typeof h === 'number' ? (h > 1 ? h / 100 : h) : parseFloat(h) / 100;
        stats.possessionAway = typeof a === 'number' ? (a > 1 ? a / 100 : a) : parseFloat(a) / 100;
        break;
      case 'goalkeeperSaves':
        if (stats.savesHome === null) {
          stats.savesHome = typeof h === 'number' ? h : parseInt(h);
          stats.savesAway = typeof a === 'number' ? a : parseInt(a);
        }
        break;
      case 'fouls':
        stats.foulsHome = typeof h === 'number' ? h : parseInt(h);
        stats.foulsAway = typeof a === 'number' ? a : parseInt(a);
        break;
      case 'yellowCards':
        stats.yellowCardsHome = typeof h === 'number' ? h : parseInt(h);
        stats.yellowCardsAway = typeof a === 'number' ? a : parseInt(a);
        break;
      case 'totalShotsInsideBox':
        stats.shotsInsideBoxHome = typeof h === 'number' ? h : parseInt(h);
        stats.shotsInsideBoxAway = typeof a === 'number' ? a : parseInt(a);
        break;
    }
  }
  return stats;
}

// ─── Obtener partidos + estadísticas vía API (sesión del browser) ───
async function fetchLiveMatchesViaApi(page, maxMatches) {
  const apiStatus = await page.evaluate(async () => {
    const resp = await fetch('https://www.sofascore.com/api/v1/sport/football/events/live');
    return { status: resp.status, ok: resp.ok };
  });
  console.log(`  API /events/live -> status ${apiStatus.status} ok:${apiStatus.ok}`);

  return await page.evaluate(async (max) => {
    const liveResp = await fetch('https://www.sofascore.com/api/v1/sport/football/events/live');
    const live = await liveResp.json();
    const events = (live.events || []).slice(0, max);
    const result = [];

    for (const ev of events) {
      // Estadísticas
      const statsResp = await fetch(`https://api.sofascore.com/api/v1/event/${ev.id}/statistics`);
      let allItems = [];
      if (statsResp.ok) {
        const statsData = await statsResp.json();
        const allPeriod = (statsData.statistics || []).find(p => p.period === 'ALL');
        if (allPeriod) {
          for (const group of allPeriod.groups || []) {
            allItems = allItems.concat(group.statisticsItems || []);
          }
        }
      }

      result.push({
        id: ev.id,
        slug: ev.slug,
        homeTeam: ev.homeTeam.name,
        awayTeam: ev.awayTeam.name,
        homeScore: ev.homeScore.current || 0,
        awayScore: ev.awayScore.current || 0,
        minute: parseInt(ev.status.displayed) || (ev.status.code > 0 ? ev.status.code : 0),
        tournament: ev.tournament.name,
        category: ev.tournament.category.name,
        statistics: allItems
      });
    }
    return result;
  }, maxMatches);
}

// ─── Flujo principal ───
async function main() {
  const weights = loadWeights();
  const predictions = loadPredictions();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  const analyzed = [];

  try {
    console.log('[1/3] Iniciando sesión en SofaScore...');
    await page.goto('https://www.sofascore.com/es', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    console.log('[2/3] Obteniendo partidos en vivo vía API...');
    const liveData = await fetchLiveMatchesViaApi(page, 8);
    console.log(`  -> ${liveData.length} partidos en vivo\n`);

    // Escribir resumen para GitHub Actions (si aplica)
    function writeSummary(text) {
      if (process.env.GITHUB_STEP_SUMMARY) {
        try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n'); } catch {}
      }
    }
    writeSummary(`## Análisis ${new Date().toISOString()}\n- Partidos en vivo: ${liveData.length}`);

    if (liveData.length === 0) {
      console.log('  No hay partidos en vivo ahora.');
      writeSummary('- Estado: sin partidos en vivo');
    }

    // Debug info — siempre, incluso si hay partidos (para comparar local vs GH)
    const debugInfo = await page.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        visible: document.body.innerText.split('\n').filter(l => l.trim()).slice(0, 20).join(' | '),
        hasCaptcha: document.querySelector('iframe[src*=\"recaptcha\"]') !== null,
        apiLiveStatus: '',
        fp: {
          webdriver: navigator.webdriver,
          userAgent: navigator.userAgent,
          plugins: navigator.plugins.length,
          languages: navigator.languages,
          cookiesEnabled: navigator.cookieEnabled
        }
      };
    });

    // Intentar llamada directa a API y capturar respuesta
    const apiDebug = await page.evaluate(async () => {
      try {
        const resp = await fetch('https://www.sofascore.com/api/v1/sport/football/events/live');
        const text = await resp.text();
        return { status: resp.status, length: text.length, preview: text.slice(0, 200) };
      } catch (e) {
        return { error: e.message };
      }
    });

    console.log(`  Debug URL: ${debugInfo.url}`);
    console.log(`  Debug Title: ${debugInfo.title}`);
    console.log(`  Debug captcha: ${debugInfo.hasCaptcha}`);
    console.log(`  Debug webdriver: ${debugInfo.fp.webdriver}`);
    console.log(`  Debug userAgent: ${debugInfo.fp.userAgent}`);
    console.log(`  Debug API: status=${apiDebug.status} len=${apiDebug.length} preview=${apiDebug.preview?.slice(0, 100)}`);
    if (apiDebug.error) console.log(`  API error: ${apiDebug.error}`);
    if (liveData.length === 0) {
      console.log(`  Debug texto: ${debugInfo.visible.slice(0, 400)}`);
    }

    await page.screenshot({ path: 'debug_screenshot.png', fullPage: false });

    if (liveData.length === 0) {
      console.log('  Debug screenshot guardada.');
      await browser.close();
      return;
    }

    console.log(`[3/3] Analizando ${liveData.length} partidos...\n`);

    for (let i = 0; i < liveData.length; i++) {
      const m = liveData[i];
      const displayName = `${m.homeTeam} vs ${m.awayTeam}`;
      console.log(`  [${i + 1}/${liveData.length}] ${displayName}`);

      const stats = extractStatsFromApi(m.statistics);

      const xgStr = stats.xgHome !== null ? `${stats.xgHome.toFixed(2)}-${stats.xgAway.toFixed(2)}` : '?-?';
      const sotStr = stats.sotHome !== null ? `${stats.sotHome}-${stats.sotAway}` : '?-?';
      console.log(`     -> ${m.category} | xG:${xgStr} SOT:${sotStr}`);

      // Saltar partidos recién iniciados (sin datos)
      const justStarted = m.minute <= 5 || (!stats.totalShotsHome && !stats.totalShotsAway);
      if (justStarted && stats.totalShotsHome === null && stats.totalShotsAway === null) {
        console.log('  -> Recién iniciado, sin datos aún\n');
        continue;
      }

      analyzed.push({
        rawName: displayName,
        teamHome: m.homeTeam,
        teamAway: m.awayTeam,
        league: `${m.category} > ${m.tournament}`,
        matchId: String(m.id),
        minute: m.minute,
        scoreHome: m.homeScore,
        scoreAway: m.awayScore,
        stats
      });
      console.log('');
    }

    // Análisis
    const ranked = analyzed.map(m => analyzeGoal(m, getLeagueWeights(weights, m.league))).sort((a, b) => b.score - a.score);

    // Guardar predicciones
    const now = new Date().toISOString();
    const newPredictions = ranked.map(r => ({
      id: r.matchId,
      match: `${r.teamHome} vs ${r.teamAway}`,
      league: r.league,
      timestamp: now,
      analysisMinute: r.minute,
      scoreAtAnalysis: { home: r.scoreHome, away: r.scoreAway },
      stats: r.stats,
      predictedProbability: r.score,
      predictedScorer: r.predictedScorer,
      predictedTimeWindow: r.timeWindow,
      finalScore: null,
      goalAfterAnalysis: null,
      actualGoalMinute: null,
      actualScorer: null,
      predictionCorrect: null
    }));
    predictions.push(...newPredictions);
    savePredictions(predictions);
    weights.stats.predictionsCount += newPredictions.length;
    saveWeights(weights);
    console.log(`  -> ${newPredictions.length} predicciones guardadas para aprendizaje\n`);

    // OUTPUT
    console.log('='.repeat(64));
    console.log('  📊 PRÓXIMO GOL — ANÁLISIS EN VIVO');
    console.log('='.repeat(64) + '\n');

    if (ranked.length === 0) {
      console.log('  No se pudieron analizar partidos.\n');
    } else {
      ranked.forEach((r, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `  ${i + 1}.`;
        const barLen = Math.round(r.score / 5);
        const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
        console.log(`  ${medal} [${r.score}%] ${bar}`);
        if (r.league) console.log(`     🏆 ${r.league}`);
        console.log(`     ${r.teamHome} vs ${r.teamAway}`);
        if (r.minute) console.log(`     ⏱ ${r.minute}' | ${r.scoreHome} - ${r.scoreAway}`);
        console.log(`     ${r.timeWindow}`);
        console.log(`     ${r.verdict}${r.whoText}`);
        const xgS = r.stats.xgHome !== null ? `${r.stats.xgHome.toFixed(2)}-${r.stats.xgAway.toFixed(2)}` : '?-?';
        const sotS = r.stats.sotHome !== null ? `${r.stats.sotHome}-${r.stats.sotAway}` : '?-?';
        const bcS = r.stats.bigChancesHome !== null ? `${r.stats.bigChancesHome}-${r.stats.bigChancesAway}` : '?-?';
        const corS = r.stats.cornersHome !== null ? `${r.stats.cornersHome}-${r.stats.cornersAway}` : '?-?';
        const savS = r.stats.savesHome !== null ? `${r.stats.savesHome}-${r.stats.savesAway}` : '?-?';
        const posS = r.stats.possessionHome !== null ? `${Math.round(r.stats.possessionHome * 100)}%-${Math.round(r.stats.possessionAway * 100)}%` : '?-?';
        console.log(`     📊 xG:${xgS} SOT:${sotS} OC:${bcS} Esq:${corS} Par:${savS} Pos:${posS}`);
        if (r.reasons.length > 0) console.log(`     🔍 ${r.reasons.join(' | ')}`);
        console.log('');
      });

      console.log('='.repeat(64));
      const top = ranked[0];
      if (top.score >= 40) {
        console.log(`  🎯 RECOMENDACIÓN PRINCIPAL:`);
        console.log(`     ${top.teamHome} vs ${top.teamAway} (${top.league})`);
        console.log(`     Confianza: ${top.score}% — ${top.timeWindow}`);
        console.log(`     ${top.verdict}`);
        if (top.whoText) console.log(`     ${top.whoText.trim()}`);
        if (ranked.length > 1 && ranked[1].score >= 35) {
          console.log(`\n  📌 ALTERNATIVA:`);
          console.log(`     ${ranked[1].teamHome} vs ${ranked[1].teamAway} (${ranked[1].score}%)`);
          console.log(`     ${ranked[1].timeWindow}`);
        }
      } else {
        console.log('  ⚠️  Sin recomendaciones sólidas ahora.');
        console.log('  Los partidos tienen poca actividad ofensiva.');
        if (top.score >= 20) {
          console.log(`\n  Mejor opción: ${top.teamHome} vs ${top.teamAway} (${top.score}%)`);
          console.log(`  ${top.timeWindow}`);
        }
      }
      console.log('='.repeat(64));
    }

    // Resumen para GitHub Actions
    if (ranked.length > 0) {
      writeSummary(`- Mejor score: ${ranked[0].score}% (umbral: 70%)`);
      writeSummary(`- Top: ${ranked[0].teamHome} vs ${ranked[0].teamAway}`);
      if (ranked[0].score >= 70) writeSummary('- Alerta: ✅ ENVIADA');
      else writeSummary('- Alerta: ❌ No enviada (umbral no alcanzado)');
    } else {
      writeSummary('- No se analizaron partidos');
    }

    // Enviar alerta Telegram
    if (ranked.length > 0) {
      console.log(`  -> Mejor score: ${ranked[0].score}% (umbral: 70%)`);
      console.log(`  -> TELEGRAM_BOT_TOKEN ${process.env.TELEGRAM_BOT_TOKEN ? '✓ configurado' : '✗ no configurado'}`);
    }
    if (ranked.length > 0 && ranked[0].score >= 70) {
      const msg = notify.buildMessage(ranked);
      if (msg) {
        console.log('  -> Enviando alerta Telegram...');
        await notify.sendTelegram(msg);
      } else {
        console.log('  -> buildMessage devolvió null (ninguno ≥70%)');
      }
    }

  } catch (err) {
    console.error('Error:', err.message);
    try {
      if (typeof ranked !== 'undefined' && ranked.length > 0) {
        console.log(`  -> (catch) Mejor score: ${ranked[0].score}%`);
      }
      if (typeof ranked !== 'undefined' && ranked.length > 0 && ranked[0].score >= 70) {
        const msg = notify.buildMessage(ranked);
        if (msg) {
          console.log('  -> (catch) Enviando alerta Telegram...');
          await notify.sendTelegram(msg);
        }
      }
    } catch (notifyErr) {
      console.error('Notification error:', notifyErr.message);
    }
  } finally {
    await browser.close();
  }
}

main();
