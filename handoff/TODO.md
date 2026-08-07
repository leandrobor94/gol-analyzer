# TODO — plan priorizado

Orden recomendado por el análisis final de la sesión: **1 → 2 → 3 → 4 → 5**.
Primero desbloquear datos, luego blindar el proceso, luego arreglar lo diagnosticado, y
solo entonces las apuestas grandes.

---

## 0. Medir la ventaja del modelo 1X2 contra el mercado EN VIVO — **LO MÁS IMPORTANTE**

**Objetivo.** Saber si el modelo 1X2 (AUC 0.870, 92.3% con p≥0.70) le gana al mercado.

**Motivo.** Es el mejor resultado del proyecto y el único >90% con señal real. Pero buena
parte de ese AUC viene del marcador, que la casa también conoce. La ventaja real es el
+0.030 que aportan las estadísticas. **Sin esta medición, es una predicción buena, no una
ventaja demostrada.**

**Cómo.** Las cuotas 1X2 en vivo ya se capturan (`scores365.extractOdds` → campo `odds` de
cada predicción). Cuando haya ~50 predicciones con odds y resultado, comparar:
`p_modelo` vs `p_implícita` y calcular ROI real.

**⚠️ NO usar las cuotas de partidos terminados**: son pre-partido, y compararse contra
ellas es hacer trampa (nosotros sabemos el marcador, ellas no).

**Dificultad.** Baja (solo hay que esperar datos y medir).
**Dependencias.** La tarea 1 (frecuencia de ejecución).
**Riesgo.** El resultado puede ser que NO haya ventaja. Es información igual de valiosa.

---

## 1. Arreglar la frecuencia de ejecución — **BLOQUEANTE**

**Objetivo.** Que el ciclo corra de verdad cada 10 minutos.

**Motivo.** El cron dice `*/10` pero GitHub Actions lo estrangula: `snapshots.jsonl` tiene
huecos de 70+ minutos dentro del mismo partido (min 8 → min 81), y solo 288 líneas en un
día cuando deberían ser ~4.000. **Mientras no se resuelva, la única hipótesis viva del
proyecto (momentum de juego) nunca tendrá datos.**

**Dificultad.** Media. No es código del modelo, es infraestructura.

**Opciones:** cron externo gratuito que dispare `workflow_dispatch` vía API de GitHub · un
self-hosted runner · un servicio tipo cron-job.org.

**Dependencias.** Ninguna. Se puede hacer ya.

**Riesgo.** Bajo. Si se usa disparo externo, cuidado con no solapar ejecuciones — el
`concurrency` del workflow ya lo cubre.

---

## 2. Puerta de validación obligatoria en `train.js`

**Objetivo.** Que ningún modelo se publique si no bate al anterior en validación cruzada
temporal.

**Motivo.** Es la puerta que habría impedido el error D-14 —publiqué una regresión basada
en una medición dentro de muestra—. Es el error más caro de la sesión y es sistémico, no
puntual.

**Cómo.** Antes de escribir `model.json`: cargar el modelo actual, evaluar ambos con el
mismo rolling-origin, y negarse a escribir si el nuevo no gana (salvo `--force`). Reportar
la comparación siempre.

**Dificultad.** Baja. Media hora.

**Dependencias.** Ninguna.

**Riesgo.** Muy bajo. Solo añade una comprobación.

---

## 3. Calibrar la salida del tier de equipo

**Objetivo.** Que cuando el sistema diga 61%, ocurra el 61%.

**Motivo.** Es el único fallo **bien diagnosticado** que queda: el reparto ordena bien
(AUC 0.644 fuera de muestra) pero el nivel está inflado (dijo 61%, acertó 33%, n=6).

**Cómo.** Una capa de Platt sobre la probabilidad del tier `TEAM`, ajustada con las
apuestas resueltas de ese tier. **Fuera de pliegue, obligatorio.**

**Dificultad.** Baja (el código de Platt ya existe en `model.js`).

**Dependencias.** ~30 apuestas resueltas del tier TEAM. Depende de la tarea 1.

**Riesgo.** Medio. Con n pequeño la calibración también se sobreajusta. **No aplicar por
debajo de n=30**, y validar fuera de muestra.

**⚠️ NO INTENTAR:** cambiar las variables de `teamSplit`. Ya se probó y salió peor (D-14).
El problema es de nivel, no de orden.

---

## 4. Mercado de REMATES — **HECHO Y VALIDADO** (falta cablearlo)

**Estado: el modelo existe, está entrenado y validado.** `shots.js` + `shots_model.json`.

**Resultado de la validación** (5 cortes temporales, ajuste solo en train, n_test=178):

| Predictor | MAE |
|---|---|
| Media global (no mira el partido) | 6.02 |
| Proyección del ritmo (baseline trivial) | 5.01 |
| **Modelo** | **4.02** |

Bate al baseline trivial por ~1 remate. Esa comparación era obligatoria: sin ella
"predecir remates" sería repetir el ritmo actual con otro nombre.

Simulación de apuestas Over/Under:

| Margen | Apuestas | Acierto | (trivial) |
|---|---|---|---|
| 3 | 116 | 87.1% | 81.6% |
| 4 | 91 | 89.0% | 84.3% |
| **5** | **75** | **90.7%** | 85.3% |

