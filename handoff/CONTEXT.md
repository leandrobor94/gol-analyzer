# CONTEXT — convenciones, límites y advertencias

---

## 1. Convenciones del proyecto

### Idioma
- **Código y comentarios: español sin tildes** (para evitar problemas de codificación).
- **Documentación y mensajes de Telegram: español con tildes.**
- **Mensajes de commit: español**, con el porqué y las cifras. Terminan con
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Conversación con el dueño: español siempre.**

### Estilo de comentarios
Los comentarios explican **por qué**, no qué. Y cuando documentan un fallo medido, incluyen
la cifra y el n. Ejemplos reales del repo:

> `// Se usa Platt y no isotonica a proposito. Con ~500 muestras la isotonica crea`
> `// mesetas planas que empatan casos distintos y DESTRUYEN el orden — medido:`
> `// AUC 0.731 -> 0.709.`

**Esto es deliberado y hay que mantenerlo.** Es lo que impide que alguien "optimice" algo
que ya se probó.

### Naming
- `p` / `probability` — probabilidad 0–1 (motor nuevo)
- `predictedProbability` — 0–100 (motor viejo, solo en datos históricos)
- `lambda` — intensidad de gol por minuto
- `T` / `minsLeft` / `horizon` — minutos útiles restantes
- `fair` — cuota justa (1/p), mide **convicción**
- `odds` — cuota de la casa, mide **premio**
- `target` — precio mínimo al que compensa
- `tier` — `AVISO` / `VALOR` / `REJECT`
- `phase` — `1T` / `2T` / `FINAL`
- `kind` — `ANY` (gol de cualquiera) / `TEAM` (equipo concreto)

**Ojo con `fair` vs `odds`.** Confundirlas ya causó un error de diseño (D-12).

---

## 2. Limitaciones que no se pueden saltar

| Limitación | Detalle |
|---|---|
| **Aritmética del Poisson** | P ≥ 90% exige λ·T ≥ 2.30 → 50–77 minutos por delante. Ninguna IA lo cambia |
| **Cobertura de cuotas** | 40%, una sola casa (BWIN), sin marca de tiempo |
| **Solo cuota 1X2 y Over/Under de goles** | No hay mercados de remates ni de córners en el feed |
| **Sin desglose por periodo** | `game/stats` no separa 1T/2T (verificado: 0 de 82 stats tienen `stageId`) |
| **Sin xG real** | El de 365scores es estimado y no correlaciona. Flashscore lo da a veces, vía Playwright |
| **Cron estrangulado** | GitHub Actions no respeta `*/10` |
| **Historial de git inútil para trayectoria** | Máx 2 fotos por partido, 81 min entre commits |

---

## 3. Reglas internas del proyecto

1. **Ninguna medición cuenta si el ajuste y la evaluación tocan los mismos datos.**
   Incluidas las propias mejoras. Especialmente esas.
2. **Toda corrección es una regla general para la clase de fallo, nunca un parche de caso
   concreto.** Regla explícita del dueño.
3. **Sin modelo validado, el sistema no alerta.** Nunca se inventan pesos.
4. **Los umbrales se derivan de datos**, con n≥20 y por límite inferior de Wilson.
5. **La cuota nunca sustituye a nuestra probabilidad.** Es el precio, no el juez.
6. **Nunca estimar la cuota de la casa con nuestro modelo.** Sería circular.
7. **Los fallos de infraestructura de la IA no se registran como decisión de la IA.**
   Contaminaría la medición de su aporte.
8. **Ir a buscar el dato antes de asumir que no existe.** Dos veces en la sesión algo dado
   por imposible estaba en la API.

---

## 4. Comportamiento esperado

- **En local nunca se envía Telegram.** Solo lista los candidatos. El envío requiere
  `process.env.CI`.
- **Fuera del horario 7:00–22:00 Colombia el ciclo sale sin hacer nada.** `FORCE_RUN=1` lo
  salta.
- **Los conflictos de git en ficheros de datos son normales**: la nube commitea mientras se
  trabaja en local. Resolución habitual: `git checkout --ours` para los ficheros de datos
  (la nube es producción) y conservar el código propio.
- **`predictions.json` conserva 90 días de verificadas.** Las pendientes nunca se tiran.

---

## 5. ⚠️ ADVERTENCIAS — errores fáciles de cometer

### ⚠️ A) "Voy a añadir más estadísticas al modelo"
**El error más probable.** Ya se hizo. Aportan **0.000 de AUC** sobre tiempo+marcador
(n=245 fuera de muestra). Antes de intentarlo, lee `LEARNINGS.md` §2.

