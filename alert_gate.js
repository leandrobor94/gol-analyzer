/**
 * alert_gate.js — decide QUE se apuesta y SI se avisa.
 *
 * Dos ideas, las dos aprendidas por las malas:
 *
 * 1. La apuesta depende del momento del partido (model.phase).
 *    En el minuto 20 "habra gol en el partido" es un 95% que se paga a 1.05:
 *    correcto e inutil. Preguntando "gol antes del descanso" el horizonte se
 *    acorta y la cuota justa sube sola al rango que compensa el riesgo. Del 45
 *    al 70 se estrecha a UN equipo concreto por el mismo motivo.
 *
 * 2. Manda NUESTRO analisis; la cuota es el premio, no el juez.
 *    Son DOS condiciones distintas y ambas deben cumplirse:
 *      - conviccion nuestra alta       p >= minProb (70%)
 *      - premio de la casa suficiente  cuota >= minOdds (1.5)
 *
 *    Ojo con no confundir dos cuotas. La NUESTRA (1/p) mide conviccion: si
 *    decimos 80%, es 1.25. La de la CASA es lo que pagan. El minimo de 1.5 va
 *    sobre la segunda. Filtrar por la primera —error de diseño que hubo aqui—
 *    excluia mecanicamente todo analisis fuerte, justo lo contrario del objetivo.
 *
 *    Lo que se busca es un DESACUERDO: nosotros al 80%, la casa pagando 3.00.
 *    Si no hay cuota publicada (~60% de los partidos) se avisa igual con el
 *    precio minimo. Lo que NO se hace es estimar lo que paga la casa con
 *    nuestro propio modelo: seria compararlo consigo mismo y todo pareceria valor.
 */

const num = (v) => (v == null || Number.isNaN(v) ? 0 : v);

// Antes de este minuto nuestro lambda es basicamente el promedio de la liga:
// no hemos visto suficiente partido para saber mas que un modelo pre-partido.
const MIN_MINUTO_EV = 25;

function xgRemaining(stats, scoreHome, scoreAway) {
  const xg = num(stats && stats.xgHome) + num(stats && stats.xgAway);
  return xg - (num(scoreHome) + num(scoreAway));
}

function bigChances(stats) {
  return num(stats && stats.bigChancesHome) + num(stats && stats.bigChancesAway);
}

/**
 * Calidad 0-100. Solo ordena candidatos dentro de un mismo tier cuando hay que
 * recortar a los N mejores. No decide si se alerta — eso lo hace el tier.
 */
function alertQuality(r) {
  const p = r.probability != null ? r.probability : (r.score || 0) / 100;
  let q = 0;
  q += Math.max(0, Math.min(50, (p - 0.5) * 125));
  q += Math.max(0, Math.min(20, xgRemaining(r.stats, r.scoreHome, r.scoreAway) * 10));
  q += Math.max(0, Math.min(15, bigChances(r.stats) * 4));
  q += Math.max(0, Math.min(15, (r.prob15 || 0) * 40));
  return Math.round(q);
}

/**
 * EL GATE. Uno solo, por fase del partido, con la cuota como extra opcional.
 *
 * Que se apuesta depende del momento (model.phase):
 *   1T     -> gol antes del descanso
 *   2T     -> otro gol en lo que queda
 *   FINAL  -> gol en lo que queda
 *
 * Se elige la apuesta con MAYOR conviccion nuestra (p >= minProb). El minimo de
 * cuota se aplica a lo que paga LA CASA, no a nuestra cuota justa.
 *
 * La cuota de la casa NO hace falta para alertar:
 *   - si la hay    -> se exige cuota >= minOdds y EV >= minEv
 *   - si no la hay -> se da el precio minimo al que merece la pena
 *
 * @param {object} input { phase, lambda, split, teamHome, teamAway, minute,
 *                         informed, edge }   edge puede ser null
 */
