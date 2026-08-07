# FILES — estado archivo por archivo

Leyenda de estabilidad:
- **SÓLIDO** — probado, validado, no tocar sin razón fuerte
- **FUNCIONAL** — funciona, con mejoras conocidas pendientes
- **FRÁGIL** — funciona pero tiene un problema identificado sin resolver
- **DATOS** — no es código

---

## Código de producción

### `model.js` — SÓLIDO
Probabilidad. Poisson no homogéneo, features, calibración Platt, cola de Poisson, reparto
por equipo, comparación con el mercado.

**Problemas conocidos:**
- `teamSplit` está **mal calibrado**: ordena bien (AUC 0.644 fuera de muestra) pero la
  probabilidad que devuelve es demasiado alta (dijo 61%, acertó 33%, n=6). Sus pesos
  (`sot*3 + box*1.5 + xg*8 + attacks*0.05`) están escritos a ojo — pero **ya se intentó
  reemplazarlos por unos calibrados y salió peor** (ver `DECISIONS.md` D-14). El fallo es
  de nivel, no de orden.
- El comentario de `teamSplit` documenta ese intento fallido a propósito. **No borrarlo.**

**Pendiente:** capa de calibración sobre la probabilidad de equipo, contra resultados
verificados. Requiere ~30 apuestas resueltas de ese tier.

---

### `scores365.js` — SÓLIDO
Toda la entrada de datos.

**Estable y verificado contra la API real:** el timeline de goles, el mercado Over/Under,
las guardas de corrupción.

**Problemas conocidos:**
- `estimateXg()` es un estimador de 3 términos que triple-cuenta el mismo remate y **no
  correlaciona con el resultado** (corr −0.04). Está documentado en el código con esa
  advertencia. Se conserva porque Flashscore lo sobrescribe con xG real cuando puede, pero
  el modelo le asigna coeficiente ~0.
- Cobertura del mercado de goles: **solo ~40%** de los partidos, y solo BWIN.
- El objeto de cuotas **no trae marca de tiempo**: no se puede saber cuánto lleva ese
  precio publicado.

---

### `alert_gate.js` — FUNCIONAL
Decisión de qué apostar y si avisar. ~190 líneas, limpio.

**Problemas conocidos:**
- `alertQuality()` es código muerto: se exporta y no lo usa nadie desde la reescritura del
  gate. Se puede borrar.
- `xgRemaining` y `bigChances` solo los usa `alertQuality`. Mismo caso.
- Los umbrales (`minProb 0.55`, `minOdds 1.5`) están en el código con su justificación
  medida en comentarios, pero **no salen de `model.json`** como sí hacen los gates
  entrenados. Es una inconsistencia de diseño: idealmente vendrían del entrenamiento.

---

### `run_flashscore.js` — FUNCIONAL
Orquestador, ~470 líneas (venía de 1.125).

**Problemas conocidos:**
- **El nombre miente.** La fuente principal es 365scores, no Flashscore. Renombrar rompe
  `package.json` y los dos workflows.
- La lógica de enriquecimiento con Flashscore/Playwright sigue ahí y su valor está sin
  demostrar. Es la parte más cara del ciclo.
- `enrichWithFlashscore` solo se dispara cada 20 minutos y con `model.gates`, que ya no
  se usan para decidir — esa condición quedó obsoleta tras el rediseño del gate.

---

### `verify.js` — SÓLIDO
Etiquetado. Calcula ambas etiquetas, el timeline, los lados y resuelve las apuestas.

**Nota:** `label()` es también la función que usa `backfill.js`, así que cualquier cambio
en las etiquetas afecta al backfill. Es intencionado (una sola definición de verdad).

---

### `train.js` — FUNCIONAL
Entrenamiento y validación.

**Problemas conocidos:**
- Sigue produciendo `gates` (ventana × umbral) que **ya no gobiernan las alertas** desde
  que el gate pasó a ser por fase. Los escribe en `model.json` y `evaluate.js` los reporta,
  lo que puede confundir. No es dañino pero es deuda.
- No tiene **puerta de validación obligatoria**: puede publicar un modelo peor que el
  anterior sin protestar. Es la tarea #2 de `TODO.md` y habría evitado el error D-14.

---

### `evaluate.js` — SÓLIDO
Re-auditoría. Es la herramienta más valiosa del repo: recalcula todo desde los datos y
dice la verdad incómoda sola.

**Pendiente:** la sección 3 sigue hablando de los gates entrenados, que ya no deciden.

---

### `ai_filter.js` — SÓLIDO
Cascada de 4 proveedores, reintento sin modo JSON, fail-open documentado.
Verificado en la nube: `OK — IA lista. Provider: groq`.

---

### `notify.js` — SÓLIDO
Mensaje por fase. POST en vez de GET (el GET rompía con mensajes largos).

---

### `train_grid.js` — SÓLIDO (herramienta de análisis)
Rejilla temporal desde los timelines. Su resultado fue negativo (AUC 0.530) y **eso es
información valiosa**: conservarlo permite re-verificar la conclusión si alguien duda.

---

### `backfill.js` — SÓLIDO
Ya ejecutado (548/548, cero fallos). Idempotente: salta los que ya tienen `goalMinutes`.

---

### `flashscore_fetcher.js` — FRÁGIL
Scraping con Playwright. **No auditado en esta sesión.** Es la única dependencia externa
pesada del proyecto y su aporte no está medido. Se carga de forma perezosa y su fallo no
rompe el ciclo.

---

### `telegram-cmd.js` — SÓLIDO
`/pause`, `/resume`, `/status`. Autoriza por `chat_id`.

---

### `_test_ai.js` — FUNCIONAL
Smoke test de la API de IA. Lo usa el workflow `ai-smoke.yml`.

---

## Datos

| Archivo | Qué es | Estado |
|---|---|---|
| `predictions.json` | **El dataset.** ~650 predicciones, 573 etiquetadas, 409 con timeline de goles | DATOS — lo más valioso del repo |
| `snapshots.jsonl` | Trayectoria intra-partido, append-only. ~288 líneas / 185 partidos, máx 3 fotos por partido | DATOS — insuficiente todavía |
| `model.json` | Coeficientes entrenados, calibración, gates, métricas | DATOS |
| `model15.json` | Modelo de 15 min. **0 gates a propósito** (AUC 0.530, no discrimina) | DATOS |
| `state.json` | Dedup de alertas + contadores | DATOS |
| `alertas.json` | `{enabled: true/false}` — interruptor de `/pause` | DATOS |
| `alertas_log.json` | Log histórico de alertas resueltas | DATOS |
| `teams.json`, `weights.json` | **ELIMINADOS.** Eran 93% estado muerto (688 KB + 80 KB) | — |
| `learn.js` | **ELIMINADO.** Sustituido por `verify.js` | — |
| `_audit_*.js`, `_reaudit.js` | **ELIMINADOS.** Sustituidos por `evaluate.js` | — |

---

## Workflows

| Archivo | Qué hace | Estado |
|---|---|---|
| `.github/workflows/analyze.yml` | Ciclo principal, cron `*/10` | **FRÁGIL — GitHub estrangula el cron.** Huecos reales de 70+ min |
| `.github/workflows/retrain.yml` | Reentrenamiento semanal (lunes 08:00 UTC) + manual | FUNCIONAL |
| `.github/workflows/telegram-commands.yml` | Comandos del bot | FUNCIONAL |
| `.github/workflows/ai-smoke.yml` | Smoke test de IA | FUNCIONAL |

**Secrets configurados:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GROQ_API_KEY`.
`OPENAI_API_KEY` fue **eliminado** por el dueño (estaba sin crédito).
