const { chromium } = require('playwright');

async function getLiveMatchLinks(page) {
  await page.goto('https://www.flashscore.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  const items = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/match/"]'));
    const seen = new Set();
    const results = [];
    links.forEach(a => {
      const href = a.href.split('?')[0];
      if (!seen.has(href)) {
        seen.add(href);
        const parent = a.closest('[class*="match"]');
        const parentText = parent ? parent.innerText : a.innerText;
        const teamLinks = parent ? Array.from(parent.querySelectorAll('a[href*="/team/"]')) : [];
        results.push({
          href: href,
          text: parentText?.replace(/\s+/g, ' ')?.trim(),
          homeTeam: teamLinks[0]?.textContent?.trim() || '',
          awayTeam: teamLinks[1]?.textContent?.trim() || ''
        });
      }
    });
    return results;
  });

  // Live: empieza con minuto y tiene marcador (Finished/Scheduled no)
  const live = items.filter(r => {
    if (!r.text) return false;
    if (/^Finished/i.test(r.text)) return false;
    if (/^\d{1,2}:\d{2}\s/.test(r.text)) return false;
    if (!/^\d{1,3}\s/.test(r.text)) return false;
    return /\d+\s+\d+$/.test(r.text);
  });
  console.log('  -> ' + live.length + ' en vivo de ' + items.length + ' items');
  return live;
}

function sanitizeLeague(league) {
  if (!league) return '';
  // Remove trailing URL fragments / IDs like "8InmcPIF"
  let clean = league.replace(/\s+[A-Z0-9]{6,}$/i, '').trim();
  // If sanitization emptied it, keep original
  return clean || league;
}