function classifyBet(input, opts) {
  const minOdds = (opts && opts.minOdds) || 1.5;   // lo que debe pagar LA CASA
  const minProb = (opts && opts.minProb) || 0.70;  // conviccion minima NUESTRA
  const minEv = (opts && opts.minEv) || 0.05;
  const maxEdge = (opts && opts.maxEdge) || 0.50;   // solo lo absurdo
  const avisoEdge = (opts && opts.avisoEdge) || 0.25;  // a partir de aqui, se marca
  const margin = (opts && opts.margin) || 1.08;

  const ph = input.phase;
  const lambda = input.lambda;
  if (!(lambda > 0) || !ph) return { tier: 'REJECT', reason: 'sin modelo' };

  // Cada fase ofrece una o dos apuestas. Se evaluan y se elige la que cae en la
  // banda apostable; si ninguna cae, no se manda nada.
  const split = input.split || { home: 0.5, away: 0.5 };
  const favorito = split.home >= split.away ? 'home' : 'away';
  const cuotaTeam = split[favorito];
  const nombre = favorito === 'home' ? input.teamHome : input.teamAway;

  const opciones = [];
  for (const opt of ph.options) {
    if (opt === 'ANY') {
      opciones.push({
        kind: 'ANY',
        p: 1 - Math.exp(-lambda * ph.T),
        bet: ph.key === '1T' ? 'Gol antes del descanso' : 'Gol en lo que queda (cualquier equipo)',
      });
    } else {
      opciones.push({
        kind: 'TEAM',
        side: favorito,
        team: nombre,
        p: 1 - Math.exp(-lambda * cuotaTeam * ph.T),
        bet: 'Marca ' + (nombre || (favorito === 'home' ? 'el local' : 'el visitante')),
      });
    }
  }

  // ── Manda NUESTRO analisis ──
  //
  // Se elige la apuesta en la que MAS convencidos estamos. El minimo de cuota
  // (1.5) NO se aplica aqui: eso es lo que tiene que pagar la CASA, no un techo
  // a nuestra conviccion. Confundir las dos cuotas fue un error de diseño mio:
  // filtrar por nuestra cuota justa >= 1.5 excluia mecanicamente todo analisis
  // fuerte, que es justo lo contrario de lo que interesa.
  //
  // Lo que se busca es un DESACUERDO: nosotros altos, la casa pagando bien.
  const validas = opciones.filter(o => o.p >= minProb && o.p < 0.97);
  if (!validas.length) {
    const mejor = opciones.sort((a, b) => b.p - a.p)[0];
    return {
      tier: 'REJECT',
      reason: 'analisis ' + Math.round((mejor ? mejor.p : 0) * 100) + '% < ' + Math.round(minProb * 100) + '% (poca conviccion)',
    };
  }
  validas.sort((a, b) => b.p - a.p);
  const elegida = validas[0];
  const p = elegida.p;
  const fair = 1 / p;

  const base = {
    phase: ph.key,
    kind: elegida.kind,
    side: elegida.side || null,
    team: elegida.team || null,
    bet: elegida.bet,
    horizon: ph.T,
    p: Math.round(p * 1e4) / 1e4,
    fair: Math.round(fair * 100) / 100,
    // Precio minimo al que apostar. Es el mayor de: nuestra cuota justa con
    // margen, y el suelo que pide el usuario. Si decimos 80% (justa 1.25) pero
    // exiges 1.5, el aviso sigue valiendo: solo hay que encontrar esa cuota.
    target: Math.round(Math.max(fair * margin, minOdds) * 100) / 100,
  };

  // ── ¿Tenemos derecho a decir que el mercado se equivoca? ──
  //
  // Nuestro modelo no sabe NADA de los equipos: no tiene fuerza ofensiva ni
  // defensiva, solo lo que ve en el partido. La casa si tiene modelos
  // pre-partido. En el minuto 9 sin estadisticas, nuestro lambda es
  // practicamente el promedio global (medido: 0.0338 sin stats vs 0.0377 con
  // stats), asi que un desacuerdo de 16-19 puntos ahi no es un precio malo:
  // es que no sabemos nada y creemos saber.
  //
  // Solo se reclama ventaja cuando el partido ya nos ha DICHO algo.
  const informado = input.informed === true && (input.minute || 0) >= MIN_MINUTO_EV;

  // La cuota Over/Under del feed es del TOTAL del partido: solo compara con
  // "un gol mas hasta el final". Con la apuesta de 1T (descanso) o de equipo
  // concreto NO pregunta lo mismo, asi que ahi no se usa.
  const comparable = elegida.kind === 'ANY' && ph.key !== '1T' && informado;
  const e = comparable ? input.edge : null;
  if (!e || !e.odds) {
    // Sin precio publicado se manda igual. No se estima lo que paga la casa:
    // eso seria comparar el modelo consigo mismo y todo pareceria valor.
    return Object.assign({ tier: 'AVISO', reason: 'sin cuota publicada', hasOdds: false, requiresAi: true }, base);
  }

  // El minimo de cuota se aplica AQUI: a lo que paga la casa. Si no llega, la
  // apuesta es correcta pero el premio no compensa el riesgo.
  if (e.odds < minOdds) {
    return Object.assign({ tier: 'REJECT', hasOdds: true,
      reason: 'la casa paga ' + e.odds + ' < ' + minOdds + ' (premio no compensa)' }, base);
  }

  const ev = p * e.odds - 1;
  const edgePts = p - 1 / e.odds;

  // Un desacuerdo ENORME con una casa profesional casi siempre es dato roto
  // (se vieron cuotas con 1X2 a -1 produciendo "EV +71%"). Pero la corrupcion
  // ya se filtra en scores365 por rango, margen y coherencia del 1X2, asi que
  // aqui solo se corta lo absurdo. Un desacuerdo grande es precisamente lo que
  // se busca: nosotros al 80% y la casa pagando 3.00 es la apuesta ideal.
  if (edgePts > maxEdge) {
    return Object.assign({ tier: 'REJECT', hasOdds: true,
      reason: 'ventaja ' + (edgePts * 100).toFixed(0) + ' pts es absurda (dato roto casi seguro)' }, base);
  }
  if (ev < minEv) {
    return Object.assign({ tier: 'REJECT', hasOdds: true,
      reason: 'EV ' + (ev * 100).toFixed(1) + '% < ' + (minEv * 100).toFixed(0) + '%' }, base);
  }
  return Object.assign({
    tier: 'VALOR', reason: 'EV +' + (ev * 100).toFixed(1) + '% a cuota ' + e.odds,
    hasOdds: true, requiresAi: true,
    // Ventaja muy grande: se manda, pero marcada. Que decida quien apuesta.
    revisar: edgePts > avisoEdge,
    odds: e.odds, ev: Math.round(ev * 1e4) / 1e4,
    edgePts: Math.round(edgePts * 1e4) / 1e4,
    bookmaker: e.bookmaker || null,
  }, base);
}

module.exports = { xgRemaining, bigChances, alertQuality, classifyBet };
