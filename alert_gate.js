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
 * 2. Se decide por valor esperado, no por certeza.
 *    EV = p_NUESTRA x cuota - 1. La cuota nunca sustituye a nuestra
 *    probabilidad: solo dice a cuanto la pagan. Si no hay cuota publicada
 *    (pasa en ~60% de los partidos) se avisa igual, indicando el precio minimo
 *    al que merece la pena. Lo que NO se hace es estimar lo que paga la casa
 *    con nuestro propio modelo: eso seria compararlo consigo mismo y todo
 *    pareceria valor.
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
 * Se alerta cuando NUESTRA probabilidad cae en la banda apostable, es decir
 * cuando la cuota justa esta entre minOdds y maxOdds. Fuera de ahi no se manda:
 * por debajo el premio no compensa el riesgo (el problema del 1.05), por encima
 * es un tiro lejano que no sabemos sostener.
 *
 * La cuota de la casa NO hace falta para alertar:
 *   - si la hay  -> se calcula EV y se exige que sea positivo
 *   - si no la hay -> se da el precio minimo al que merece la pena, y el usuario
 *                     la busca donde quiera
 *
 * @param {object} p  { p, phase, lambda, edge }  edge puede ser null
 */
function classifyBet(input, opts) {
  const minOdds = (opts && opts.minOdds) || 1.5;
  const maxOdds = (opts && opts.maxOdds) || 3.5;
  const minEv = (opts && opts.minEv) || 0.05;
  const maxEdge = (opts && opts.maxEdge) || 0.25;
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

  const enBanda = opciones.filter(o => {
    const f = 1 / o.p;
    return o.p > 0 && o.p < 1 && f >= minOdds && f <= maxOdds;
  });
  if (!enBanda.length) {
    const mejor = opciones.sort((a, b) => b.p - a.p)[0];
    const f = mejor && mejor.p > 0 ? 1 / mejor.p : 0;
    return { tier: 'REJECT', reason: 'cuota justa ' + f.toFixed(2) + ' fuera de [' + minOdds + '-' + maxOdds + ']' };
  }
  // La de menor cuota dentro de la banda: la mas probable de las apostables.
  enBanda.sort((a, b) => b.p - a.p);
  const elegida = enBanda[0];
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
    target: Math.round(fair * margin * 100) / 100,
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

  const ev = p * e.odds - 1;
  const edgePts = p - 1 / e.odds;

  // Demasiado bueno para ser verdad. Un desacuerdo enorme con una casa
  // profesional casi nunca es dinero gratis: suele ser dato roto o error
  // nuestro. Medido en vivo: cuotas con 1X2 a -1 producian "EV +71%".
  if (edgePts > maxEdge) {
    return Object.assign({ tier: 'REJECT', hasOdds: true,
      reason: 'ventaja ' + (edgePts * 100).toFixed(0) + ' pts es implausible (dato sospechoso)' }, base);
  }
  if (ev < minEv) {
    return Object.assign({ tier: 'REJECT', hasOdds: true,
      reason: 'EV ' + (ev * 100).toFixed(1) + '% < ' + (minEv * 100).toFixed(0) + '%' }, base);
  }
  return Object.assign({
    tier: 'VALOR', reason: 'EV +' + (ev * 100).toFixed(1) + '% a cuota ' + e.odds,
    hasOdds: true, requiresAi: true,
    odds: e.odds, ev: Math.round(ev * 1e4) / 1e4,
    edgePts: Math.round(edgePts * 1e4) / 1e4,
    bookmaker: e.bookmaker || null,
  }, base);
}

module.exports = { xgRemaining, bigChances, alertQuality, classifyBet };
