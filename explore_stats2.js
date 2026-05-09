const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  await page.goto('https://www.sofascore.com/es/football/match/lazio-inter/XdbsZdb#id:13980089', { 
    waitUntil: 'domcontentloaded', timeout: 30000 
  });
  await page.waitForTimeout(4000);

  // Click main statistics tab by test ID
  const statsTab = page.getByTestId('tab-statistics');
  if (await statsTab.count() > 0) {
    await statsTab.click();
    await page.waitForTimeout(2000);
    console.log('Clicked main statistics tab');
  } else {
    console.log('Main statistics tab not found');
  }

  await page.screenshot({ path: 'stats2.png', fullPage: true });

  const stats = await page.evaluate(() => {
    const statContainers = document.querySelectorAll('[class*="stat"], [class*="Stat"], [data-testid*="stat"]');
    const results = [];
    for (const el of statContainers) {
      const text = el.innerText?.trim();
      const cls = el.className?.toString()?.slice(0, 80) || '';
      const testId = el.getAttribute('data-testid') || '';
      if (text && text.length < 200) {
        results.push({ text, class: cls, testId });
      }
    }
    return results.slice(0, 100);
  });
  console.log('\nStat containers:');
  stats.forEach((s, i) => console.log(`${i}: [${s.testId}] "${s.text}"`));

  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('\nFull page body:\n', bodyText?.slice(3000, 10000));

  await browser.close();
})();
