const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, locale: 'es-ES' });

  // Go to a currently live match
  await page.goto('https://www.sofascore.com/es/football/match/real-sociedad-real-betis/oucxskc#id:14023960', { 
    waitUntil: 'domcontentloaded', timeout: 30000 
  });
  await page.waitForTimeout(4000);

  // Get current page text
  console.log('=== PAGE TEXT (first sections) ===');
  const text = await page.evaluate(() => document.body.innerText);
  const lines = text.split('\n').filter(l => l.trim()).slice(0, 80);
  lines.forEach((l, i) => console.log(`${i}: "${l.slice(0, 120)}"`));

  // Click Estadísticas tab
  console.log('\n=== CLICKING ESTADÍSTICAS TAB ===');
  const statsTab = page.getByTestId('tab-statistics');
  if (await statsTab.count() > 0) {
    await statsTab.click();
    await page.waitForTimeout(2000);
    console.log('Clicked!');
  } else {
    console.log('tab-statistics not found');
  }

  // Get the stats panel content
  console.log('\n=== STATS PANEL HTML SAMPLES ===');
  const statsHtml = await page.evaluate(() => {
    const panel = document.querySelector('[id="tabpanel-statistics"], [aria-labelledby="tab-statistics"]');
    if (!panel) return 'No stats panel found';
    
    const statItems = panel.querySelectorAll('div[class*="stat"], div[class*="Stat"]');
    if (statItems.length === 0) {
      // Get all direct children
      return Array.from(panel.children).slice(0, 20).map(el => ({
        tag: el.tagName,
        text: el.innerText?.trim()?.slice(0, 100),
        class: el.className?.toString()?.slice(0, 80)
      }));
    }
    return Array.from(statItems).slice(0, 30).map(el => ({
      text: el.innerText?.trim()?.slice(0, 100),
      class: el.className?.toString()?.slice(0, 80),
      html: el.innerHTML?.slice(0, 200)
    }));
  });
  console.log(JSON.stringify(statsHtml, null, 2));

  // Get all visible text after clicking stats
  console.log('\n=== TEXT AFTER STATS CLICK ===');
  const text2 = await page.evaluate(() => {
    const t = document.body.innerText;
    const sections = t.split('\n').filter(l => l.trim());
    // Find the stats section - look between "Estadísticas" and next major section
    const startIdx = sections.findIndex(l => /estad[ií]sticas/i.test(l) && !/jugador/i.test(l));
    return sections.slice(Math.max(0, startIdx), startIdx + 60);
  });
  text2.forEach((l, i) => console.log(`${i}: "${l.slice(0, 120)}"`));

  await browser.close();
})();
