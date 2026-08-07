# CHANGELOG — historia de la auditoría y reconstrucción

Sesión del **2026-08-05**. Punto de partida: `6c71c4b`. Punto final: `2b4a059`.

---

## Estado inicial (`6c71c4b`)

El sistema llevaba semanas corriendo y afirmaba en sus comentarios un "100% de acierto,
medido". La auditoría midió lo contrario:

- **AUC 0.496** — azar puro (n=548 verificadas)
- **Brier skill −65%** — peor que responder "66%" a todo
- **Curva de calibración invertida**: donde declaraba 80–90%, la tasa real era 35.7%
- El gate del "100%" se apoyaba en **3 casos** de 548
- `learn.js:318` lanzaba `ReferenceError` y mataba el aprendizaje entero, tragado por un
  `try/catch`
- `sanitizeLeague()` decapitaba los nombres de liga (`Premier League` → `Premier`)
- **93% de `weights.json`** era estado muerto, más `teams.json` (688 KB) sin usar
- 288 ejecuciones/día commiteando 2.3 MB

---

## Commits

### `0d430dd` — v2: modelo calibrado, gates derivados de datos, aprendizaje offline
Reescritura completa. Poisson no homogéneo, coeficientes por máxima verosimilitud,
calibración Platt fuera de pliegue, gates por búsqueda fuera de muestra con n≥20 y límite
inferior de Wilson. `learn.js` → `verify.js`. Estado muerto eliminado. Captura de minutos
de gol, cuota 1X2 y ritmo de liga. **AUC 0.496 → 0.731, skill −65% → +15%.**

### `d79a365` — lockfile sincronizado y pipefail en el reentrenamiento
Sin `pipefail`, `tee` enmascaraba un fallo de `train.js` y el job publicaría un modelo a
medias como si hubiera ido bien.

### `31dc700` — fallback entre proveedores de IA
El smoke test en la nube reveló que la clave de OpenAI devolvía `exceeded your current
quota`. Cascada de proveedores; si ninguno responde la alerta pasa sin filtrar y **no** se
registra como decisión de la IA.

### `c4b3d26` — backfill del histórico, modelo de 15 min probado, IA opcional de verdad
Descubrimiento: la API sirve el timeline de goles **retroactivamente**. `backfill.js`
recuperó el minuto exacto de cada gol de 548 partidos (548/548, cero fallos), lo que
permitió entrenar el modelo de horizonte corto sin esperar semanas.

**Resultado: AUC 0.508, skill −2%.** Con el tiempo controlado las estadísticas siguen sin
predecir. `model15.json` se publica con 0 gates a propósito.

Añadido `snapshots.jsonl` (trayectoria intra-partido). El tier VALOR deja de exigir clave
de IA.

### `06dc727` — proveedores unificados y reintento sin modo JSON
Soporte de NVIDIA NIM verificado contra el endpoint (103 modelos servidos).

### `24e4166` — modelo de 15 min sobre rejilla temporal + demostración del techo
`train_grid.js`: con el minuto de cada gol se reconstruye el marcador en cualquier instante
→ 341 partidos = 4.774 filas. **AUC 0.530.** La tasa base por minuto es **plana** (33.7% en
el 10 → 41.3% en el 70).

Y la demostración aritmética: P ≥ 0.90 exige λ·T ≥ 2.30 → 77 minutos con ritmo típico. En
15 minutos harían falta 13.8 goles/partido. **El 90% en ventana corta no lo impide el
modelo: lo impide el deporte.**

### `9086303` — gate por valor esperado, cuota mínima 1.5
Crítica del dueño: *"si me manda algo es para que al menos sea 1.5; lo que se gana para el
riesgo es absurdo"*. Descubrimiento del mercado Over/Under en `promotedPredictions`.
`model.probAtLeast` con cola de Poisson. Guardas contra datos corruptos tras encontrar un
partido con 1X2 a `−1` que producía "EV +71%".

### `f99ac28`/`5a39be1` — apuesta por fase del partido
Diseño del dueño: 1T → gol antes del descanso; 45–70 → equipo concreto; 70+ → cualquiera.
No es cosmético: es lo que sube la cuota justa al rango que compensa.

### `a4cefd1` — el mínimo de cuota va sobre la CASA, no sobre nuestra convicción
Corrección del dueño. Yo había aplicado el 1.5 a *nuestra* cuota justa, lo que excluía
mecánicamente todo análisis fuerte. Dos condiciones independientes: convicción ≥70% **y**
premio ≥1.5.

### `63a415b` — la cuota deja de decidir
Decisión del dueño: la cuota es el dato más frágil (40% cobertura, una casa, sin marca de
tiempo, a veces corrupta). Pasa a ser informativa. `MIN_PROB` a 0.55 porque el techo medido
para "marca un equipo" es ~62%.

### `f72d6ae` → `2b4a059` — reparto por equipo: cambio y **reversión**

**El episodio más instructivo de la sesión.**

Medí que ataques relativos (AUC 0.595) y posesión (0.580) predecían quién marca, mientras
remates a puerta (0.483) y xG (0.494) no. Reescribí `teamSplit`, medí **AUC 0.638** y lo
publiqué en `f72d6ae`.

El dueño exigió validación real. Con 5 pliegues temporales y ajuste solo en train:

| Reparto | AUC | Brier |
|---|---|---|
| Viejo (remates/xG), escrito a ojo | **0.644** | **0.2368** |
| "Mejorado" | 0.538 | 0.2632 |

Bootstrap 2.000 remuestreos: el nuevo ganaba el **5.6%**. Revertido en `2b4a059`.

**Era el mismo error que se auditó en el código original** —elegir por una medición dentro
de muestra— cometido de nuevo, con más aparato estadístico encima.

---

## Hallazgo final (posterior al último commit, sin implementar)

Descomposición sobre 259 partidos, ritmo actual vs resto:

| Evento | corr |
|---|---|
| **Remates** | **0.607** |
| Tarjetas | 0.162 |
| Goles | 0.130 |
| Córners | −0.030 |

**El tempo del partido es predecible; lo aleatorio es la conversión.** Toda la auditoría
midió la capa aleatoria. Es la línea más prometedora que queda abierta (`TODO.md` #4).

---

## Resumen de la trayectoria

| Métrica | Inicio | Final |
|---|---|---|
| AUC | 0.496 | 0.731 |
| Brier skill | −65% | +15% |
| Aprendizaje | roto (ReferenceError) | offline y validado |
| Umbrales | n=3, in-sample | n≥20, fuera de muestra, IC de Wilson |
| Estado muerto | 93% de weights + 688 KB | eliminado |
| Datos capturados | marcador y stats | + minuto de gol, lados, cuotas, ritmo de liga, trayectoria |
| Herramienta de auditoría | 3 scripts ad-hoc | `npm run audit` que recalcula todo |
| Honestidad | "100% medido" (n=3) | el propio entrenador imprime que aporta 0.0 puntos |
