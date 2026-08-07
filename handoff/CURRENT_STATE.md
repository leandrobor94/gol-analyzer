# CURRENT_STATE — qué funciona hoy, exactamente

Fecha del corte: **2026-08-05**. Último commit antes del traspaso: `2b4a059`.

---

## ✅ FUNCIONA Y ESTÁ VALIDADO

| Componente | Evidencia |
|---|---|
| Ciclo completo en la nube | Corre, alerta, etiqueta y commitea solo |
| Ingesta de 365scores | Verificada contra la API en vivo |
| Minuto exacto de cada gol | 548/548 recuperados, cero fallos |
| Mercado Over/Under | Verificado; ~40% de cobertura |
| Motor de probabilidad | AUC 0.731 fuera de muestra, skill +15% |
| Etiquetado automático | Dos etiquetas + timeline + lados + resolución de apuesta |
| Re-auditoría (`npm run audit`) | Recalcula todo desde datos, ninguna cifra de comentarios |
| Cascada de IA | Verificado en la nube: `OK — IA lista. Provider: groq` |
| Guardas contra datos corruptos | 4 filtros, probados contra un caso real |
| Alertas del tier 1T | **Bien calibrado**: dijo 68%, acertó 64.7% (n=17) |

---

## ⚠️ FUNCIONA PERO NO ESTÁ VALIDADO

| Componente | Problema |
|---|---|
| Tier "marca un equipo concreto" | **Mal calibrado**: dijo 61%, acertó 33% (n=6). Ordena bien (AUC 0.644) pero el nivel está inflado |
| Filtro de IA | Sin evidencia de aporte. 0 decisiones medidas todavía |
| Enriquecimiento con Flashscore | Aporte sin medir. Es la parte más cara del ciclo |
| Captura de trayectoria | Funciona, pero con huecos de 70 min por el cron estrangulado |
| Reentrenamiento semanal | El workflow existe; nunca se ha visto ejecutar |

---

## ❌ NO FUNCIONA / NO EXISTE

- **Predicción real de goles a partir del juego.** Es el problema central (A-1)
- **Modelo de 15 minutos.** Existe pero no discrimina (AUC 0.530). `model15.json` se
  publica con 0 gates a propósito
- **Fuerza pre-partido de los equipos.** Nunca se construyó. Es el hueco más grande
- **Medición de ROI real.** La infraestructura está lista; faltan apuestas resueltas
- **Ejecución fiable cada 10 minutos** (A-3)

---

## 📊 El dataset

| Métrica | Valor |
|---|---|
| Predicciones totales | ~654 |
| Etiquetadas | ~573 |
| Con timeline de goles | ~409 |
| Con etiqueta "gol en 15 min" | ~399 |
| Con lados de gol | 270 (recuperados aparte) |
| Con cuota 1X2 | Empezando |
| Con ritmo de liga | Empezando |
| Snapshots de trayectoria | ~288 líneas / 185 partidos, máx 3 por partido |
| Rango temporal | 18 jul – 5 ago 2026 |
| Tasa base "gol antes del final" | 65.9% |
| Tasa base "gol en 15 min" | 37.8% |

**Este dataset es lo más valioso del repo.** Cualquier refactor debe preservarlo.

---

## 🔒 QUE NUNCA DEBE MODIFICARSE SIN ENTENDER POR QUÉ ESTÁ ASÍ

1. **El orden del array `FEATURES` en `model.js`.** Es el contrato con `model.json`.
   Cambiarlo invalida los coeficientes en silencio. Añadir solo al final y reentrenar.

2. **La calibración fuera de pliegue en `train.js`.** Quitarla infla el extremo alto y
   reproduce el fallo original.

3. **La exigencia de n≥20 y el límite inferior de Wilson** en la selección de gates.
   Es lo que impide otro "100% con n=3".

4. **La salvaguarda de `--force`** que impide sobrescribir un modelo con gates por uno sin
   gates. Sin ella el bot se queda mudo en silencio.

5. **`NULL_STATS`.** Existe porque `undefined !== null` evalúa a `true` y dejaba entrar NaN
   a los cálculos.

6. **La fecha de Colombia en `fetchLiveMatches`.** Con UTC, pasada la medianoche se pide una
   fecha futura y devuelve 0 partidos.

7. **Los comentarios que documentan intentos fallidos** (sobre todo el de `teamSplit`).
   Están para que nadie repita el experimento. Borrarlos es perder el aprendizaje.

8. **`model15.json` con 0 gates.** No es un bug. Es un modelo que no discrimina y por eso
   no alerta.

---

## 🔧 QUE PUEDE REFACTORIZARSE SIN MIEDO

- `alert_gate.js`: borrar `alertQuality`, `xgRemaining`, `bigChances` (código muerto)
- `run_flashscore.js`: renombrar a algo honesto (`run.js` / `live.js`) — **actualizando
  `package.json` y los dos workflows**
- `train.js`: quitar la generación de `gates`, que ya no gobiernan
- `evaluate.js`: la sección 3 habla de gates obsoletos
- La condición `model.gates` que dispara el enriquecimiento con Flashscore quedó obsoleta

---

## 🌐 Configuración en la nube

**Secrets:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GROQ_API_KEY`
(`OPENAI_API_KEY` fue eliminado por el dueño: estaba sin crédito)

**Variables de entorno del workflow:** `MIN_ODDS=1.5`, `MIN_EV=0.05`

**Otras variables reconocidas:** `MIN_PROB` (0.55), `FORCE_RUN`, `ENABLE_FLASHSCORE`,
`AI_MIN_CONFIDENCE`, `AI_MODEL`, `NVIDIA_MODEL`, `NO_SYNC`

**Horario:** 7:00–22:00 hora de Colombia. Fuera de eso el ciclo sale sin hacer nada.

---

## 🎯 Comportamiento esperado de una alerta hoy

```
⏱ PRIMER TIEMPO
CD Cieza vs Real Murcia
   Segunda Federación
   21'  ·  0-0  ·  quedan ~26 min

   🎯 Gol antes del descanso
   📊 Nuestro análisis: 75%
   💵 Apuesta solo desde cuota 1.50  (justa 1.33)
   Sin cuota publicada para este partido: búscala tú.
```

Si hay cuota, sustituye las dos últimas líneas por el pago de la casa, el EV y un aviso de
verificar el precio.
