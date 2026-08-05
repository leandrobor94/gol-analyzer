# gol-analyzer

Alertas de gol en vivo. Corre solo en GitHub Actions.

---

## Lo primero que hay que saber

**El objetivo de ">90% de acierto" ya está cumplido, y por sí solo no vale dinero.**

El sistema define acierto como *"¿hubo algún gol entre el aviso y el final del partido?"*.
Esa pregunta la contesta el reloj, no el fútbol. Medido sobre 548 partidos verificados:

| Minuto del aviso | Partidos | Hubo gol antes del final |
|---|---|---|
| 0 – 20 | 60 | **96.7%** |
| 20 – 35 | 47 | 85.1% |
| 45 – 60 | 176 | 70.5% |
| 70 – 80 | 147 | 60.5% |
| 80 – 90 | 40 | 30.0% |
| 90 – 99 | 33 | 12.1% |

Avisar a ciegas sobre cualquier partido antes del minuto 20 acierta el 96.7% sin
modelo ninguno. Por eso el gate `PRECISION` supera el 90%: **dispara temprano**.
El entrenamiento lo dice sin adornos — mide el aporte del modelo sobre el reloj
y hoy es de **0.0 puntos**.

Y hay una razón medible: controlando el tiempo restante (minuto 45–80, n=361),
**ninguna** estadística del partido correlaciona con que venga un gol.

```
corr(xG estimado,  hubo gol) = -0.04
corr(remates a puerta,  ...) = -0.05
corr(ocasiones claras,  ...) = -0.01
corr(minutos restantes, ...) = +0.11   <- lo único que informa
```

