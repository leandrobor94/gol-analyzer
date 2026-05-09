const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  await page.goto('https://www.sofascore.com/es', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);

  // Screenshot of the full page
  await page.screenshot({ path: 'screenshot.png', fullPage: true });

  // Get the page title and main content
  const title = await page.title();
  console.log('Page title:', title);
  console.log('URL:', page.url());

  // List all links/buttons visible
  const links = await page.evaluate(() => {
    const all = document.querySelectorAll('a, button, [role="button"]');
    return Array.from(all).slice(0, 100).map(el => ({
      tag: el.tagName,
      text: el.innerText?.trim()?.slice(0, 80),
      href: el.href || '',
      class: el.className?.slice(0, 60)
    }));
  });
  console.log('Visible links/buttons:');
  links.forEach((l, i) => console.log(`${i}: [${l.tag}] "${l.text}" href="${l.href}" class="${l.class}"`));

  // Check for live matches section
  const sections = await page.evaluate(() => {
    const divs = document.querySelectorAll('div[class*="live"], div[class*="Live"], section[class*="match"], div[class*="Match"]');
    return Array.from(divs).slice(0, 20).map(el => ({
      text: el.innerText?.trim()?.slice(0, 100),
      class: el.className?.slice(0, 80)
    }));
  });
  console.log('\nLive/Match sections:');
  sections.forEach((s, i) => console.log(`${i}: "${s.text}" class="${s.class}"`));

  // Get all visible text content
  const bodyText = await page.evaluate(() => document.body.innerText?.slice(0, 3000));
  console.log('\nBody text (first 3000 chars):\n', bodyText);

  // Wait a bit more for any dynamic content
  await page.waitForTimeout(3000);
  
  // Check if there are match cards
  const matchCards = await page.evaluate(() => {
    const cards = document.querySelectorAll('[class*="card"], [class*="Card"], [class*="match"], [class*="Match"]');
    return Array.from(cards).slice(0, 30).map(el => ({
      text: el.innerText?.trim()?.slice(0, 120),
      class: el.className?.slice(0, 80)
    }));
  });
  console.log('\nMatch cards:');
  matchCards.forEach((c, i) => console.log(`${i}: "${c.text}" class="${c.class}"`));

  await browser.close();
})();
