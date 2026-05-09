const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, locale: 'es-ES' });

  // Go to SofaScore
  await page.goto('https://www.sofascore.com/es', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Click En Vivo
  const btns = page.locator('button').filter({ hasText: /En Vivo/i });
  const count = await btns.count();
  for (let i = 0; i < count; i++) {
    if (await btns.nth(i).isVisible()) {
      await btns.nth(i).click();
      console.log('Clicked En Vivo');
      await page.waitForTimeout(3000);
      break;
    }
  }

  // Get live match URLs
  const liveMatches = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/football/match/"]');
    const seen = new Set();
    return Array.from(links)
      .map(a => ({ href: a.href, text: a.innerText?.trim()?.replace(/\s+/g, ' ') }))
      .filter(l => l.href && !seen.has(l.href) && seen.add(l.href) && !l.href.includes('tournament'))
      .filter(l => /\d+['′]/.test(l.text))
      .slice(0, 5);
  });

  console.log(`Found ${liveMatches.length} live matches`);
  liveMatches.forEach((m, i) => console.log(`${i}: ${m.text} -> ${m.href}`));

  if (liveMatches.length > 0) {
    // Navigate to first live match
    console.log(`\nNavigating to: ${liveMatches[0].href}`);
    await page.goto(liveMatches[0].href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    console.log('Page loaded. URL:', page.url());
    console.log('Title:', await page.title());

    // First get all visible text
    const pageText = await page.evaluate(() => document.body.innerText);
    const textLines = pageText.split('\n').filter(l => l.trim()).slice(0, 100);
    console.log('\n=== All text lines (first 100) ===');
    textLines.forEach((l, i) => console.log(`${i}: "${l.slice(0, 130)}"`));

    // Click Estadísticas tab
    console.log('\n=== Looking for Estadísticas tab ===');
    
    // List all tabs
    const allTabs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[role="tab"], button')).map(b => ({
        text: b.innerText?.trim()?.slice(0, 50),
        testid: b.getAttribute('data-testid') || '',
        ariaLabel: b.getAttribute('aria-label') || '',
        id: b.id,
        class: b.className?.toString()?.slice(0, 60)
      })).filter(b => b.text);
    });
    console.log('Available tabs/buttons:');
    allTabs.forEach((t, i) => console.log(`  ${i}: "${t.text}" testid="${t.testid}"`));

    // Try different strategies to find the stats tab
    const statsCell = page.getByTestId('tab-statistics');
    console.log('\ntab-statistics exists:', await statsCell.count());
    
    // Also try tab-1 (usually statistics is the second tab after lineups)
    const tab1 = page.getByTestId('tab-1');
    console.log('tab-1 exists:', await tab1.count());
    
    // Get all elements with role="tab"
    const tabs = page.getByRole('tab');
    console.log('Tabs count:', await tabs.count());
    for (let i = 0; i < await tabs.count(); i++) {
      console.log(`  Tab ${i}: "${await tabs.nth(i).textContent()}" enabled=${await tabs.nth(i).isEnabled()}`);
    }
  }

  await browser.close();
})();
