/**
 * _latencia.js — ¿tarda la casa en repreciar tras un gol?
 *
 * Es la hipotesis del dueño y la unica que nunca se ha medido. Es distinta a
 * todo lo demas del proyecto: no exige predecir nada. Si el precio tarda en
 * moverse, el margen es de CARRERA — ver el gol antes de que corrijan.
 *
 * DATOS: snapshots.jsonl guarda desde el 8 de agosto, en cada captura,
 * el marcador (g) y la cuota 1X2 con su hora (o). Con la serie de un mismo
 * partido se puede localizar la captura donde cambia el marcador y mirar si la
 * cuota ya se habia movido en esa misma captura o si tardo.
 *
 * QUE SE MIDE, EXACTAMENTE
 *
 * Para cada par de capturas consecutivas del mismo partido donde el marcador
 * cambia, se compara la cuota ANTES y DESPUES. Un gol cambia mucho la
 * probabilidad de 1X2, asi que la cuota DEBE moverse. Si no se movio, o el feed
 * de cuotas viene retrasado o la casa no ha repreciado. Las dos cosas serian
 * explotables, pero solo si el retraso dura mas que el intervalo del ciclo.
 *
 * LIMITE QUE HAY QUE DECIR ANTES DE MIRAR: el ciclo corre cada 10 minutos, asi
 * que la resolucion es de 10 minutos. Esto puede DETECTAR un retraso grande;
 * no puede medir retrasos de segundos, que es donde vive el arbitraje real.
 */
const fs = require('fs');

const pct = (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : '-');

(async () => {
  const L = fs.readFileSync('snapshots.jsonl', 'utf8').trim().split('\n');
  const rows = [];
  for (const l of L) {
    try {
      const j = JSON.parse(l);
      if (j.o && j.g != null && j.ts) rows.push(j);
    } catch {}
  }
  console.log('capturas con cuota y marcador:', rows.length);

  const porPartido = {};
  for (const r of rows) (porPartido[r.id] = porPartido[r.id] || []).push(r);
  for (const k of Object.keys(porPartido)) porPartido[k].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const conVarias = Object.values(porPartido).filter(v => v.length >= 2);
  console.log('partidos con >=2 capturas:', conVarias.length);

  // ── Pares consecutivos ──
  const pares = [];
  for (const serie of conVarias) {
    for (let i = 1; i < serie.length; i++) {
      const a = serie[i - 1], b = serie[i];
      const min = (new Date(b.ts) - new Date(a.ts)) / 60000;
      if (!(min > 0 && min < 45)) continue;   // capturas de la misma sesion
      pares.push({
        golNuevo: b.g > a.g,
        deltaMin: min,
        antes: a.o, despues: b.o,
        minuto: b.minute,
      });
    }
  }
  console.log('pares de capturas consecutivas:', pares.length);
  console.log('  separacion media: ' + (pares.reduce((s, p) => s + p.deltaMin, 0) / pares.length).toFixed(1) + ' min');

  const cambio = (x, y) => {
    if (!x || !y) return null;
    const d = ['h', 'd', 'a'].map(k => Math.abs((y[k] || 0) - (x[k] || 0)));
    return Math.max(...d);
  };
  const movio = (p, umbral = 0.02) => {
    const c = cambio(p.antes, p.despues);
    return c == null ? null : c > umbral;
  };

  const conGol = pares.filter(p => p.golNuevo);
  const sinGol = pares.filter(p => !p.golNuevo);
  console.log('');
  console.log('=== ¿SE MUEVE LA CUOTA CUANDO CAE UN GOL? ===');
  console.log('  pares CON gol nuevo   :', conGol.length);
  console.log('  pares SIN gol         :', sinGol.length);
  if (conGol.length < 10) { console.log('  muestra insuficiente para concluir'); return; }

  const movGol = conGol.filter(p => movio(p) === true).length;
  const movSin = sinGol.filter(p => movio(p) === true).length;
  console.log('');
  console.log('  tras un GOL, la cuota se movio en ' + movGol + '/' + conGol.length + '  (' + pct(movGol, conGol.length) + ')');
  console.log('  sin gol,     la cuota se movio en ' + movSin + '/' + sinGol.length + '  (' + pct(movSin, sinGol.length) + ')');
  console.log('');
  const quietas = conGol.filter(p => movio(p) === false);
  console.log('  CUOTAS QUE NO SE MOVIERON PESE AL GOL: ' + quietas.length + ' (' + pct(quietas.length, conGol.length) + ')');
  console.log('  -> son los casos donde podria haber ventana. Si es ~0%, no hay hipotesis.');

  if (quietas.length) {
    console.log('');
    console.log('  ejemplos (cuota local antes -> despues, minuto, separacion):');
    for (const q of quietas.slice(0, 6)) {
      console.log('    min ' + String(q.minuto).padStart(2) + '  ' +
        (q.antes.h || '?') + ' -> ' + (q.despues.h || '?') + '   (' + q.deltaMin.toFixed(0) + ' min entre capturas)');
    }
  }

  // ── Magnitud del movimiento ──
  const magGol = conGol.map(p => cambio(p.antes, p.despues)).filter(v => v != null).sort((a, b) => a - b);
  const magSin = sinGol.map(p => cambio(p.antes, p.despues)).filter(v => v != null).sort((a, b) => a - b);
  const med = a => (a.length ? a[Math.floor(a.length / 2)] : 0);
  console.log('');
  console.log('=== MAGNITUD DEL MOVIMIENTO (mediana del mayor cambio entre 1/X/2) ===');
  console.log('  tras un gol: ' + med(magGol).toFixed(3));
  console.log('  sin gol    : ' + med(magSin).toFixed(3));
  console.log('  -> si son parecidas, el movimiento tras el gol no destaca del ruido normal');
})();
