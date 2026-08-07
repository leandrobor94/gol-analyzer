# PROJECT_OVERVIEW — qué es y cómo fluye

## 1. Objetivo

Detectar, durante un partido de fútbol en vivo, situaciones en las que la probabilidad de
un evento (gol) sea lo bastante alta como para justificar una alerta accionable, y
mandarla por Telegram.

El objetivo declarado por el dueño fue **">90% de asertividad"**. Ese objetivo se
persiguió, se alcanzó de forma trivial, se demostró que la forma trivial no vale nada, y
se demostró que la forma útil es aritméticamente imposible. Todo eso está documentado en
`LEARNINGS.md` §1 y §2 y es imprescindible entenderlo antes de retomar el objetivo.

**Estado real del objetivo:** redefinido. Ya no se persigue un porcentaje de acierto sino
una apuesta accionable por fase del partido, con la probabilidad honesta al lado.

---

## 2. Arquitectura general

```
                    365scores API (pública, sin auth)
                              │
                    ┌─────────┴─────────┐
                    │   scores365.js    │  partidos en vivo, stats, cuotas,
                    └─────────┬─────────┘  minuto exacto de cada gol
                              │
                    ┌─────────▼─────────┐
                    │  run_flashscore.js │  ORQUESTADOR del ciclo
                    └──┬───┬───┬───┬────┘
                       │   │   │   │
        ┌──────────────┘   │   │   └──────────────┐
        │                  │   │                  │
   ┌────▼─────┐    ┌───────▼─┐ │           ┌──────▼──────┐
   │ model.js │    │alert_gate│ │           │  verify.js  │
   │probabilid│    │ qué se   │ │           │ etiqueta los│
   │   ad     │    │  alerta  │ │           │  terminados │
   └────┬─────┘    └────┬─────┘ │           └──────┬──────┘
        │               │       │                  │
        │          ┌────▼────┐  │                  │
        │          │ai_filter│  │                  │
        │          │  (LLM)  │  │                  │
        │          └────┬────┘  │                  │
        │               │  ┌────▼─────┐            │
        │               └─►│notify.js │            │
        │                  │ Telegram │            │
        │                  └──────────┘            │
        │                                          │
   ┌────▼──────────────────────────────────────────▼────┐
   │  model.json          predictions.json              │
   │  (coeficientes)      (dataset etiquetado)          │
   │                      snapshots.jsonl               │
   └────────────────────┬───────────────────────────────┘
                        │  (offline, bajo demanda)
              ┌─────────▼─────────┐    ┌──────────────┐
              │     train.js      │    │ evaluate.js  │
              │  aprende y valida │    │ re-auditoría │
              └───────────────────┘    └──────────────┘
```

**Separación fundamental (decisión D-3):** el modelo NO se toca durante el ciclo en vivo.
Se entrena offline con `npm run train`, que valida fuera de muestra antes de escribir
nada. El motor anterior ajustaba pesos cada ronda con 1–5 partidos, lo que perseguía ruido
y lo publicaba en el repo.

---

## 3. Flujo completo de una ronda

Ejecutado por `run_flashscore.js` cada vez que corre el workflow:

### Fase 0 — guardas
1. Comprueba horario Colombia (7:00–22:00). Fuera de eso sale sin hacer nada, salvo
   `FORCE_RUN=1`.
2. Carga `model.json`. **Si no hay modelo entrenado, analiza y guarda datos pero NO
   alerta.** Nunca se inventan pesos.

### Fase 1 — datos
3. `scores365.fetchLiveMatches()` → lista de partidos en vivo con marcador, minuto, liga,
   `competitionId` y cuota 1X2.
4. Filtra marcadores imposibles (≥3 goles antes del min 10, ≥6 antes del 30) — el feed
   sirve datos corruptos ocasionalmente.

### Fase 2 — enriquecimiento
5. `fetchLeagueContext(competitionId)` por competición → goles por partido de la liga.
   Se cachea por ronda.
6. `fetchMatchStats(gameId, homeId, awayId)` por partido → estadísticas.
7. Si las stats no son significativas, se rellena con `NULL_STATS` (todas las claves a
   `null`, para que los checks `!== null` no pasen con `undefined`).

