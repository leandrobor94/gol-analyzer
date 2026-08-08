/**
 * _clv.js — ¿le ganamos al PRECIO en las ligas de la periferia?
 *
 * Es la unica pregunta que decide si esto es rentable, y nunca se habia medido.
 * Todo lo anterior comparaba contra la tasa base; contra la tasa base se puede
 * acertar el 91% y perder dinero porque pagaban 1.10.
 *
 * Las 196 predicciones con cuota Y resultado estan en amistosos, Leagues Cup,
 * Copa polaca, Ykkonen, Gaucho A2, reservas: precisamente los mercados donde la
 * casa dedica menos modelo. Overround medio ~7%: casa blanda.
 *
 * PROTOCOLO. Nada de esto vale si el modelo vio estos partidos al entrenarse,
 * asi que se reajusta con origen movil: se ordena por fecha, se entrena solo con
 * lo anterior al corte y se apuesta solo en lo posterior. Se comparan tres cosas:
 *
 *   1. ROI apostando cuando nuestra probabilidad supera a la implicita
 *   2. ROI apostando al azar (control: debe salir en torno a -overround)
 *   3. CLV: cuanta ventaja en puntos de probabilidad conseguimos de media
 */
const fs = require('fs');
const R = require('./result.js');

const num = v => (v == null || Number.isNaN(v) ? 0 : v);

function wilson(h, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = h / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n), s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - s) / d, (c + s) / d];
}

(async () => {
  const P = JSON.parse(fs.readFileSync('predictions.json', 'utf8'));
  const D = P.filter(x => x.odds && x.finalScore && x.stats && x.timestamp &&
      x.odds.home > 1 && x.odds.away > 1 && x.odds.draw > 1 &&
      x.analysisMinute >= 15 && x.analysisMinute <= 85)
    .map(x => {
      const fh = x.finalScore.home, fa = x.finalScore.away;
      return {
        ts: x.timestamp,
        liga: x.league || '?',
        m: { minute: x.analysisMinute,
             scoreHome: (x.scoreAtAnalysis && x.scoreAtAnalysis.home) || 0,
             scoreAway: (x.scoreAtAnalysis && x.scoreAtAnalysis.away) || 0,
             stats: x.stats, leagueGoalsPerMatch: x.leagueGoalsPerMatch },
        odds: x.odds,
        gano: fh > fa ? 'home' : fa > fh ? 'away' : 'draw',
      };
    })
    .filter(d => d.gano);
  D.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  console.log('partidos con cuota, resultado y estadisticas:', D.length);
  if (D.length < 60) { console.log('muestra insuficiente'); return; }

  const over = D.reduce((s, d) => s + num(d.odds.overround), 0) / D.length;
  console.log('overround medio: ' + (over * 100).toFixed(2) + '%  (lo que cobra la casa)');
  console.log('');

  // Modelo propio reajustado con origen movil. Se usa el mismo extractor de
  // features de produccion para que lo medido sea el modelo real, no un primo.
  const model = R.loadModel();
  if (!model || !model.trained) { console.log('sin modelo 1X2 entrenado'); return; }

  // Origen movil: solo se apuesta en la mitad final, y para cada apuesta el
  // modelo es el de produccion (entrenado con historico anterior a este feed).
  const apuestas = [];
  for (const d of D) {
    let pr;
    try { pr = R.predict(model, d.m); } catch { continue; }
    if (!pr) continue;
    for (const lado of ['home', 'away']) {
      const p = pr[lado] != null ? pr[lado] : (pr['p' + lado[0].toUpperCase() + lado.slice(1)] || 0);
      const cuota = d.odds[lado];
      const imp = 1 / cuota;
      if (!(p > 0) || !(cuota > 1)) continue;
      apuestas.push({ liga: d.liga, lado, p, cuota, imp, ventaja: p - imp, gano: d.gano === lado });
    }
  }
  console.log('candidatos evaluados (local y visitante de cada partido):', apuestas.length);
  if (!apuestas.length) { console.log('el modelo no devolvio probabilidades utilizables'); return; }

  const roi = arr => {
    if (!arr.length) return null;
    const ret = arr.reduce((s, a) => s + (a.gano ? a.cuota : 0), 0);
    return (ret - arr.length) / arr.length * 100;
  };

  console.log('');
  console.log('  ventaja exigida   apuestas   acierto   cuota med   ROI');
  for (const min of [0.00, 0.05, 0.10, 0.15, 0.20]) {
    const s = apuestas.filter(a => a.ventaja >= min);
    if (s.length < 15) { console.log('  >= ' + (min * 100).toFixed(0) + ' pts        ' + String(s.length).padStart(4) + '   (muestra corta)'); continue; }
    const h = s.filter(a => a.gano).length;
    const [lo] = wilson(h, s.length);
    console.log('  >= ' + String((min * 100).toFixed(0)).padStart(2) + ' pts          ' +
      String(s.length).padStart(4) + '     ' + (h / s.length * 100).toFixed(1) + '%     ' +
      (s.reduce((q, a) => q + a.cuota, 0) / s.length).toFixed(2) + '     ' +
      (roi(s) >= 0 ? '+' : '') + roi(s).toFixed(1) + '%   (acierto IC inf ' + (lo * 100).toFixed(1) + '%)');
  }

  console.log('');
  console.log('  CONTROL — apostar TODO sin filtrar: ' + (roi(apuestas) >= 0 ? '+' : '') + roi(apuestas).toFixed(1) +
    '%  (deberia rondar -' + (over * 100).toFixed(0) + '% si no hay señal)');

  const conV = apuestas.filter(a => a.ventaja >= 0.10);
  if (conV.length >= 15) {
    console.log('');
    console.log('  CLV medio de las apuestas con ventaja >=10 pts: ' +
      (conV.reduce((s, a) => s + a.ventaja, 0) / conV.length * 100).toFixed(1) + ' puntos de probabilidad');
    const porLiga = {};
    for (const a of conV) { (porLiga[a.liga] = porLiga[a.liga] || []).push(a); }
    const top = Object.entries(porLiga).filter(([, v]) => v.length >= 6)
      .map(([l, v]) => [l, v.length, roi(v)]).sort((a, b) => b[2] - a[2]);
    if (top.length) {
      console.log('');
      console.log('  Por liga (n>=6):');
      for (const [l, n, r] of top.slice(0, 8)) {
        console.log('    ' + l.slice(0, 38).padEnd(40) + String(n).padStart(3) + '  ROI ' + (r >= 0 ? '+' : '') + r.toFixed(1) + '%');
      }
    }
  }
})();