IC 95% del 90.7%: [82%, 95%].

**⚠️ ADVERTENCIA CRÍTICA:** la "línea" de esa simulación es la media global redondeada
— un proxy **naive** de lo que pondría una casa. Una casa real pone una línea más afilada
con modelos pre-partido. **Contra una línea real la ventaja sería menor**, y cuánto no se
sabe porque 365scores no publica cuotas de remates.

**Lo que falta:** una fuente de cuotas de remates. Sin ella el modelo es una herramienta
válida pero no un producto. Opciones: otra API de cuotas, o que el dueño meta la línea a
mano cuando la vea en su casa de apuestas.

---

## 4-bis. (histórico) Explorar el mercado de REMATES

**Objetivo original.** Alertar sobre total de remates / remates a puerta en vez de sobre goles.

**Motivo.** Es el único sitio donde nuestras estadísticas predicen de verdad:

| Evento | corr(ritmo actual, resto) |
|---|---|
| **Remates** | **0.607** |
| Tarjetas | 0.162 |
| Goles | 0.130 |
| Córners | −0.030 |

El tempo del partido es estable; lo aleatorio es que el remate entre. Toda la auditoría
midió la capa aleatoria. Los mercados de remates existen en las casas.

**Cómo.**
1. Construir el dataset: para cada snapshot, remates hasta ahora y remates finales
   (se puede backfillear con `fetchMatchStats` de partidos terminados).
2. Modelo de tasa de remates (Poisson sobre remates, misma estructura).
3. Validar fuera de muestra con el mismo rigor.
4. Producto: "este partido terminará con más de N remates".

**Dificultad.** Alta. Es una línea de producto nueva.

**Dependencias.** Ninguna técnica; el dato se puede backfillear.

**Riesgo.** Medio-alto. La corr 0.607 es entre *ritmo* y *resto*, y parte de eso es
mecánico (un partido con muchos remates seguirá teniendo muchos). **Hay que comprobar que
el modelo bate a "proyectar el ritmo actual linealmente"**, que es el baseline trivial. Si
no lo bate, no hay producto.

---

## 5. Fuerza pre-partido de los equipos (Dixon-Coles)

**Objetivo.** Que el modelo sepa quiénes juegan, no solo qué está pasando.

**Motivo.** Es el hueco más grande: un Bayern–Dortmund y un partido de tercera rumana
arrancan hoy con el mismo λ. Explica el fallo del 0-4: en vivo veías dominio, el
pre-partido te habría dicho quién sabía rematar. Y es lo que usan todos los modelos serios.

**Cómo.** El feed trae `hasRecentMatches`, `hasPreviousMeetings` y clasificaciones.
Construir ataque/defensa por equipo con Dixon-Coles y usarlo como prior de λ.

**Dificultad.** Alta.

**Dependencias.** Requiere ingesta histórica de resultados por competición.

**Riesgo.** Medio. Muchos equipos tendrán pocos partidos; hace falta encogimiento hacia la
media de la liga.

---

## 6–11 · Menú secundario

| # | Tarea | Motivo | Dif. | Riesgo |
|---|---|---|---|---|
| 6 | **Usar el mercado como PRIOR, no como rival** | Su λ implícita es una estimación gratis hecha con más datos. Encoger la nuestra hacia ella y desviarnos solo con evidencia. Invierte la lógica actual | Media | Bajo |
| 7 | **Binomial negativa en vez de Poisson** | La observación del dueño ("0-0 y luego 4") es sobredispersión. Una mezcla Gamma-Poisson reproduce las colas y haría al modelo menos confiado en el medio | Alta | Medio |
| 8 | **Alineaciones y cambios** | `hasLineups` está en el feed y `eventType 1000` son sustituciones. Un doble cambio ofensivo en el 65' es "entender el partido", y nadie lo mira | Media | Bajo |
| 9 | **Rojas como multiplicador propio** | Hoy es una feature con coeficiente 0.026. Una expulsión es el mayor cambio de λ que existe en fútbol | Baja | Bajo |
| 10 | **Encogimiento hacia la tasa base** | Con muestras cortas las estimaciones salen sobreconfiadas. Es la explicación matemática del 61%→33% | Baja | Bajo |
| 11 | **Limpiar deuda** | Código muerto en `alert_gate.js`, gates obsoletos en `train.js`, renombrar `run_flashscore.js` | Baja | Bajo |

---

## Tareas del dueño (no de código)

1. **Rotar el token de GitHub** que está en texto plano en `.git/config` (A-9)
2. **Decidir la pregunta pendiente de D-11**: en la ventana 45–70, los datos dicen que "gol
   de cualquiera" llega al 75–77% mientras "marca un equipo concreto" no pasa de ~62%. Él
   pidió equipo concreto por razones de cuota, pero luego decidió que la cuota no importa.
   La conversación derivó antes de resolverlo.
3. **Decidir si pausar las alertas** mientras el sistema sea esencialmente un reloj. La
   recomendación dada fue pausar (`/pause` en Telegram), porque un número con apariencia de
   análisis que no lo es entrena a confiar en algo vacío.
