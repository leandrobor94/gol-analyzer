# DECISIONS — decisiones de arquitectura, con su porqué

Formato: **qué se evaluó → qué se eligió → por qué → qué problema evita.**
Incluye decisiones revertidas, que son las más instructivas.

---

## D-1 · Poisson no homogéneo en vez de suma de factores

**Opciones:** (a) suma de pesos por estadística con multiplicadores de urgencia
(el motor original); (b) proceso de Poisson con λ = exp(b₀ + b·x) y P = 1 − exp(−λT).

**Elegida:** (b).

**Por qué:** en (a) el tiempo restante era un factor más que se multiplicaba a mano, y los
multiplicadores de urgencia subían el score en los minutos finales justo cuando la tasa
real de gol se desploma (del 60% al 12%). Resultado medido: AUC 0.496 y la curva de
calibración **invertida** en el tramo que disparaba las alertas (decía 80–90%, ocurría el
35.7%).

**Evita:** que la estructura temporal del problema se modele a mano y en la dirección
equivocada. En (b) el tiempo entra por la forma del modelo, no por un coeficiente.

---

## D-2 · Calibración de Platt, no isotónica

**Opciones:** isotónica (PAVA) o Platt (a·logit(p)+b).

**Elegida:** Platt.

**Por qué:** medido — con ~500 muestras la isotónica crea mesetas planas que empatan casos
distintos y **destruye el orden**: AUC 0.731 → 0.709. Platt es una transformación monótona
de 2 parámetros: corrige el nivel sin tocar el ranking y no se sobreajusta.

**Evita:** perder capacidad de discriminación al intentar arreglar la calibración.

---

## D-3 · Aprendizaje offline, nunca en vivo

**Opciones:** ajustar pesos cada ronda (original) o entrenar bajo demanda con validación.

**Elegida:** offline (`npm run train`).

**Por qué:** el motor original ajustaba con 1–5 partidos por ronda. Con esa muestra el
gradiente es ruido, y ese ruido quedaba **publicado en el repo** en cada commit. Además
había 49 `perLeagueBetas`, 44 de ellas con menos de 10 muestras.

**Evita:** que el modelo derive persiguiendo ruido sin que nadie lo note.

---

## D-4 · Los umbrales del gate se derivan de datos, no se escriben

**Por qué:** el gate original afirmaba "100% de acierto, medido" y se apoyaba en **3 casos**
de 548. Ahora la búsqueda exige n≥20 y elige por **límite inferior del intervalo de
Wilson**, no por precisión puntual.

**Evita:** que un "100% con n=3" gane a un "93% con n=45".

---

## D-5 · Calibración fuera de pliegue, siempre

**Por qué:** calibrar con predicciones in-sample infla el extremo alto — el modelo ya vio
esos partidos y su confianza ahí no es representativa. Es el error que hacía creer al motor
anterior que su tramo 80–90% valía algo.

---

## D-6 · Sin `model.json` entrenado, el sistema NO alerta

**Opciones:** pesos por defecto razonables, o negarse a alertar.

**Elegida:** negarse.

**Por qué:** unos pesos por defecto son una opinión disfrazada de medición. Si no hay
modelo validado, el sistema analiza y guarda datos pero calla.

---

## D-7 · `competitionId` como clave de liga, no el nombre

**Por qué:** `sanitizeLeague()` usaba `/\s+[A-Z0-9]{6,}$/i`, que borra la última palabra de
6+ letras: `Premier League` → `Premier`, `Copa Libertadores` → `Copa`, `Liga de Portugal` →
`Liga de`. Colapsaba competiciones distintas en el mismo cubo. El "campeonato" más grande
del dataset era **"Partido"** (101 muestras: todos los amistosos del planeta).

---

## D-8 · Snapshots append-only en JSONL, no dentro de `predictions.json`

**Por qué:** `predictions.json` guarda **una fila por partido** (se sobrescribe cada ronda),
lo que pierde la trayectoria. Un JSONL append-only permite escribir sin releer y produce un
diff por ronda que son solo las líneas nuevas. Con tope de 24 MB / 300k líneas para no
repetir el problema de bloat de `teams.json`.

---

## D-9 · Se eliminó todo el estado muerto

