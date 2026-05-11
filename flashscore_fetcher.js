const { chromium } = require('playwright');

async function getLiveMatchLinks(page) {
  await page.goto('https://www.flashscore.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  const debug = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('a[href*="/match/"]'));
    const seen = new Set();
    const results = [];
    items.forEach(a => {
      const href = a.href.split('?')[0];
      if (!seen.has(href)) {
        seen.add(href);
        const parent = a.closest('[class*="match"]');
        const parentText = parent ? parent.innerText : a.innerText;
        const teamLinks = parent ? Array.from(parent.querySelectorAll('a[href*="/team/"]')) : [];
        const text = parentText?.replace(/\s+/g, ' ')?.trim();
        results.push({
          href: href,
          text: text,
          homeTeam: teamLinks[0]?.textContent?.trim() || '',
          awayTeam: teamLinks[1]?.textContent?.trim() || ''
        });
      }
    });
    const filtered = results.filter(r => /\d+[''\u2019]/.test(r.text) || r.text?.includes('Half Time'));
    return { results, filtered, samples: results.slice(0, 8).map(r => r.text) };
  });
  console.log('  Debug: ' + debug.results.length + ' items encontrados, ' + debug.filtered.length + ' pasaron el filtro');
  console.log('  Primeros textos:\n' + debug.samples.map((t, i) => '    [' + i + '] ' + t).join('\n'));

  // Live matches: empiezan con minuto 1-120 y tienen marcador numerico
  const liveMatches = debug.results.filter(r => {
    if (!r.text) return false;
    // Terminado o futuro -> no
    if (/^Finished/i.test(r.text)) return false;
    if (/^\d{1,2}:\d{2}\s/.test(r.text)) return false;
    // Empieza con minuto (1-180) seguido de espacio?
    if (!/^\d{1,3}\s/.test(r.text)) return false;
    // Tiene marcador numerico (no "- -")?
    const scoreMatch = r.text.match(/(\d+)\s+(\d+)$/);
    if (!scoreMatch) return false;
    // El primer numero no debe ser hora (debe ser < 24 o el texto no tiene :)
    const firstToken = parseInt(r.text.match(/^(\d+)/)[1]);
    if (firstToken > 0) return true;
    return false;
  });
  if (liveMatches.length > 0) {
    console.log('  -> Detectados ' + liveMatches.length + ' en vivo');
    return liveMatches;
  }
  if (debug.filtered.length > 0) return debug.filtered;
  console.log('  Flashscore cambio formato — intentando sin filtro');
  return debug.results;
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

    // Extract score and minute from page text
    const bodyText = document.body.innerText;
    let scoreHome = null, scoreAway = null, minute = null, status = '';

    // Look for patterns like: "TeamName 1 - 0 HALF TIME" or "TeamName 2 - 1 70'"
    // The score is usually near the team names
    const scoreMatch = bodyText.match(/(\d+)\s*-\s*(\d+)/);
    if (scoreMatch) {
      scoreHome = parseInt(scoreMatch[1]);
      scoreAway = parseInt(scoreMatch[2]);
    }

    // Find minute: look for patterns like "70'" or "HALF TIME" or "Half Time"
    const minuteMatch = bodyText.match(/(\d+)[''\u2019]/);
    if (minuteMatch) {
      minute = parseInt(minuteMatch[1]);
      status = minute + "'";
    }
    if (bodyText.includes('HALF TIME') || bodyText.includes('Half Time')) {
      if (!minute) { minute = 45; status = 'HT'; }
      else { status = 'HT'; }
    }

    return { stats, homeTeam, awayTeam, scoreHome, scoreAway, minute, status };
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
      results.push({
        homeTeam: result.homeTeam || match.homeTeam,
        awayTeam: result.awayTeam || match.awayTeam,
        scoreHome: result.scoreHome,
        scoreAway: result.scoreAway,
        minute: result.minute || 0,
        status: result.status || '',
        url: match.href,
        stats: result.stats
      });
    } catch (err) {
      console.log('Error on ' + match.text?.slice(0, 40) + ': ' + err.message);
    }
  }

  await browser.close();
  return results;
}

module.exports = { fetchAllLiveMatches };

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
