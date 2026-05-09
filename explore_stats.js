const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  await page.goto('https://www.sofascore.com/es/football/match/lazio-inter/XdbsZdb#id:13980089', { 
    waitUntil: 'domcontentloaded', timeout: 30000 
  });
  await page.waitForTimeout(4000);

  // Click "Estadísticas" tab
  const statsTab = page.locator('button', { hasText: 'Estadísticas' });
  if (await statsTab.count() > 0) {
    await statsTab.click();
    await page.waitForTimeout(2000);
    console.log('Clicked Estadísticas tab');
  } else {
    console.log('Estadísticas tab not found');
    // Try any tab that might contain stats
    const tabs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button')).map(b => b.innerText?.trim()).filter(t => t);
    });
    console.log('Available tabs:', tabs);
  }

  await page.screenshot({ path: 'stats_screenshot.png', fullPage: true });

  // Get all visible text
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('\nPage text:\n', bodyText?.slice(0, 8000));

  // Get stat values specifically
  const statValues = await page.evaluate(() => {
    const all = document.querySelectorAll('div, span, p, strong');
    const statTexts = [];
    for (const el of all) {
      const text = el.innerText?.trim();
      if (text && /^\d+%?$/.test(text) && el.offsetParent !== null) {
        statTexts.push(text);
      }
    }
    return statTexts.slice(0, 100);
  });
  console.log('\nStat-like values:', statValues);

  await browser.close();
})();