`weights.json` (93% nunca leído por el scorer), `teams.json` (688 KB cargados y no usados),
`learn.js`, los tres `_audit_*.js`. El estado vivo cabe en `state.json`.

---

## D-10 · La IA es opcional de verdad, y medible

**Por qué:** la precisión de los gates se midió **sin** IA, así que exigir una clave para
alertar contradecía el número prometido. Además no hay evidencia de que aporte: si las
estadísticas no predicen, un LLM que lee esas mismas estadísticas tampoco.

**Diseño:** filtra solo el tier que lo pide, cada decisión se guarda en `aiDecision`, y
`evaluate.js` compara lo que dejó pasar contra lo que vetó. Si tras 30 decisiones no
aporta, se quita. Los fallos de infraestructura **no** se registran como decisión.

---

## D-11 · La apuesta depende de la FASE del partido (decisión del dueño)

| Fase | Apuesta |
|---|---|
| 1T (<45) | Gol antes del descanso |
| 2T (45–70) | **Solo** gol de un equipo concreto |
| FINAL (>70) | Gol de cualquiera o de un equipo |

**Por qué:** acortar el horizonte o estrechar la apuesta sube la cuota justa al rango que
compensa el riesgo. "Habrá gol" en el minuto 20 es 95% a cuota 1.05; "gol antes del
descanso" es 58% a cuota 1.73.

**Nota importante:** los datos dicen que en 45–70 "gol de cualquiera" llega al 75–77%
mientras "marca un equipo concreto" no pasa de ~62%. Se planteó al dueño y la conversación
derivó hacia otro tema antes de resolverlo. **Queda pendiente confirmarlo con él.**

---

## D-12 · La cuota de la casa NO gobierna las alertas (decisión del dueño)

**Evolución de esta decisión, que es instructiva:**

1. Al principio el gate era por precisión. Producía avisos del 95% con cuota justa 1.05
   (arriesgar 100 para ganar 5). El dueño lo rechazó con razón.
2. Se cambió a valor esperado con cuota mínima 1.5. **Error mío:** apliqué el mínimo a
   *nuestra* cuota justa (que mide convicción) en vez de a la de *la casa* (que mide
   premio). Como 1.5 equivale a 67%, eso excluía mecánicamente todo análisis fuerte.
3. Corregido: son dos condiciones independientes (convicción nuestra alta **y** premio
   suficiente).
4. Finalmente el dueño decidió que la cuota **no influya en absoluto**, porque es el dato
   más frágil que hay: 40% de cobertura, una sola casa, sin marca de tiempo y a veces
   corrupta.

**Estado actual:** la cuota se muestra con su EV si existe, pero no abre ni cierra la
puerta. Cuando no hay cuota, **la alerta se manda igual** con el precio mínimo.

---

## D-13 · Nunca estimar la cuota de la casa con nuestro modelo

**Por qué:** sería circular. Compararíamos el modelo contra sí mismo, el EV saldría siempre
positivo y **todo parecería valor**. Es la forma clásica en que estos sistemas se mienten
solos. Cuando no hay precio, se dice "no hay precio" y se da el objetivo.

---

## D-14 · REVERTIDA — reparto por equipo con ataques relativos y posesión

**Qué se hizo:** medí que ataques relativos (AUC 0.595) y posesión (0.580) predecían quién
marca, mientras remates a puerta (0.483) y xG (0.494) no. Reescribí `teamSplit`, medí AUC
0.638 y lo publiqué.

**Por qué se revirtió:** todo estaba **dentro de muestra**. Validación honesta (5 pliegues
temporales, ajuste solo en train):

| Reparto | AUC | Brier |
|---|---|---|
| Viejo (remates/xG/área) | **0.644** | **0.2368** |
| "Mejorado" | 0.538 | 0.2632 |

Bootstrap 2.000 remuestreos: el nuevo ganaba el **5.6%** de las veces.

**Lección:** es el mismo error que se auditó en el código original (D-4), cometido de nuevo
y con más aparato estadístico encima, que es lo que lo hace más peligroso.

**Regla permanente:** ninguna medición cuenta si el ajuste y la evaluación tocan los mismos
datos. **Ni las propias.**

---

## D-15 · No reclamar ventaja sobre el mercado antes del minuto 25

