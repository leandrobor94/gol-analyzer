const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, locale: 'es-ES' });

  // Go to main page and click En Vivo
  await page.goto('https://www.sofascore.com/es', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Try clicking En Vivo button
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(b => ({
      text: b.innerText?.trim()?.slice(0, 50),
      testid: b.getAttribute('data-testid') || '',
      classes: b.className?.toString()?.slice(0, 60) || ''
    })).filter(b => b.text);
  });
  console.log('Available buttons:');
  buttons.forEach((b, i) => console.log(`  ${i}: "${b.text}" testid="${b.testid}"`));

  // Find the "En Vivo" button specifically
  const liveBtn = page.getByTestId('tab-live');
  if (await liveBtn.count() > 0) {
    console.log('\nFound tab-live button, clicking...');
    await liveBtn.click();
    await page.waitForTimeout(3000);
    console.log('Clicked!');
  } else {
    console.log('\nNo tab-live found, trying text match...');
    const btn = page.locator('button').filter({ hasText: /En Vivo/i }).first();
    console.log('Button exists:', await btn.count());
    if (await btn.count() > 0) {
      console.log('Button text:', await btn.textContent());
      await btn.click();
      await page.waitForTimeout(3000);
      console.log('Clicked by text!');
    }
  }

  // Check current URL
  console.log('Current URL:', page.url());

  // Get all matches visible now
  const matches = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/football/match/"]');
    const seen = new Set();
    return Array.from(links)
      .map(a => ({ href: a.href, text: a.innerText?.trim()?.replace(/\s+/g, ' ')?.slice(0, 120) }))
      .filter(l => l.href && !seen.has(l.href) && seen.add(l.href) && !l.href.includes('tournament'))
      .slice(0, 20);
  });
  console.log('\nMatches after filter:');
  matches.forEach((m, i) => console.log(`  ${i}: "${m.text}"`));

  await browser.close();
})();
