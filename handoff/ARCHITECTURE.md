# ARCHITECTURE — módulos y responsabilidades

Principio rector: **cada módulo tiene una responsabilidad y no invade la de otro.** El
código original tenía 1.125 líneas en un solo archivo que hacía todo; la reescritura lo
partió y esa separación es lo que permite auditar cada pieza por separado.

---

## Mapa de dependencias

```
run_flashscore.js  (orquestador — no calcula nada, coordina)
  ├── scores365.js      (datos externos)          sin dependencias internas
  ├── model.js          (probabilidad)            sin dependencias internas
  ├── alert_gate.js     (decisión)                sin dependencias internas
  ├── verify.js         (etiquetado)              → scores365.js
  ├── notify.js         (Telegram)                sin dependencias internas
  ├── ai_filter.js      (LLM opcional)            sin dependencias internas
  └── flashscore_fetcher.js (Playwright, opcional, carga perezosa)

train.js       → model.js          (offline)
train_grid.js  → model.js          (offline)
backfill.js    → scores365.js, verify.js   (offline)
evaluate.js    → model.js          (offline)
telegram-cmd.js  (independiente, workflow propio)
```

**Regla importante:** `model.js`, `alert_gate.js` y `scores365.js` no dependen de nada
interno. Se pueden cargar y probar en aislamiento, y así se han probado durante toda la
auditoría. Mantener esa propiedad.

---

## 1. `scores365.js` — acceso a datos

**Propósito.** Única puerta a la API de 365scores (`webws.365scores.com/web`). Pública, sin
autenticación.

**Responsabilidades:**
- `fetchLiveMatches()` — partidos en vivo del día. Usa la fecha de **Colombia**, no UTC
  (crítico: el runner de Actions está en UTC y pasada la medianoche pediría una fecha
  futura y devolvería 0 partidos). Corrige minutos "stale" comparando con `startTime`.
- `fetchMatchStats(gameId, homeId, awayId)` — estadísticas, separadas por `competitorId`.
- `fetchGameDetail(gameId)` — **el minuto exacto de cada gol**. `game.events[]` con
  `eventType.id === 1`. Devuelve `{minute, side}` por gol. Funciona retroactivamente para
  partidos de semanas atrás.
- `verifyFinishedMatch(gameId)` — envoltorio de lo anterior; `null` si no ha terminado.
- `fetchGoalsMarket(gameId)` — cuota Over/Under de goles totales. Vive en
  `game.promotedPredictions.predictions[].odds` con `lineTypeId === 3`. **La línea numérica
  (2.5, 3.5) NO está en el objeto `odds`: está en el título del contenedor**, formato
  `"Goles en el partido (2.5)"`.
- `fetchLeagueContext(competitionId)` — goles por partido de la competición.
- `toInternalFormat()` / `NULL_STATS` — normalización.
- `sanitizeLeague()` — limpieza de nombres.
- `estimateXg()` — estimación de xG desde remates. **Documentada como no fiable.**

**Guardas de calidad que implementa** (todas añadidas tras encontrar datos corruptos):
- Cuotas fuera de [1.02, 60] → descartadas
- Overround fuera de [1.0, 1.35] → descartado
- Si el 1X2 del mismo partido trae algún rate ≤ 1.0 → todo el bloque es sospechoso
- `isConcluded` → línea cerrada, no apostable

---

## 2. `model.js` — probabilidad

**Propósito.** Convertir el estado de un partido en una probabilidad. Compartido por
producción y entrenamiento, para que no puedan divergir.

**Responsabilidades:**
- `phase(minuto)` — fase (`1T` / `2T` / `FINAL`), horizonte `T` y opciones de apuesta.
- `minsLeft(minuto)` — minutos útiles hasta el final del partido.
- `extractFeatures(match)` — 14 features, **todas tasas normalizadas** (por 90 min y
  divididas por un valor típico) para que los coeficientes sean comparables y la
  regularización L2 sea justa. **El orden del array `FEATURES` es el contrato con
  `model.json`**: añadir features solo al final, y reentrenar.
- `rawProb(model, features, T)` — λ y probabilidad cruda del Poisson.
- `score(model, match)` — probabilidad calibrada + λ + `minsLeft` + `prob15`.
- `probAtLeast(λ, T, k)` — cola de Poisson, P(al menos k goles más).
- `marketEdge(λ, T, golesActuales, mercado)` — EV y ventaja contra la cuota.
- `teamSplit(stats)` — reparto de λ entre los dos equipos.
- `fitPlatt` / `applyPlatt` — calibración.
- `loadModel()` — lee `model.json`; **si no existe devuelve `trained: false` y el gate no
  alerta**. Nunca inventa pesos.

**Decisión clave:** Platt y no isotónica. Con ~500 muestras la isotónica crea mesetas
planas que empatan casos distintos y destruyen el orden (medido: AUC 0.731 → 0.709). Platt
es monótona de 2 parámetros: corrige el nivel sin tocar el ranking.

---

## 3. `alert_gate.js` — decisión

**Propósito.** Decidir QUÉ se apuesta y SI se avisa. Es el único sitio donde vive esa
lógica.

**Responsabilidad principal:** `classifyBet(input, opts)`.

