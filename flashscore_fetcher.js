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

async function extractMatchStats(page, matchUrl) {
  const statsUrl = matchUrl.replace(/\/$/, '') + '/summary/stats/';
  await page.goto(statsUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(5000);

  return await page.evaluate(() => {
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

    return { stats, homeTeam, awayTeam, scoreHome, scoreAway, minute, status, league };
  });
}

async function fetchAllLiveMatches() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({
    locale: 'es-CO',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });

  const matches = await getLiveMatchLinks(page);
  console.log('Live matches found: ' + matches.length);

  if (matches.length === 0) {
    await browser.close();
    return [];
  }

  const results = [];
  for (const match of matches) {
    try {
      const result = await extractMatchStats(page, match.href);
      // Minuto desde link text (mas fiable: "27 Ferro 1-0..." en homepage)
      const textMinute = (match.text?.match(/^(\d{1,3})\s/) || [])[1];
      const linkMinute = textMinute ? parseInt(textMinute) : null;
      // Usar link minute como primario, stats page solo si es razonable
      let minute = linkMinute || result.minute || 0;
      if (result.minute && linkMinute && Math.abs(result.minute - linkMinute) <= 5) {
        minute = result.minute; // stats page tiene dato mas actualizado
      }
      // Validacion basica: score imposible para el minuto
      if (minute <= 5) {
        const g = (result.scoreHome || 0) + (result.scoreAway || 0);
        if (g >= 3) { // 3+ goles en 5 min = dato corrupto
          console.log(`  Score sospechoso: ${result.scoreHome}-${result.scoreAway} en min ${minute}, ignorando score`);
          result.scoreHome = null; result.scoreAway = null;
        }
      }
      results.push({
        homeTeam: result.homeTeam || match.homeTeam,
        awayTeam: result.awayTeam || match.awayTeam,
        scoreHome: result.scoreHome,
        scoreAway: result.scoreAway,
        minute: minute,
        status: result.status || '',
        url: match.href,
        league: result.league || '',
        stats: result.stats
      });
    } catch (err) {
      console.log('Error on ' + match.text?.slice(0, 40) + ': ' + err.message);
    }
  }

  await browser.close();
  return results;
}

async function verifyFinishedMatch(page, matchUrl) {
  try {
    await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    return await page.evaluate(() => {
      const title = document.title;
      const titleScore = title.match(/(\d{1,2})\s*[-–:]\s*(\d{1,2})/);
      if (titleScore) { const h=+titleScore[1], a=+titleScore[2]; if (h<50&&a<50) return {home:h,away:a}; }
      const el = document.querySelector('[data-testid*="score"]') || document.querySelector('.detailScore__wrapper');
      if (el) { const m = el.textContent.trim().match(/(\d{1,2})\s*[-–:]\s*(\d{1,2})/); if (m) { const h=+m[1],a=+m[2]; if (h<50&&a<50) return {home:h,away:a}; } }
      const scores = [...document.body.innerText.matchAll(/(\d{1,2})\s*[-–]\s*(\d{1,2})/g)];
      for (const s of scores) { const h=+s[1],a=+s[2]; if (h<50&&a<50) return {home:h,away:a}; }
      return null;
    });
  } catch { return null; }
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
    
    // 3. Open the match page and extract xG
    try {
      await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);
      
      const xg = await page.evaluate(() => {
        const text = document.body.innerText;
        // xG usually appears as "Expected Goals (xG)" or "xG" with values
        const matchXg = text.match(/(?:Expected Goals|xG|Goles esperados)[^0-9]*(\d+\.?\d*)\s*[-–:]\s*(\d+\.?\d*)/i);
        if (matchXg) return { home: parseFloat(matchXg[1]), away: parseFloat(matchXg[2]) };
        // Try alternative format: two decimal numbers near "xG" text
        const xgBlocks = text.match(/xG[^0-9]*(\d+\.?\d*)[^0-9]*(\d+\.?\d*)/i);
        if (xgBlocks) return { home: parseFloat(xgBlocks[1]), away: parseFloat(xgBlocks[2]) };
        return null;
      });
      
      results[key] = xg;
      console.log('  [xG] ' + target.teamHome + ' vs ' + target.teamAway + ': ' + (xg ? xg.home + '-' + xg.away : 'no encontrado'));
    } catch (e) {
      console.log('  [xG] Error fetching ' + key + ': ' + e.message);
      results[key] = null;
    }
  }
  
  await browser.close();
  return results;
}

module.exports = { fetchAllLiveMatches, verifyFinishedMatch, fetchXgBatch, getLiveMatchLinks };

if (require.main === module) {
  fetchAllLiveMatches().then(results => {
    console.log('\nTotal matches: ' + results.length);
    results.forEach(m => {
      console.log('\n' + m.homeTeam + ' vs ' + m.awayTeam + ' | ' + (m.status || m.minute + "'") + ' | ' + (m.scoreHome ?? '?') + '-' + (m.scoreAway ?? '?'));
      const keys = ['Expected goals (xG)', 'Ball possession', 'Total shots', 'Shots on target', 'Big chances', 'Corner kicks'];
      keys.forEach(k => { if (m.stats[k]) console.log('  ' + k + ': ' + m.stats[k].home + ' | ' + m.stats[k].away); });
    });
  }).catch(console.error);
}
