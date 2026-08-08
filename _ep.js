const https = require('https');
const PA = 'appTypeId=5&langId=14&timezoneName=America/Bogota&userCountryId=109';

function get(u) {
  return new Promise(ok => {
    https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => ok({ s: r.statusCode, b }));
    }).on('error', () => ok({ s: 0, b: '' }));
  });
}

(async () => {
  const TID = 1081; // equipo de Copa de Rusia: competicion SIN tabla
  const rutas = [
    '/web/games/results/?' + PA + '&competitors=' + TID,
    '/web/games/fixtures/?' + PA + '&competitors=' + TID,
    '/web/games/allscores/?' + PA + '&competitors=' + TID,
    '/web/competitions/?' + PA + '&competitors=' + TID,
    '/web/competitor/?' + PA + '&competitor=' + TID,
  ];
  for (const r of rutas) {
    const { s, b } = await get('https://webws.365scores.com' + r);
    let info = '';
    try {
      const j = JSON.parse(b);
      const g = j.games || j.results || [];
      info = b.length + 'b claves:' + Object.keys(j).slice(0, 7).join(',') + (g.length ? '  GAMES=' + g.length : '');
      if (g.length) {
        const e = g[0];
        info += '  ej: ' + (e.homeCompetitor && e.homeCompetitor.name) + ' ' +
          (e.homeCompetitor && e.homeCompetitor.score) + '-' + (e.awayCompetitor && e.awayCompetitor.score) +
          ' ' + (e.awayCompetitor && e.awayCompetitor.name) + ' [' + String(e.startTime || '').slice(0, 10) + ']';
      }
    } catch { info = 'no-json: ' + b.slice(0, 70).replace(/\s+/g, ' '); }
    console.log(r.split('?')[0].padEnd(26) + ' HTTP ' + s + ' ' + info.slice(0, 185));
    await new Promise(x => setTimeout(x, 250));
  }
})();