El fútbol se parece mucho a un proceso de Poisson: sabiendo cuánto queda y a qué
ritmo marca la liga, las estadísticas del partido añaden muy poco a la pregunta
*"¿habrá algún gol?"*. Para que las estadísticas importen hay que preguntar otra
cosa — ver [Cómo llegar a un 90% que sí valga](#cómo-llegar-a-un-90-que-sí-valga).

---

## Cómo funciona

```
scores365.js   datos: partidos en vivo, stats, cuotas 1X2, minuto real de cada gol
model.js       probabilidad. Poisson no homogéneo: P = 1 - exp(-λ·T)
alert_gate.js  qué se alerta. Umbrales de model.json, nunca escritos a mano
ai_filter.js   segunda opinión de un LLM sobre el tier VALOR (aporte sin probar)
verify.js      etiqueta predicciones con partidos ya terminados
notify.js      Telegram
train.js       aprende, offline y bajo demanda (dos etiquetas: ft y h15)
backfill.js    recupera minutos de gol del histórico vía API
evaluate.js    re-auditoría
```

La probabilidad sale de un proceso de Poisson donde **el tiempo restante entra
por la estructura del modelo**, no como un regresor más:

```
λ = exp(b₀ + b·x)              intensidad de gol por minuto
P(gol antes del final) = 1 - exp(-λ · T)
```

Los coeficientes salen de `train.js` sobre datos verificados. Si no hay
`model.json`, el sistema analiza y guarda datos pero **no alerta**: nunca se
inventan pesos.

### Cómo se decide qué se alerta

**Por valor esperado, no por precisión.** Un aviso al 95% con cuota 1.05 arriesga
100 para ganar 5: no es un producto. Maximizar precisión producía exactamente eso.

```
EV = probabilidad_del_MODELO × cuota − 1
```

La cuota **no sustituye** a nuestra probabilidad: solo dice a cuánto la pagan. Con
p=55% y cuota 3.00 el EV es +65%, aunque la casa crea que es un 33%. Ese
desacuerdo es justo lo que se busca — si pensáramos igual que el mercado, no
habría nada que apostar.

| Tier | Cuándo salta | Qué te dice |
|---|---|---|
| `VALOR` | cuota ≥ `MIN_ODDS` (1.5) y EV ≥ `MIN_EV` (5%) | la apuesta concreta, con nuestra probabilidad y la del mercado |
| `PRECISION` | solo si no hay mercado que evaluar | informativo; se suprime si la cuota justa baja de 1/`MIN_ODDS` |

Se evalúan **Over y Under**: el valor aparece en los dos lados. En una prueba en
vivo, 3 de 12 partidos daban valor y dos de ellos estaban en el Under.

Cada alerta **congela la apuesta** (línea, lado, cuota, EV). Al terminar el
partido, `verify.js` la resuelve y calcula el beneficio por unidad. `npm run audit`
reporta el **ROI real** — la única métrica que distingue un 96% a cuota 1.05
(pierde dinero) de un 45% a cuota 2.60 (lo gana).

### De dónde sale la cuota de goles

`game.promotedPredictions.predictions[].odds` con `lineTypeId === 3`. La línea
numérica no está en el objeto `odds`: va en el título, `"Goles en el partido (2.5)"`.
Disponible en ~7 de cada 12 partidos en vivo. La cuota 1X2 del listado **no sirve**
para esto: predecir quién gana no es predecir cuántos goles caen.

---

## Uso

```bash
npm ci
npm start          # una ronda de análisis (en local no envía Telegram)
npm run train      # reentrena y reescribe model.json
npm run audit      # re-auditoría: ¿discrimina? ¿aporta la IA? ¿qué falta?
```

En la nube:

- **`Analizar partidos y alertar`** — cada 10 min. Analiza, alerta, etiqueta.
- **`Reentrenar y re-auditar`** — lunes, o a mano. Único sitio donde cambia el modelo.

El modelo **no se toca** en las rondas normales. El motor anterior ajustaba pesos
cada ronda con 1–5 partidos; con esa muestra el gradiente es ruido, y ese ruido
quedaba publicado en el repo.

### Secrets

| Secret | Para qué |
|---|---|
| `TELEGRAM_BOT_TOKEN` | obligatorio para alertar |
| `TELEGRAM_CHAT_ID` | obligatorio para alertar |
| `GROQ_API_KEY` / `NVIDIA_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | **todos opcionales** |

**El sistema alerta perfectamente sin ninguna clave de IA.** La precisión de
ambos gates se midió *sin* IA, así que exigir una clave para alertar sería
incoherente con el número que se promete. La IA solo revisa el tier VALOR cuando
está disponible.

Se prueban en orden y, si una falla, se pasa a la siguiente — Groq y NVIDIA van
primero porque tienen capa gratuita real y no dependen de que quede saldo:

1. **Groq** — gratis, sin tarjeta: <https://console.groq.com/keys>
2. **NVIDIA NIM** — capa gratuita: <https://build.nvidia.com/models>
3. OpenAI — de pago. **ChatGPT Plus no incluye API.**
4. Anthropic — de pago. **Claude Pro no incluye API.**

> No uses sitios de terceros que "regalan" claves de API. O son claves ajenas
> (te las revocan), o es un proxy que registra tus prompts, o es phishing.

Comandos del bot: `/pause`, `/resume`, `/status`.

---

## Cómo llegar a un 90% que sí valga

Un 90% útil no sale de afinar coeficientes. Sale de cambiar la pregunta.

### Probamos la pregunta correcta. Y hay un techo que no es del modelo

La hipótesis era: *"si fijamos el horizonte en 15 minutos, el tiempo deja de
dominar y las estadísticas del partido tendrán que importar"*.

Se pudo probar sin esperar semanas. La API de 365scores **sigue sirviendo el
timeline de goles de partidos de semanas atrás**, así que `backfill.js` recuperó
el minuto exacto de cada gol para los 548 partidos del histórico — 548/548, sin
un solo fallo.

Y con esos minutos se puede reconstruir el marcador en **cualquier** instante, lo
que convierte cada partido en ~14 observaciones en vez de 1:

```bash
node backfill.js       # recupera minutos de gol del histórico
npm run train:15       # rejilla temporal: 341 partidos -> 4.774 filas
```

Resultado sobre 4.774 filas, validado fuera de muestra: **AUC 0.530, skill 0%**.
Y la razón salta a la vista en la tasa base por minuto:

| Minuto | Gol en los próximos 15' |
|---|---|
| 10 | 33.7% |
| 30 | 36.4% |
| 50 | 39.3% |
| 70 | 41.3% |

Es **plana**. Los goles en fútbol llegan casi como un proceso de Poisson
homogéneo: la probabilidad de que caiga uno en los próximos 15 minutos apenas
depende de en qué minuto estés ni de cómo vaya el marcador.

### El 90% en ventana corta es imposible, y se demuestra

No es que no encontremos el modelo. Es aritmética:

```
P(gol en T minutos) = 1 - exp(-λ·T)
Para P ≥ 0.90  →  λ·T ≥ 2.30
```

| Ritmo del partido | λ (goles/min) | Minutos necesarios para un 90% |
|---|---|---|
| Típico (2.7 g/p) | 0.030 | **77 min** |
| Alto (3.5 g/p) | 0.039 | 59 min |
| Muy abierto (4.5 g/p) | 0.050 | 46 min |

En una ventana de 15 minutos harían falta **13.8 goles por partido** de ritmo
sostenido. Ningún partido de fútbol tiene ese ritmo — ni el más loco que hayas
visto.

**Un 90% de acierto exige tener 50–77 minutos por delante.** Por eso el gate
`PRECISION` dispara en el minuto 0–25 y no en el 70: no es una elección de
diseño, es la única región donde ese número existe. Ningún modelo, ninguna IA y
ninguna cantidad de datos cambia eso: lo fija el deporte.

### Lo que queda por probar

Todo lo medido hasta aquí usa **una sola foto por partido**. Que un equipo lleve
8 remates dice poco; que lleve 5 en los últimos 10 minutos es otra cosa. Esa
información —la trayectoria— nunca se guardó.

Desde v2.1 cada ronda escribe una línea por partido en `snapshots.jsonl`. Cada
partido pasa a aportar ~10 filas en vez de 1, repartidas por todo el encuentro, y
con eso se pueden calcular features de tendencia que hoy son imposibles.
`npm run audit` lleva la cuenta; con ~150 partidos se puede probar.

Es la última palanca disponible con datos gratuitos. Si tampoco aporta, la
conclusión honesta es que el volumen de juego no anticipa goles a corto plazo y
el valor hay que buscarlo en otro sitio: datos pre-partido (fuerza ofensiva y
defensiva de cada equipo, tipo Dixon-Coles), que son mucho más predictivos del
ritmo de goles que cualquier estadística en vivo.

**Y falta una pieza que no está en este feed:** 365scores solo expone cuota 1X2,
no over/under de goles. Para medir ventaja sobre el mercado de goles hace falta
otra fuente.

---

## Qué se arregló (v2)

- **`learn.js:318` — `predictedGoal is not defined`.** Un `ReferenceError` mataba
  la verificación entera en cuanto una predicción fallaba, y el `try/catch` de
  arriba se lo tragaba. `learn.js` se reemplazó por `verify.js`.
- **`sanitizeLeague()` decapitaba los nombres de liga.** La regex borraba la
  última palabra de 6+ letras: `Premier League` → `Premier`, `Copa Libertadores`
  → `Copa`. Colapsaba competiciones distintas en un mismo cubo. Ahora solo quita
  identificadores reales, y la clave canónica es `competitionId`.
- **El gate "100% de acierto" era n=3.** Sustituido por umbrales derivados de
  datos, con n≥20 e intervalo de confianza obligatorio.
- **La confianza del modelo estaba invertida.** Donde el motor anterior decía
  80–90%, la tasa real era 35.7%. Sumaba multiplicadores de urgencia justo cuando
  la tasa base se desploma. AUC 0.496 — azar puro.
- **93% de `weights.json` era estado muerto**, y `teams.json` (688 KB) se cargaba
  sin usarse. Ambos eliminados; el estado vivo cabe en `state.json`.
- **288 corridas/día → 144**, y Playwright solo para candidatos del tier VALOR.
- **`const fs = fsStats[key]`** sombreaba el módulo `fs`.

---

## Honestidad sobre la IA

No hay evidencia de que la IA mejore la precisión, y hay una razón para dudarlo:
si las estadísticas no correlacionan con el resultado, un modelo que lee esas
mismas estadísticas no puede sacar una señal que no está.

Se mantiene solo sobre el tier VALOR, y **cada decisión se guarda** en la
predicción (`aiDecision`). `npm run audit` compara la precisión de lo que la IA
dejó pasar contra lo que vetó. Si tras 30 decisiones no aporta, se quita.