### ⚠️ B) Medir dentro de muestra y creerlo
Pasó en esta sesión y provocó una regresión en producción. Los AUC univariantes calculados
sobre todo el dataset **también** están inflados. Si vas a cambiar algo del modelo, la
comparación se hace con pliegues temporales y ajuste solo en train.

### ⚠️ C) Tocar `teamSplit` cambiando variables
Ya se intentó con las variables "mejores" y salió **peor** (AUC 0.644 → 0.538, bootstrap
5.6%). El problema es de **calibración**, no de variables. Ver A-2.

### ⚠️ D) Cambiar el orden de `FEATURES`
Invalida `model.json` **en silencio**. Añadir solo al final y reentrenar.

### ⚠️ E) Creer que `model15.json` con 0 gates es un bug
No lo es. Es un modelo que no discrimina (AUC 0.530) y por eso no alerta. Está así a
propósito.

### ⚠️ F) Interpretar el 96.4% del gate de precisión como un logro
Ese número es el reloj, no el juego. El propio `train.js` imprime que el aporte del modelo
ahí es **0.0 puntos**.

### ⚠️ G) Borrar los comentarios que documentan fallos
Son la memoria del proyecto. Sin ellos alguien repetirá el experimento.

### ⚠️ H) Renombrar `run_flashscore.js` sin actualizar todo
Aparece en `package.json` (`start`) y en `analyze.yml`. El nombre miente (la fuente es
365scores) pero cambiarlo sin cuidado rompe la nube.

### ⚠️ I) Confiar en las cuotas sin las guardas
El feed sirve bloques corruptos (1X2 a `−1`) que producían "EV +71%". Si se toca
`fetchGoalsMarket`, **no quitar las cuatro guardas**.

### ⚠️ J) Asumir que el cron funciona
No funciona. Cualquier plan que dependa de acumular datos a ritmo de 10 minutos está
bloqueado por A-3.

### ⚠️ K) Prometerle al dueño un ">90% útil"
Está demostrado imposible en ventana corta y trivial en ventana larga. Prometerlo otra vez
sería repetir el problema que originó toda esta auditoría.

---

## 6. Cosas difíciles de volver a descubrir

1. **El timeline de goles funciona retroactivamente.** `/web/game/?gameId=X` sirve
   `game.events[]` de partidos de **semanas atrás**. `eventType.id === 1` es gol, con
   `gameTime` + `addedTime` y `competitorId`. Esto ahorró 3 semanas de espera.

2. **El mercado Over/Under existe pero está escondido.**
   `game.promotedPredictions.predictions[].odds` con `lineTypeId === 3`. **La línea
   numérica NO está en el objeto `odds`** — está en el título del contenedor, formato
   `"Goles en el partido (2.5)"`. Asumir lo contrario produce código roto.

3. **`fetchLiveMatches` debe usar la fecha de Colombia.** Con UTC, pasada la medianoche se
   pide una fecha futura y la API devuelve 0 partidos.

4. **`NULL_STATS` existe porque `undefined !== null` es `true`.** Sin esa plantilla, los
   checks `!== null` dejaban entrar NaN a los cálculos.

5. **Los heredocs de bash y los parches con Python se comen los escapes** (`\n` se
   convierte en salto de línea real y rompe el JS). Para reescribir archivos usar la
   herramienta de escritura directa, no heredocs con contenido JS.

6. **`npm ci` tolera que el nombre del `package.json` no coincida con el lockfile**, pero
   conviene sincronizarlo igual.

7. **El dueño tiene un clon en `Desktop\Nueva carpeta\gol-analyzer`**, no en
   `Desktop\gol-analyzer`. Ese es el que tiene push configurado.

---

## 7. Cifras clave para tener a mano

| Métrica | Valor |
|---|---|
| AUC del motor original | 0.496 (azar) |
| AUC del motor actual | 0.731 fuera de muestra |
| Aporte de las estadísticas sobre el reloj | **0.000** |
| AUC del modelo de 15 min | 0.530 |
| corr(ritmo de remates, remates restantes) | **0.607** |
| corr(ritmo de goles, goles restantes) | 0.130 |
| corr(ritmo de córners, córners restantes) | −0.030 |
| Tasa base "gol antes del final" | 65.9% |
| Tasa base "gol en 15 min" | 37.8% |
| Techo de "marca un equipo concreto" | ~62% (dominio aplastante, n=32) |
| Tier 1T en producción | dijo 68%, acertó 64.7% (n=17) |
| Tier TEAM en producción | dijo 61%, acertó 33% (n=6) |
| λ típico | 0.030 goles/min (2.7 por partido) |
| λ necesario para 90% en 15 min | 0.154 (13.8 goles/partido) |