### Fase 3 — puntuación
8. `model.score()` → λ (intensidad de gol por minuto) y probabilidad calibrada.
9. `model.phase(minuto)` → fase del partido y horizonte T de la apuesta.
10. `model.teamSplit(stats)` → reparto de λ entre los dos equipos.
11. `appendSnapshots()` → una línea por partido en `snapshots.jsonl` (append-only).
12. Opcional: Flashscore vía Playwright para xG real, máximo 5 partidos, solo cada 20 min.

### Fase 3b — mercado (opcional, informativo)
13. Para candidatos que ya convencen, `fetchGoalsMarket(gameId)` → cuota Over/Under.
14. `model.marketEdge()` → EV y ventaja. **No decide nada**, solo acompaña el aviso.

### Fase 4 — decisión y envío
15. `alert_gate.classifyBet()` → tier, apuesta concreta, probabilidad, precio objetivo.
16. Si el tier lo pide y hay clave de IA: `ai_filter.reviewAlert()` puede vetar.
17. Dedup: no repetir el mismo partido en el mismo tier si han pasado <45 min reales
    y el partido avanzó <25 min de juego.
18. `notify.buildMessage()` + `sendTelegram()`. **En local no envía**, solo lista.
19. Persiste en `predictions.json`, congelando la apuesta (`bet`) tal como se anunció.

### Fase 5 — etiquetado
20. `verify.verifyPending()` → para los partidos que ya no están en vivo, pide el detalle,
    y calcula: `goalAfterAnalysis`, `goalWithin15`, `goalMinutes`, `goalSides`,
    `timelineConsistent`, y resuelve la apuesta (`bet.won`, `bet.profit`).
21. Guarda `state.json` con contadores y dedup.

El workflow de GitHub commitea `predictions.json`, `snapshots.jsonl`, `state.json`,
`alertas.json`, `alertas_log.json` y `telegram-offset.txt`.

---

## 4. El modelo, conceptualmente

Proceso de Poisson no homogéneo:

```
λ = exp(b₀ + b·x)                    intensidad de gol por minuto
P(al menos un gol en T) = 1 − exp(−λ·T)
```

**El tiempo restante entra por la ESTRUCTURA del modelo, no como un regresor más.** Esa es
la diferencia con el motor original, que multiplicaba factores de urgencia a mano y
terminaba subiendo el score justo cuando la tasa real de gol se desploma (ver
`KNOWN_ISSUES.md` P-1).

Los coeficientes salen de máxima verosimilitud sobre datos verificados (`train.js`), con
calibración de Platt ajustada **fuera de pliegue**.

Extensión: `model.probAtLeast(λ, T, k)` da P(caigan al menos k goles), usando la cola de
Poisson. Sirve para responder la pregunta del mercado ("¿pasará el 2.5?" con 1 gol son 2
goles más).

---

## 5. Las tres fases de apuesta

Decisión del dueño (D-11), implementada en `model.phase()`:

| Fase | Minutos | Horizonte T | Apuesta |
|---|---|---|---|
| `1T` | < 45 | hasta el descanso (+2) | Gol antes del descanso — cualquiera o equipo concreto |
| `2T` | 45–70 | hasta el final (+3) | **Solo** gol de un equipo concreto |
| `FINAL` | > 70 | hasta el final (+4) | Gol de cualquiera o de un equipo |

**Razón, y es la parte que importa:** acortar el horizonte o estrechar la apuesta es lo que
sube la cuota justa al rango que compensa el riesgo. "Habrá gol" en el minuto 20 es un 95%
que se paga a 1.05 (arriesgas 100 para ganar 5). "Gol antes del descanso" en el mismo
minuto es un 58% que se paga a 1.73.

`classifyBet` evalúa todas las opciones de la fase y se queda con **aquella en la que el
modelo esté más convencido**, siempre que supere `MIN_PROB` (0.55).

---

## 6. Estado actual en una frase

El sistema **funciona técnicamente**: corre en la nube, analiza, alerta, etiqueta y se
audita solo. Lo que no está demostrado es que **prediga**: la parte de goles es un reloj
bien vestido, y la única señal real encontrada (remates, corr 0.607) aún no se explota.

Ver `CURRENT_STATE.md` para el detalle exacto de qué funciona y qué no.
