/**
 * ai_context.js — la IA estima el CONTEXTO que el feed no da, no juzga números.
 *
 * POR QUE ESTO REEMPLAZA AL FILTRO ANTERIOR
 *
 * El filtro previo aprobo el 98.8% de las alertas (85 de 86) y aporto
 * exactamente 0.0 puntos de precision sobre 54 apuestas resueltas. Dos causas,
 * ambas de diseño:
 *
 *   1. El prompt le decia "aprueba si no hay razon concreta en contra".
 *      Un filtro que aprueba el 99% no es un filtro.
 *   2. Le pasaba xG, remates y ocasiones para que juzgara. La ablacion sobre
 *      329 partidos midio que esas variables RESTAN (-0.014 a -0.019 de AUC).
 *      Se le pedia juzgar con lo unico que esta medido que no informa.
 *
 * QUE SI SABE HACER UN LLM QUE NO SABE UNA REGRESION
 *
 * La ablacion identifico UNA variable con aporte real: la fuerza de equipo
 * derivada de la tabla (+0.036 AUC, skill x3, n=191). Pero solo el 57% de los
 * partidos tiene tabla. Los otros 142 son copas, amistosos de pretemporada,
 * torneos entre ligas (Leagues Cup) y fases de grupos sin clasificacion
 * publicada. Ahi el modelo asigna el promedio global y va ciego.
 *
 * Ese hueco es conocimiento del mundo, no calculo: si un amistoso de
 * pretemporada se juega en serio, si un equipo es historicamente ofensivo, si
 * hay algo en juego. Eso es exactamente donde un LLM tiene ventaja sobre una
 * regresion, y donde el feed no llega.
 *
 * COMO SE VALIDA (y hasta que se valide, esto no entra en produccion)
 *
 * Tenemos 191 partidos donde SI conocemos la fuerza real por la tabla. Se le
 * pide a la IA que la estime SIN darsela, y se mide la correlacion contra el
 * valor real. Si correlaciona, se puede confiar en su estimacion para los 142
 * sin tabla. Si no, se descarta y esos partidos simplemente no se alertan.
 *
 * Esa validacion la corre `npm run test:ctx`. Nada de esto se usa antes.
 */

const { providers, postJson } = require('./ai_filter');

const SYSTEM = [
  'Eres un analista de futbol que estima el RITMO DE GOLES esperado de un partido',
  'concreto. No tienes que predecir quien gana ni si habra gol: solo cuantos goles',
  'suele producir un enfrentamiento asi.',
  '',
  'Te dan los dos equipos y la competicion. Usa lo que sepas de:',
  '- el nivel y estilo de cada equipo (ofensivo, defensivo, cerrado)',
  '- el tipo de competicion: un amistoso de pretemporada no se juega igual que',
  '  una eliminatoria; una liga juvenil no produce los mismos goles que una de primera',
  '- si el partido tiene algo en juego',
  '',
  'Devuelve el TOTAL de goles esperado del partido (los dos equipos sumados).',
  'Referencias: 2.6 es la media mundial. Ligas cerradas ~2.0. Ligas abiertas ~3.4.',
  'Amistosos de pretemporada suelen ser altos (~3.2) por relajacion defensiva.',
  '',
  'Si no conoces a los equipos, dilo con confianza baja y da 2.6. Inventar un',
  'numero preciso sobre equipos que no conoces es peor que admitirlo.',
  '',
  'Responde SOLO JSON: {"goles":2.6,"confianza":0-100,"razon":"max 15 palabras"}',
].join('\n');

/**
 * @param {object} m { teamHome, teamAway, league, competitionType }
 * @returns {Promise<{goles:number, confianza:number, razon:string, provider:string}|null>}
 */
async function estimarRitmo(m) {
  const list = providers();
  if (!list.length) return null;

  const payload = {
    local: m.teamHome,
    visitante: m.teamAway,
    competicion: m.league || 'desconocida',
  };
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify(payload) },
  ];

  for (const p of list) {
    try {
      let { status, json, raw } = await postJson(p.host, p.path, p.headers(p.key), p.body(p.model, messages));
      if (status >= 400 && status < 500 && /response_format|json_object/i.test(raw || '')) {
        ({ status, json, raw } = await postJson(p.host, p.path, p.headers(p.key), p.body(p.model, messages, false)));
      }
      if (status < 200 || status >= 300) continue;
      const out = JSON.parse((p.parse(json) || '').replace(/```json|```/g, '').trim());
      const g = parseFloat(out.goles);
      // Rango sano: fuera de esto la respuesta no es creible y se descarta.
      if (!(g >= 1.2 && g <= 5.0)) continue;
      return {
        goles: Math.round(g * 100) / 100,
        confianza: Math.max(0, Math.min(100, parseInt(out.confianza, 10) || 0)),
        razon: String(out.razon || '').slice(0, 100),
        provider: p.name,
      };
    } catch {}
  }
  return null;
}

module.exports = { estimarRitmo, SYSTEM };
