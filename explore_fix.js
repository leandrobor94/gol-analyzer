const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, locale: 'es-ES' });

  await page.goto('https://www.sofascore.com/es', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Find all "En Vivo" buttons and their visibility
  const info = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter(b => b.innerText.includes('En Vivo'));
    return btns.map((b, i) => ({
      index: i,
      text: b.innerText?.trim(),
      visible: b.offsetParent !== null,
      rect: b.getBoundingClientRect(),
      class: b.className?.toString()?.slice(0, 100),
      parent: b.parentElement?.className?.toString()?.slice(0, 80)
    }));
  });
  console.log('En Vivo buttons:');
  info.forEach((b, i) => console.log(`  ${i}: visible=${b.visible} rect=${JSON.stringify(b.rect)} class=${b.class} parent=${b.parent}`));

  // Try clicking with force
  if (info.length > 0) {
    // Find the visible one
    const visible = info.find(b => b.visible);
    if (visible) {
      console.log('\nClicking visible En Vivo button...');
      const btns = page.locator('button').filter({ hasText: /En Vivo/i });
      const count = await btns.count();
      console.log(`Found ${count} buttons`);
      for (let i = 0; i < count; i++) {
        const btn = btns.nth(i);
        const visible2 = await btn.isVisible();
        console.log(`  Button ${i}: visible=${visible2}`);
        if (visible2) {
          await btn.click();
          console.log(`  Clicked button ${i}!`);
          await page.waitForTimeout(3000);
          break;
        }
      }
    }
  }

  console.log('\nURL after click:', page.url());

  // Check for live indicators
  const liveIndicators = await page.evaluate(() => {
    const text = document.body.innerText;
    const lines = text.split('\n').filter(l => l.includes("'") && /\d+/.test(l));
    return lines.slice(0, 30);
  });
  console.log('\nLines with minute indicators (live matches):');
  liveIndicators.forEach((l, i) => console.log(`  ${i}: "${l.trim().slice(0, 100)}"`));

  // Get matches with live status
  const liveMatches = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/football/match/"]');
    const seen = new Set();
    return Array.from(links)
      .map(a => ({ href: a.href, text: a.innerText?.trim()?.replace(/\s+/g, ' ') }))
      .filter(l => l.href && !seen.has(l.href) && seen.add(l.href) && !l.href.includes('tournament'))
      .filter(l => /\d+['′]/.test(l.text))
      .slice(0, 15);
  });
  console.log(`\nLive matches (${liveMatches.length}):`);
  liveMatches.forEach((m, i) => console.log(`  ${i}: "${m.text}"`));

  await browser.close();
})();