async function extractMatchStats(page, matchUrl) {
  const statsUrl = matchUrl.replace(/\/+$/, '') + '/summary/stats/';
  // Force fresh load every time to avoid SPA stale cache
  await page.goto(statsUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  try {
    await page.waitForSelector('[data-testid="wcl-statistics"]', { timeout: 8000 });
  } catch {
    // Stats table not found, page probably redirected or stats not available
  }
  // Extra wait for JS to render dynamic content
  await page.waitForTimeout(3000);

  const evalResult = await page.evaluate(() => {
    const rows = document.querySelectorAll('[data-testid="wcl-statistics"]');
    const stats = {};
    rows.forEach(row => {
      const categoryEl = row.querySelector('[data-testid="wcl-statistics-category"]');
      if (!categoryEl) return;
      const name = categoryEl.textContent?.trim();
      if (!name || name === 'Info about') return;
      const homeEl = row.querySelector('.wcl-homeValue_3Q-7P');
      const awayEl = row.querySelector('.wcl-awayValue_Y-QR1');
      const home = homeEl?.textContent?.trim() || '';
      const away = awayEl?.textContent?.trim() || '';
      stats[name] = { home, away };
    });

    const teamLinks = document.querySelectorAll('a.participant__participantName');
    const homeTeam = teamLinks[0]?.textContent?.trim() || '';
    const awayTeam = teamLinks[1]?.textContent?.trim() || '';

    // Extract league from breadcrumb or navigation
    let league = '';
    const breadcrumb = document.querySelector('[class*="breadcrumb"]') || document.querySelector('[data-testid*="breadcrumb"]');
    if (breadcrumb) {
      const items = breadcrumb.querySelectorAll('a, span, [class*="item"]');
      const texts = Array.from(items).map(el => el.textContent?.trim()).filter(Boolean);
      // Busca el penúltimo elemento antes de "Partido" o similar
      const matchIdx = texts.findIndex(t => /partido|match|vs/i.test(t));
      if (matchIdx >= 2) league = texts[matchIdx - 1];
      else if (texts.length >= 3) league = texts[texts.length - 2];
    }
    // Fallback: buscar en el título de la página
    if (!league) {
      const titleParts = document.title.split(/[-–—|]/).map(s => s.trim()).filter(Boolean);
      // Típicamente: "Team vs Team - League - Flashscore"
      if (titleParts.length >= 2) {
        const possible = titleParts[titleParts.length - 2];
        if (possible && !possible.match(/^https?/) && possible.length < 40) league = possible;
      }
    }

    // Extract score and minute - use reliable sources
    const title = document.title;
    let scoreHome = null, scoreAway = null, minute = null, status = '';

    // 1) Score from page title: "Rosario Central 1-0 Racing Club Live - Flashscore"
    const titleScore = title.match(/(\d{1,2})\s*[-–:]\s*(\d{1,2})/);
    if (titleScore) {
      const h = parseInt(titleScore[1]), a = parseInt(titleScore[2]);
      if (h < 50 && a < 50) { scoreHome = h; scoreAway = a; }
    }

    // 2) Fallback: specific score element
    if (scoreHome === null) {
      const scoreEl = document.querySelector('[data-testid*="score"]') || document.querySelector('.detailScore__wrapper');
      if (scoreEl) {
        const m = scoreEl.textContent.trim().match(/(\d{1,2})\s*[-–:]\s*(\d{1,2})/);
        if (m) { const h = parseInt(m[1]), a = parseInt(m[2]); if (h < 50 && a < 50) { scoreHome = h; scoreAway = a; } }
      }
    }

    // 3) Last resort: limited bodyText near team names
    if (scoreHome === null) {
      const bodyText = document.body.innerText;
      const scores = [...bodyText.matchAll(/(\d{1,2})\s*[-–]\s*(\d{1,2})/g)];
      // Prefer scores near team names
      for (const s of scores) {
        const h = parseInt(s[1]), a = parseInt(s[2]);
        if (h < 50 && a < 50) {
          const ctx = bodyText.substring(Math.max(0, s.index - 60), s.index + s[0].length + 60).toLowerCase();
          if (ctx.includes(homeTeam.toLowerCase().slice(0, 8)) || ctx.includes(awayTeam.toLowerCase().slice(0, 8))) {
            scoreHome = h; scoreAway = a; break;
          }
        }
      }
      // If still not found, take first plausible score
      if (scoreHome === null) {
        for (const s of scores) {
          const h = parseInt(s[1]), a = parseInt(s[2]);
          if (h < 50 && a < 50) { scoreHome = h; scoreAway = a; break; }
        }
      }
    }

    // Minute from page title or body (HT indicator)
    if (title.includes('Half Time') || title.includes('HALF TIME')) {
      minute = 45; status = 'HT';
    } else {
      const bodyText = document.body.innerText;
      let mm = bodyText.match(/(?:^|\s)(\d{1,3})\s*[''\u2019\u2032]\s*(?:$|\s)/);
      if (!mm) mm = bodyText.match(/(?:^|\n)\s*(\d{1,3})\s*[''\u2019\u2032]?\s/);
      if (mm) {
        const m = parseInt(mm[1]);
        if (m >= 0 && m <= 120) { minute = m; status = minute + "'"; }
      }
      if (bodyText.includes('HALF TIME') || bodyText.includes('Half Time')) {
        if (!minute) { minute = 45; status = 'HT'; }
        else { status = 'HT'; }
      }
    }

    return { stats, homeTeam, awayTeam, scoreHome, scoreAway, minute, status, league: league };
  });
  if (evalResult && evalResult.league) {
    evalResult.league = sanitizeLeague(evalResult.league);
  }
  return evalResult || { stats: {}, homeTeam: '', awayTeam: '', scoreHome: null, scoreAway: null, minute: null, status: '', league: '' };
}

/**
 * Fetch xG from Flashscore for specific matches by team names.
 * Much faster than fetchAllLiveMatches - only opens match detail pages for the requested matches.
 * @param {Array} targets - Array of {teamHome, teamAway} objects
 * @returns {Object} Map of "teamHome vs teamAway" -> {xgHome, xgAway}
 */
async function fetchXgBatch(targets) {
  if (!targets || targets.length === 0) return {};
  
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({
    locale: 'es-CO',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  // 1. Get all match links from live page
  const allLinks = await getLiveMatchLinks(page);
  
  // 2. Match targets to links
  const results = {};
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  for (const target of targets) {
    const key = target.teamHome + ' vs ' + target.teamAway;
    const hNorm = normalize(target.teamHome);
    const aNorm = normalize(target.teamAway);
    
    // Find the link
    const link = allLinks.find(l => {
      const lh = normalize(l.homeTeam);
      const la = normalize(l.awayTeam);
      return (lh.includes(hNorm) || hNorm.includes(lh)) && (la.includes(aNorm) || aNorm.includes(la));
    });
    
    if (!link) {
      console.log('  [xG] No Flashscore link for ' + key);
      results[key] = null;
      continue;
    }
    
    // 3. Use a fresh tab per match to avoid SPA stale data
    const tab = await context.newPage();
    await tab.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
    try {
      const statsUrl = link.href.replace(/\/+$/, '') + '/summary/stats/';
      await tab.goto(statsUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      try { await tab.waitForSelector('[data-testid="wcl-statistics"]', { timeout: 8000 }); } catch {}
      await tab.waitForTimeout(3000);
      
      const xg = await tab.evaluate(() => {
        const rows = document.querySelectorAll('[data-testid="wcl-statistics"]');
        for (const row of rows) {
          const name = row.querySelector('[data-testid="wcl-statistics-category"]')?.textContent?.trim() || '';
          if (/xG|expected goals|goles esperados/i.test(name)) {
            const homeEl = row.querySelector('.wcl-homeValue_3Q-7P');
            const awayEl = row.querySelector('.wcl-awayValue_Y-QR1');
            const home = homeEl?.textContent?.trim();
            const away = awayEl?.textContent?.trim();
            if (home && away) return { home: parseFloat(home), away: parseFloat(away) };
          }
        }
        return null;
      });
      
      results[key] = xg;
      console.log('  [xG] ' + target.teamHome + ' vs ' + target.teamAway + ': ' + (xg ? xg.home + '-' + xg.away : 'no encontrado'));
    } catch (e) {
      console.log('  [xG] Error fetching ' + key + ': ' + e.message);
      results[key] = null;
    } finally {
      await tab.close();
    }
  }
  
  await browser.close();
  return results;
}

/**
 * Extract Match Momentum from Flashscore match page.
 * Flashscore has a momentum graph showing pressure per minute.
 * Returns: { homeMomentum: 0-100, awayMomentum: 0-100, last15Home: 0-100, last15Away: 0-100, trend: 'home'|'away'|'neutral' }
 */
async function extractMatchMomentum(page, matchUrl) {
  // Momentum esta en la pestana de estadisticas o directamente en /summary/
  const momentumUrl = matchUrl.replace(/\/+$/, '') + '/summary/';
  await page.goto(momentumUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  return await page.evaluate(() => {
    // Buscar el grafico de momentum - Flashscore usa varios selectores posibles
    // El momentum graph tiene barras rojas (local) y azules (visitante)
    let homeMom = 0, awayMom = 0;
    let last15Home = 0, last15Away = 0;
    let momentumFound = false;

    // Selector 1: data-testid para momentum
    const momentumEl = document.querySelector('[data-testid*="momentum"]') ||
                       document.querySelector('.momentumChart') ||
                       document.querySelector('[class*="momentum"]');

    if (momentumEl) {
      momentumFound = true;
      // Buscar barras del grafico
      const bars = momentumEl.querySelectorAll('div[class*="bar"], rect, [class*="Bar"]');
      let homeSum = 0, awaySum = 0, count = 0;
      bars.forEach(b => {
        const height = parseFloat(b.style?.height || b.getAttribute('height') || 0);
        const isHome = b.className?.includes('home') || b.getAttribute('data-side') === 'home';
        const isAway = b.className?.includes('away') || b.getAttribute('data-side') === 'away';
        if (isHome && height > 0) { homeSum += height; count++; }
        if (isAway && height > 0) { awaySum += height; count++; }
      });
      if (count > 0) {
        homeMom = Math.min(100, Math.round(homeSum / count * 2));
        awayMom = Math.min(100, Math.round(awaySum / count * 2));
      }
    }

    // Selector 2: buscar "Match Momentum" o "Momentum" como texto
    if (!momentumFound) {
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const text = el.textContent?.trim().toLowerCase() || '';
        if (text === 'match momentum' || text === 'momentum' || text.includes('momentum del partido')) {
          momentumFound = true;
          // Buscar barras cercanas
          const parent = el.closest('[class*="section"], [class*="card"], [class*="container"]') || el.parentElement;
          if (parent) {
            const bars = parent.querySelectorAll('div[style*="height"], rect, [class*="bar"]');
            let hSum = 0, aSum = 0, c = 0;
            bars.forEach(b => {
              const h = parseFloat(b.style?.height || b.getAttribute('height') || 0);
              if (h > 0) {
                const cls = b.className || '';
                if (cls.includes('home') || cls.includes('Home')) hSum += h;
                else if (cls.includes('away') || cls.includes('Away')) aSum += h;
                c++;
              }
            });
            if (c > 0) {
              homeMom = Math.min(100, Math.round(hSum / c * 2));
              awayMom = Math.min(100, Math.round(aSum / c * 2));
            }
          }
          break;
        }
      }
    }

    // Selector 3: SVG path para el grafico de momentum
    if (!momentumFound) {
      const svg = document.querySelector('svg[class*="momentum"], svg[class*="Momentum"]');
      if (svg) {
        momentumFound = true;
        const paths = svg.querySelectorAll('path, rect, line');
        let hArea = 0, aArea = 0;
        paths.forEach(p => {
          const fill = p.getAttribute('fill') || '';
          const stroke = p.getAttribute('stroke') || '';
          if (fill.includes('home') || stroke.includes('home') || fill.match(/#[eE]0|red|#[cC]0/)) hArea++;
          else if (fill.includes('away') || stroke.includes('away') || fill.match(/#[0-9a-fA-F]{2}[eE]|blue/)) aArea++;
        });
        if (hArea + aArea > 0) {
          homeMom = Math.min(100, Math.round(hArea / (hArea + aArea) * 100));
          awayMom = Math.min(100, Math.round(aArea / (hArea + aArea) * 100));
        }
      }
    }

    // Calcular tendencia (ultimos 15 min)
    // Sin acceso al detalle por minuto, usamos el momentum total como proxy
    last15Home = homeMom;
    last15Away = awayMom;

    const trend = homeMom > awayMom + 15 ? 'home' : awayMom > homeMom + 15 ? 'away' : 'neutral';
    const momentumDiff = Math.abs(homeMom - awayMom);
    const dominantSide = homeMom > awayMom ? 'home' : 'away';

    return {
      homeMomentum: homeMom,
      awayMomentum: awayMom,
      last15Home,
      last15Away,
      trend,
      momentumDiff,
      dominantSide,
      momentumFound
    };
  });
}

/**
 * Fetch full match stats from Flashscore for specific targets.
 * Much faster than fetchAllLiveMatches - only opens detail pages for requested matches.
 * @param {Array} targets - Array of {teamHome, teamAway, matchId, minute} objects
 * @returns {Object} Map of matchId -> { stats, homeTeam, awayTeam, scoreHome, scoreAway, minute }
 */
async function fetchStatsBatch(targets) {
  if (!targets || targets.length === 0) return {};

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({
    locale: 'es-CO',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });

  // 1. Get all match links from live page
  const allLinks = await getLiveMatchLinks(page);
  console.log('  [FS] ' + allLinks.length + ' links en Flashscore');

  // 2. Match targets to links
  const results = {};
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const target of targets) {
    const hNorm = normalize(target.teamHome);
    const aNorm = normalize(target.teamAway);
    const key = target.matchId || (target.teamHome + ' vs ' + target.teamAway);

    const link = allLinks.find(l => {
      const lh = normalize(l.homeTeam);
      const la = normalize(l.awayTeam);
      return (lh.includes(hNorm) || hNorm.includes(lh)) && (la.includes(aNorm) || aNorm.includes(la));
    });

    if (!link) {
      console.log('  [FS] No link for ' + target.teamHome + ' vs ' + target.teamAway);
      results[key] = null;
      continue;
    }

    // 3. Use a fresh tab per match to avoid SPA stale data
    const tab = await context.newPage();
    await tab.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
    try {
      const stats = await extractMatchStats(tab, link.href);
      results[key] = stats;
      console.log('  [FS] Stats for ' + target.teamHome + ' vs ' + target.teamAway + ': minute=' + stats.minute + ' score=' + (stats.scoreHome ?? '?') + '-' + (stats.scoreAway ?? '?'));
    } catch (e) {
      console.log('  [FS] Error for ' + target.teamHome + ' vs ' + target.teamAway + ': ' + e.message);
      results[key] = null;
    } finally {
      await tab.close();
    }
  }

  await browser.close();
  return results;
}

module.exports = { fetchXgBatch, fetchStatsBatch, extractMatchMomentum };
