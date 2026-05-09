const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  // Go to a live match (Lecce vs Juventus was 89')
  await page.goto('https://www.sofascore.com/es/football/match/lecce-juventus/XdbsZdb#id:13980089', { 
    waitUntil: 'domcontentloaded', timeout: 30000 
  });
  await page.waitForTimeout(5000);

  await page.screenshot({ path: 'match_screenshot.png', fullPage: true });
  console.log('Match page title:', await page.title());
  console.log('Match page URL:', page.url());

  // Get all visible text
  const bodyText = await page.evaluate(() => document.body.innerText?.slice(0, 5000));
  console.log('\nBody text (first 5000 chars):\n', bodyText);

  // Look for stats sections
  const statElements = await page.evaluate(() => {
    const stats = document.querySelectorAll('[class*="stat"], [class*="Stat"], [class*="Stat"], [data-testid*="stat"]');
    return Array.from(stats).slice(0, 50).map(el => ({
      text: el.innerText?.trim()?.slice(0, 100),
      class: el.className?.slice(0, 80),
      id: el.id
    }));
  });
  console.log('\nStat elements:');
  statElements.forEach((s, i) => console.log(`${i}: "${s.text}" class="${s.class}" id="${s.id}"`));

  // Look for the statistics tab or section
  const tabs = await page.evaluate(() => {
    const allTabs = document.querySelectorAll('button, a, [role="tab"], [role="button"]');
    return Array.from(allTabs).slice(0, 80).map(el => ({
      text: el.innerText?.trim()?.slice(0, 80),
      class: el.className?.slice(0, 60)
    }));
  });
  console.log('\nTabs/buttons:');
  tabs.forEach((t, i) => console.log(`${i}: "${t.text}" class="${t.class}"`));

  await browser.close();
})();
