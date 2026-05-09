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

// ─── Flujo principal ───
async function main() {
  const weights = loadWeights();
  const predictions = loadPredictions();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'es-ES' });
  const page = await context.newPage();
  const analyzed = [];

  try {
    console.log('[1/5] Navegando a SofaScore...');
    await page.goto('https://www.sofascore.com/es', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    console.log('[2/5] Filtrando en vivo...');
    const liveBtns = page.locator('button').filter({ hasText: /En Vivo/i });
    for (let i = 0; i < await liveBtns.count(); i++) {
      if (await liveBtns.nth(i).isVisible()) {
        await liveBtns.nth(i).click();
        console.log('  -> "En Vivo" seleccionado');
        await page.waitForTimeout(3000);
        break;
      }
    }

    console.log('[3/5] Buscando partidos...');
    const matchLinks = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/football/match/"]');
      const seen = new Set();
      return Array.from(links)
        .map(a => ({ href: a.href, text: a.innerText?.trim()?.replace(/\s+/g, ' ') }))
        .filter(l => l.href && !l.href.includes('tournament') && !seen.has(l.href) && seen.add(l.href))
        .filter(l => /\d+['′]/.test(l.text));
    });

    console.log(`  -> ${matchLinks.length} partidos en vivo`);

    if (matchLinks.length === 0) {
      console.log('  No hay partidos en vivo ahora.');
      console.log('  Tomando screenshot para depuración...');
      await page.screenshot({ path: 'debug_no_matches.png', fullPage: false });
      const urlActual = page.url();
      const titleActual = await page.title();
      console.log(`  URL actual: ${urlActual}`);
      console.log(`  Title: ${titleActual}`);
      // Buscar texto que muestre qué hay en la página
      const visibleText = await page.evaluate(() => {
        const lines = document.body.innerText.split('\n').filter(l => l.trim()).slice(0, 30);
        return lines.join(' | ');
      });
      console.log(`  Texto visible (primeros 30): ${visibleText.slice(0, 500)}`);
      await browser.close();
      return;
    }

    const maxMatches = Math.min(matchLinks.length, 8);
    console.log(`[4/5] Analizando ${maxMatches} partidos...\n`);

    for (let i = 0; i < maxMatches; i++) {
      const m = matchLinks[i];
      const displayName = (m.text || '').replace(/\s+/g, ' ').trim().slice(0, 90);
      console.log(`  [${i + 1}/${maxMatches}] ${displayName}`);

      try {
        await page.goto(m.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(3000);

        // Extraer info básica + liga + matchId
        const basicInfo = await page.evaluate(() => {
          const text = document.body.innerText;
          const scoreRx = text.match(/(\d+)\s*[-–]\s*(\d+)/);
          const score = scoreRx ? { h: parseInt(scoreRx[1]), a: parseInt(scoreRx[2]) } : { h: 0, a: 0 };
          let minute = null;
          const timeRx = text.match(/(\d{1,3}:\d{2})(?:\s|$)/);
          if (timeRx) {
            const p = timeRx[1].split(':');
            minute = parseInt(p[0]);
          }
          if (!minute || minute > 120) {
            const lines = text.split('\n').filter(l => l.trim());
            for (let i = 0; i < Math.min(lines.length, 20); i++) {
              const mm = lines[i].match(/(\d{1,3})['′]/);
              if (mm) { const c = parseInt(mm[1]); if (c > 0 && c <= 120) { minute = c; break; } }
            }
          }
          // Extraer liga — primero buscar breadcrumb por patrón "Fútbol > País > Liga"
          let league = 'Desconocida';

          const bcRx = /(?:Fútbol|Football)\s*[>\/•]\s*([A-ZÁÉÍÓÚÑa-záéíóúñ\s]{2,40}?)\s*[>\/•]\s*([A-ZÁÉÍÓÚÑ][A-Za-záéíóúñ\s,]{2,60}?)(?:\s*[>\/•]|,?\s*(?:Jornada|Round|\d|$))/;
          const bcMatch = text.match(bcRx);
          if (bcMatch) {
            const candidate = `${bcMatch[1].trim()} > ${bcMatch[2].trim()}`;
            if (candidate.length < 80 && candidate.length > 5) league = candidate;
          }

          // Estrategia 2: buscar "Fútbol/Football" seguido del nombre de liga (nombres largos)
          if (league === 'Desconocida') {
            const leagueRx = /(?:Fútbol|Football)\s*[>\/•]\s*([A-ZÁÉÍÓÚÑ][A-Za-záéíóúñ\s,]{5,60}?)(?:\s*[>\/•]|,?\s*(?:Jornada|Round|\d|$))/;
            const lMatch = text.match(leagueRx);
            if (lMatch) {
              const candidate = lMatch[1].trim();
              if (candidate.length > 5 && !/[¿¡!]/.test(candidate)) {
                league = candidate;
              }
            }
          }

          // Estrategia 3: buscar líneas que empiecen con "Fútbol" o "Football"
          if (league === 'Desconocida') {
            const lines = text.split('\n').filter(l => l.trim());
            for (const line of lines) {
              const m = line.match(/^(?:Fútbol|Football)(.+)/);
              if (m) {
                const cleaned = m[1].trim();
                if (cleaned.length > 5 && cleaned.length < 60 && !/[¿¡!]/.test(cleaned)) {
                  league = cleaned.split(/[,;\d]/)[0].trim();
                  break;
                }
              }
            }
          }

          // Validación final: descartar códigos cortos, publicidad y textos inválidos
          const isCode = /^[A-Z0-9]{2,6}$/.test(league);
          const isAd = /domina|conquista|apuesta|gana|juega|suscríbete|registro|promo|publicidad/i.test(league);
          if (isCode || isAd || league.length < 5) {
            league = 'Desconocida';
          }
          // Extraer matchId de la URL
          const urlMatch = window.location.href.match(/id:(\d+)/);
          const matchId = urlMatch ? urlMatch[1] : 'unknown';
          return { score, minute, league, matchId };
        });

        // Minuto desde el link
        const linkMinuteRx = m.text.match(/(\d+)['′]/);
        if (!basicInfo.minute && linkMinuteRx) basicInfo.minute = parseInt(linkMinuteRx[1]);

        // Score desde el link
        const linkScoreRx = m.text.match(/(\d+)\s*[-–]\s*(\d+)/);
        if (linkScoreRx && basicInfo.score.h === 0 && basicInfo.score.a === 0) {
          basicInfo.score = { h: parseInt(linkScoreRx[1]), a: parseInt(linkScoreRx[2]) };
        }

        // Click Estadísticas
        let statsTab = page.getByTestId('tab-statistics');
        if (await statsTab.count() === 0) {
          const allTabs = page.getByRole('tab');
          for (let ti = 0; ti < await allTabs.count(); ti++) {
            if ((await allTabs.nth(ti).textContent())?.trim() === 'Estadísticas') {
              statsTab = allTabs.nth(ti); break;
            }
          }
        }

        let stats = { xgHome: null, xgAway: null, sotHome: null, sotAway: null, totalShotsHome: null, totalShotsAway: null, bigChancesHome: null, bigChancesAway: null, cornersHome: null, cornersAway: null, possessionHome: null, possessionAway: null, savesHome: null, savesAway: null, foulsHome: null, foulsAway: null, yellowCardsHome: null, yellowCardsAway: null, shotsInsideBoxHome: null, shotsInsideBoxAway: null };

        if (await statsTab.count() > 0) {
          await statsTab.click();
          await page.waitForTimeout(2000);
          const statsText = await page.evaluate(() => {
            const panel = document.querySelector('#tabpanel-statistics');
            return panel ? panel.innerText : '';
          });
          const lines = statsText.split('\n').map(l => l.trim()).filter(l => l);

          for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (l.includes('Goles esperados')) {
              const p = parseFloat(lines[i - 1]), n = parseFloat(lines[i + 1]);
              if (!isNaN(p) && p < 20) stats.xgHome = p;
              if (!isNaN(n) && n < 20) stats.xgAway = n;
            }
            if (l === 'Tiros a puerta') {
              const p = parseInt(lines[i - 1]), n = parseInt(lines[i + 1]);
              if (!isNaN(p)) stats.sotHome = p;
              if (!isNaN(n)) stats.sotAway = n;
            }
            if (l === 'Tiros totales' && stats.totalShotsHome === null) {
              const p = parseInt(lines[i - 1]), n = parseInt(lines[i + 1]);
              if (!isNaN(p)) stats.totalShotsHome = p;
              if (!isNaN(n)) stats.totalShotsAway = n;
            }
            if (l.includes('Ocasiones claras') && !l.includes('falladas')) {
              const p = parseInt(lines[i - 1]), n = parseInt(lines[i + 1]);
              if (!isNaN(p)) stats.bigChancesHome = p;
              if (!isNaN(n)) stats.bigChancesAway = n;
            }
            if (l.includes('Posesión de balón')) {
              const p = parseFloat(lines[i - 1]?.replace('%', '')), n = parseFloat(lines[i + 1]?.replace('%', ''));
              if (!isNaN(p)) stats.possessionHome = p;
              if (!isNaN(n)) stats.possessionAway = n;
            }
            if (l.includes('Saques de esquina')) {
              const p = parseInt(lines[i - 1]), n = parseInt(lines[i + 1]);
              if (!isNaN(p)) stats.cornersHome = p;
              if (!isNaN(n)) stats.cornersAway = n;
            }
            if (l === 'Paradas') {
              const p = parseInt(lines[i - 1]), n = parseInt(lines[i + 1]);
              if (!isNaN(p)) stats.savesHome = p;
              if (!isNaN(n)) stats.savesAway = n;
            }
          }
          console.log(`  -> ${basicInfo.league} | xG:${stats.xgHome??'?'}-${stats.xgAway??'?'} SOT:${stats.sotHome??'?'}-${stats.sotAway??'?'}`);
        } else {
          console.log(`  -> ${basicInfo.league} | Sin estadísticas`);
        }

        // Parsear equipos
        const parts = displayName.split(' ').filter(p => !/^(\d{1,2}:\d{2}|\d{1,2}['′]|\d+)$/.test(p) && p.trim());
        const mid = Math.ceil(parts.length / 2);
        const teamHome = parts.slice(0, mid).join(' ');
        const teamAway = parts.slice(mid).join(' ');

        // Saltar partidos recién iniciados
        const justStarted = (basicInfo.minute !== null && basicInfo.minute <= 5) ||
          (!basicInfo.minute && (!stats.totalShotsHome || stats.totalShotsHome === 0));
        if (justStarted && stats.totalShotsHome === 0 && stats.totalShotsAway === 0) {
          console.log('  -> Recién iniciado, sin datos aún\n');
          continue;
        }

        analyzed.push({
          rawName: displayName, teamHome, teamAway,
          league: basicInfo.league, matchId: basicInfo.matchId,
          minute: basicInfo.minute,
          scoreHome: basicInfo.score.h, scoreAway: basicInfo.score.a,
          stats
        });

      } catch (err) {
        console.log(`  -> Error: ${err.message.slice(0, 100)}`);
      }
      console.log('');
    }

    // === 5. Analizar y mostrar ===
    console.log('[5/5] Analizando...');
    const ranked = analyzed.map(m => analyzeGoal(m, getLeagueWeights(weights, m.league))).sort((a, b) => b.score - a.score);

    // Guardar predicciones para aprendizaje futuro
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
      finalScore: null,    // se rellena después
      goalAfterAnalysis: null, // true/false
      actualGoalMinute: null,
      actualScorer: null,
      predictionCorrect: null
    }));
    predictions.push(...newPredictions);
    savePredictions(predictions);
    weights.stats.predictionsCount += newPredictions.length;
    saveWeights(weights);

    console.log(`  -> ${newPredictions.length} predicciones guardadas para aprendizaje\n`);

    // === OUTPUT ===
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
        const posS = r.stats.possessionHome !== null ? `${r.stats.possessionHome}%-${r.stats.possessionAway}%` : '?-?';
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

    // Enviar alerta Telegram si hay alta probabilidad
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
