# START HERE — traspaso de gol-analyzer

Documento de entrada. Si acabas de llegar a este proyecto, **lee esto entero antes de
tocar una sola línea de código**.

---

## Qué es esto

`gol-analyzer` es un bot que analiza partidos de fútbol en vivo y manda alertas por
Telegram. Corre solo en GitHub Actions.

- **Repo:** https://github.com/leandrobor94/gol-analyzer
- **Clon de trabajo con push configurado:** `C:\Users\nitro 5034\Desktop\Nueva carpeta\gol-analyzer`
- **Dueño:** leandrobor94 (Leandro). Habla español; escribe siempre en español.
- **Último commit del traspaso:** `2b4a059`

---

## La única cosa que tienes que entender antes que nada

Este proyecto lleva una auditoría completa encima. La conclusión central, **medida
repetidamente y por caminos independientes**, es:

> **Las estadísticas del partido en vivo NO predicen los goles.**
> Lo único que informa es cuánto tiempo queda por jugar.

Esto no es una opinión ni una limitación de implementación. Está medido:

| Medición | Resultado | n |
|---|---|---|
| Ablación: tiempo+marcador vs +TODAS las estadísticas | **0.647 → 0.647** (aporte 0.000) | 245 fuera de muestra |
| Goles en los últimos 15 min → ¿predicen el siguiente? | AUC 0.48–0.51 (azar) | 4.875 |
| Modelo de "gol en 15 min" con rejilla temporal | AUC 0.530, skill 0% | 4.774 filas |
| Correlación stats↔gol controlando el tiempo | \|corr\| < 0.06 | 361 |

**Si tu primer instinto es "voy a añadir más estadísticas al modelo", párate.** Ya se
hizo, está medido, y no funciona. Lee `LEARNINGS.md` antes de repetirlo.

---

## El hallazgo que sí abre una puerta

Descubierto al final de la sesión y **no explotado todavía**:

| Evento | ¿El ritmo actual predice lo que queda? |
|---|---|
| **Remates** | **corr 0.607** ← señal fuerte |
| Tarjetas | 0.162 |
| Goles | 0.130 |
| Córners | −0.030 (nada) |

**El tempo del partido es predecible. Lo aleatorio es que el remate entre.**

Durante toda la auditoría estuvimos midiendo la capa aleatoria (goles) y concluyendo
"no hay señal", cuando la señal está en la capa de debajo (remates). Esto es la línea
de trabajo más prometedora que queda abierta. Ver `TODO.md` tarea #4.

---

## Orden de lectura recomendado

1. **START_HERE.md** (este archivo)
2. **PROJECT_OVERVIEW.md** — qué hace el sistema y cómo fluye
3. **LEARNINGS.md** — lo aprendido; **el más importante**, evita repetir trabajo muerto
4. **ARCHITECTURE.md** — módulos y responsabilidades
5. **FILES.md** — estado archivo por archivo
6. **DECISIONS.md** — qué se decidió y por qué, incluidas las reversiones
7. **KNOWN_ISSUES.md** — problemas abiertos y resueltos
8. **CURRENT_STATE.md** — qué funciona hoy exactamente
9. **TODO.md** — plan priorizado
10. **CONTEXT.md** — convenciones, límites y advertencias

---

## Comandos

```bash
npm ci
npm start          # una ronda de análisis (en local NO envía Telegram)
npm run train      # reentrena model.json (etiqueta "gol antes del final")
npm run train:15   # modelo de 15 min por rejilla temporal
npm run backfill   # recupera minutos de gol del histórico vía API
npm run audit      # re-auditoría completa
```

Para probar fuera del horario 7:00–22:00 Colombia: `FORCE_RUN=1 node run_flashscore.js`
Para saltar Playwright (lento): `ENABLE_FLASHSCORE=0`

---

## Cómo trabajar con el dueño

Leandro es exigente, técnico y **tiene buen olfato**. Varias veces en la sesión detectó
fallos reales antes que las mediciones. Cuando cuestione algo, la respuesta correcta casi
nunca es argumentar: es **medirlo**. Tiene una base de datos de 650+ partidos verificados
para hacerlo.

Reglas que impuso explícitamente y que hay que respetar:

- **Nada de parches de caso específico.** Toda corrección debe ser una regla general para
  la clase de fallo. (Está en su memoria de usuario como `solucionar-de-raiz-no-parchar`.)
- **No le entregues nada sin validar.** Pidió literalmente "dame con pruebas que lo que se
  hace y valida mejora lo que tenemos". Cumple eso.
- **La cuota de la casa no gobierna** las alertas (decisión suya, ver `DECISIONS.md` D-11).
- No le pases claves de API por chat; que las ponga él en GitHub Secrets.

---

## PROMPT PARA REANUDAR

Copia y pega esto en una conversación nueva:

```
Voy a continuar el proyecto gol-analyzer (github.com/leandrobor94/gol-analyzer).
El clon con push configurado está en:
C:\Users\nitro 5034\Desktop\Nueva carpeta\gol-analyzer

Hay un traspaso completo en la carpeta handoff/ de ese repo. Antes de proponer o
tocar nada:

1. Lee handoff/START_HERE.md entero.
2. Lee handoff/LEARNINGS.md — contiene los caminos ya descartados con sus
   mediciones. Es crítico: varias ideas "obvias" ya se probaron y fallaron, y
   repetirlas es perder el tiempo.
3. Lee handoff/CURRENT_STATE.md y handoff/TODO.md.

Reglas del proyecto que debes respetar:
- Nada entra a producción sin validación FUERA DE MUESTRA. Una medición hecha
  sobre los mismos datos con los que se ajustó no vale, y ya provocó una
  regresión en esta historia (ver DECISIONS.md D-14).
- Las correcciones son reglas generales, nunca parches de caso concreto.
- Responde en español.
- No inventes números: todo lo que afirmes sobre el rendimiento debe salir de
  ejecutar código contra predictions.json, no de los comentarios del código.

Cuando termines de leer, dime en qué estado está el proyecto según tu lectura y
cuál crees que debe ser el siguiente paso, y espera mi confirmación antes de
implementar nada.
```