Flujo interno:
1. Construye las opciones de apuesta según `phase.options` (`ANY` y/o `TEAM`).
2. `TEAM` solo se ofrece si `split.confident` (hay ataques y posesión).
3. Filtra por convicción: `p >= minProb` (0.55) y `p < 0.97`.
4. Se queda con la de **mayor probabilidad** entre las válidas.
5. Calcula `fair` (1/p) y `target` (precio mínimo = max(fair×1.08, minOdds)).
6. Si hay cuota comparable **y** estamos informados (minuto ≥ 25 y stats útiles), calcula
   EV y lo adjunta. **La cuota no abre ni cierra la puerta.**

**Parámetros y de dónde salen:**

| Parámetro | Valor | Justificación |
|---|---|---|
| `minProb` | 0.55 | Techo medido: un equipo concreto marcando llega como mucho al 62% (dominio aplastante, n=32). Con 0.70 el bot se queda mudo |
| `minOdds` | 1.5 | Exigencia del dueño: premio mínimo que compensa el riesgo. **Se aplica a la cuota de la CASA, no a la nuestra** |
| `MIN_MINUTO_EV` | 25 | Antes de eso nuestro λ es el promedio global (medido: 0.0338 sin stats vs 0.0377 con stats). No tenemos derecho a decir que el mercado se equivoca |
| `maxEdge` | 0.50 | Solo corta lo absurdo (dato roto). Entre 0.25 y 0.50 marca `revisar: true` |

---

## 4. `run_flashscore.js` — orquestador

**Propósito.** Coordinar el ciclo. **No calcula probabilidades ni decide alertas**: delega.

Responsabilidades propias:
- Guardas de horario y de modelo entrenado
- `hasMeaningfulStats()` — criterio de si las stats significan algo
- `appendSnapshots()` — escribe `snapshots.jsonl` (append-only, con tope de 24 MB /
  300k líneas)
- `betOf()` — congela la apuesta anunciada para poder resolverla después
- Dedup de alertas
- Persistencia de `predictions.json` y `state.json`

El nombre es histórico (viene de cuando el sistema dependía de Flashscore). **Hoy la fuente
principal es 365scores**; Flashscore es opcional y marginal. Renombrarlo rompería los
workflows: si se hace, cambiar también `package.json` y los dos `.yml`.

---

## 5. `verify.js` — etiquetado

**Propósito.** Convertir predicciones pendientes en datos etiquetados. Sustituye al antiguo
`learn.js` (eliminado).

Etiquetas que calcula:
- `goalAfterAnalysis` — hubo gol entre el análisis y el final (histórica)
- `goalWithin15` — hubo gol en los 15 min siguientes (la que sirve)
- `goalMinutes` / `goalSides` — timeline completo
- `nextGoalMinute`
- `timelineConsistent` — si el nº de goles posteriores cuadra con el marcador. **Si es
  `false`, no se puede afirmar que NO hubo gol, y `train.js` excluye esas filas**
- `bet.won` / `bet.profit` — resolución de la apuesta según su fase

**Separación crítica:** aquí NO se aprende. Solo se etiqueta. El aprendizaje es offline.

---

## 6. `train.js` — aprendizaje offline

- Ajuste por máxima verosimilitud del Poisson censurado
- Calibración de Platt ajustada **fuera de pliegue** (4 pliegues)
- Validación rolling-origin (5 cortes temporales)
- Búsqueda del gate sobre rejilla (ventana × umbral), exigiendo n≥20 y eligiendo por
  **límite inferior del IC de Wilson**
- Salvaguarda: se niega a sobrescribir un modelo con gates por uno sin gates sin `--force`
- `--label h15` escribe `model15.json`, no `model.json`

---

## 7. `evaluate.js` — re-auditoría (`npm run audit`)

Seis secciones: estado del dataset, ¿discrimina el modelo?, gates y precisión real, ROI
económico, ¿aporta la IA?, calidad de datos, y qué falta para el objetivo (incluida la
frontera aritmética del 90%).

Recalcula todo desde `predictions.json`. **Ninguna cifra sale de comentarios del código.**

---

## 8. `ai_filter.js` — segunda opinión (opcional)

Cascada de proveedores: **Groq → NVIDIA → OpenAI → Anthropic**. Los dos primeros tienen
capa gratuita real. Si uno falla se pasa al siguiente; si ninguno responde, la alerta pasa
sin filtrar y **no se registra como decisión de la IA** (registrarlo contaminaría la
medición de su aporte).

Reintenta sin `response_format: json_object` si el modelo lo rechaza.

**Honestidad obligatoria:** no hay evidencia de que aporte. Si las estadísticas no
predicen, un LLM que lee esas mismas estadísticas tampoco. Está montado para poder
**demostrarlo o descartarlo**: cada decisión se guarda en `aiDecision` y `evaluate.js`
compara la precisión de lo que dejó pasar contra lo que vetó.

---

## 9. `notify.js`, `backfill.js`, `train_grid.js`, `telegram-cmd.js`

- **`notify.js`** — mensaje de Telegram por fase. Usa POST con `URLSearchParams` (el GET
  original rompía con mensajes largos). Siempre incluye probabilidad y precio objetivo.
- **`backfill.js`** — recupera minutos de gol del histórico. Concurrencia 5, pausa 150 ms.
  Ya ejecutado (548/548). Reutilizable si se añaden campos nuevos.
- **`train_grid.js`** — modelo de 15 min sobre rejilla temporal desde los timelines.
  Convierte cada partido en ~14 observaciones. Escribe `model15.json`.
- **`telegram-cmd.js`** — `/pause`, `/resume`, `/status`. Workflow propio. Autoriza por
  `chat_id`.
