const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, locale: 'es-ES' });

  await page.goto('https://www.sofascore.com/es/football/match/real-sociedad-real-betis/qgbszgb#id:14083583', { 
    waitUntil: 'domcontentloaded', timeout: 30000 
  });
  await page.waitForTimeout(3000);

  // Click Estadísticas tab
  console.log('Clicking Estadísticas tab...');
  const tab = page.getByTestId('tab-statistics');
  await tab.click();
  await page.waitForTimeout(3000);
  console.log('Clicked!');

  // Get the stats panel text
  const statsText = await page.evaluate(() => {
    const panel = document.querySelector('#tabpanel-statistics');
    if (!panel) return 'No panel found with id tabpanel-statistics';
    return panel.innerText;
  });
  console.log('\n=== STATS PANEL TEXT ===');
  console.log(statsText);

  // Get HTML structure of stats panel
  const statsHtml = await page.evaluate(() => {
    const panel = document.querySelector('#tabpanel-statistics');
    if (!panel) return 'No panel';
    
    function getStructure(el, depth = 0) {
      if (depth > 3) return '';
      let result = '';
      const indent = '  '.repeat(depth);
      if (el.children.length === 0) {
        const text = el.innerText?.trim()?.slice(0, 60);
        if (text) result += `${indent}${el.tagName}: "${text}"\n`;
      } else {
        const cls = el.className?.toString()?.slice(0, 60) || '';
        const text = el.innerText?.trim()?.slice(0, 40);
        if (text || cls) {
          result += `${indent}${el.tagName} class="${cls}" text="${text}"\n`;
        }
        for (const child of el.children) {
          result += getStructure(child, depth + 1);
        }
      }
      return result;
    }
    return getStructure(panel);
  });
  console.log('\n=== STATS PANEL STRUCTURE ===');
  console.log(statsHtml);

  // Get all text after stats tab click
  const allText = await page.evaluate(() => {
    const t = document.body.innerText;
    const lines = t.split('\n').filter(l => l.trim());
    // Find "Estadísticas" heading
    const startIdx = lines.findIndex(l => l === 'Estadísticas' && lines.indexOf(l) !== lines.lastIndexOf(l));
    // Actually just show everything
    return lines;
  });
  console.log('\n=== ALL TEXT (looking for stat values) ===');
  // Show lines that contain numbers with decimals (like xG) or percentages
  const statLines = allText.filter(l => /^\d+\.?\d*\s*$/.test(l.trim()) || /^\d+%\s*$/.test(l.trim()) || /xG/i.test(l) || /remat/i.test(l) || /tiro/i.test(l) || /poses/i.test(l) || /córner/i.test(l) || /tarjet/i.test(l) || /falta/i.test(l));
  statLines.forEach((l, i) => console.log(`  ${i}: "${l}"`));

  await browser.close();
})();