**Por qué:** nuestro modelo no conoce a los equipos. Medido: en el minuto 9 sin
estadísticas λ = 0.0338, con estadísticas 0.0377 — prácticamente el promedio global. La
casa sí tiene modelos pre-partido. Un desacuerdo de 16–19 puntos ahí no es un precio malo:
es no saber nada y creer que sabemos.

---

## D-16 · Guardas contra datos corruptos del feed

**Por qué:** se encontró en vivo un partido con 1X2 a rate `−1` y una cuota Over 4.5 a 1.77
(implicaría 51% a que cayeran 4 goles en 53 minutos). Contra ese precio el modelo producía
**"EV +71%"**, que era puro artefacto. Si se hubiera enviado, habría costado dinero.

**Guardas:** rango de cuota [1.02, 60], overround en [1.0, 1.35], 1X2 coherente,
`isConcluded`, y rechazo si la ventaja supera 50 puntos (entre 25 y 50 se marca
`revisar: true` en vez de decidir por el usuario).

---

## Decisiones DESCARTADAS

| Idea | Por qué se descartó |
|---|---|
| Etiqueta "gol en 15 min" como objetivo del producto | Probada: AUC 0.508–0.530, no discrimina |
| Features de momentum desde el timeline de goles | Probadas: AUC 0.48–0.51, sin memoria |
| Reconstruir trayectoria del historial de git | Imposible: máx 2 fotos por partido, 81 min entre commits |
| Alertar sobre córners | corr −0.03, tan impredecibles como los goles |
| Sitios de terceros con claves de API gratis | Claves ajenas, proxies que registran prompts, o phishing |
| Usar la cuota 1X2 para el mercado de goles | Predecir quién gana no es predecir cuántos goles caen |

---

## D-17 · La fuerza de equipo entra como multiplicador de lambda (no como feature)

**Fecha:** 2026-08-07 · **Estado:** aplicado en produccion

**Que se decidio.** `scores365.fetchStandings()` deriva ataque y defensa de la tabla
(forma Dixon-Coles: goles a favor por partido / media de la liga). `strengthFactor()`
combina los dos equipos y devuelve un multiplicador acotado a **[0.65, 1.55]**.
`model.rawProb()` lo aplica sobre lambda. Sin tabla devuelve `null` y el modelo se
comporta **exactamente** como antes.

**Por que multiplicador y no una feature mas de la regresion.**
1. Los 783 partidos de entrenamiento no tienen la fuerza guardada: no hay con que
   ajustar un coeficiente. Se empieza a guardar ahora (campo `strength` en cada
   prediccion) para poder hacerlo bien en el proximo reentreno.
2. El factor esta centrado en 1.0 por construccion —es un ratio contra la media de
   la liga—, asi que la calibracion de Platt existente sigue valiendo en promedio.
   Un coeficiente libre no daria esa garantia sin recalibrar.

**Validacion de ESTA implementacion** (no del concepto: son cosas distintas y
confundirlas fue el error D-14). 141 partidos con tabla, tasa base 40.4%:

| | AUC | Brier | Top 20% |
|---|---|---|---|
| Sin fuerza | 0.5819 | 0.2361 | 46.4% |
| **Con fuerza** | **0.6140** | **0.2288** | **57.1%** |
| Diferencia | +0.0322 | +0.0073 | +10.7 pts |

Bootstrap 2.000 remuestras: la version con fuerza gana en el **100%**.

**Limites que van con el numero.**
- **Fuga de informacion:** las tablas usadas para medir son las de HOY e incluyen el
  resultado de los partidos que se predicen. El +0.032 es un **techo**, no una cifra
  limpia. Por eso la tabla se pide ahora EN VIVO y se guarda: dentro de unas semanas
  habra una medicion sin fuga. Es la razon principal del cambio.
- **Cobertura ~57%:** copas, amistosos y torneos entre ligas no publican tabla. Ahi
  `strength` es null y no se inventa nada.
- **Muestra corta:** el limite [0.65, 1.55] existe porque con 3-5 jornadas un equipo
  puede salir con atk 3.0, y eso dice que lleva tres partidos, no que marque el triple.

**Lo que NO se toco.** El filtro de IA sigue sin cablearse a esto. Sus tests fallan
todavia a nivel de infraestructura (limite de tokens/minuto de Groq), y un modulo cuyo
unico resultado medido es "no contesta" no entra en produccion.
