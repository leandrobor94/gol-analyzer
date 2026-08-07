# KNOWN_ISSUES — problemas encontrados, resueltos y abiertos

---

## RESUELTOS

### P-1 · El motor no predecía nada (AUC 0.496)
**Causa:** suma de pesos con multiplicadores de urgencia que subían el score en los minutos
finales, cuando la tasa real de gol se desploma. La curva de calibración estaba
**invertida**: donde declaraba 80–90%, la tasa real era 35.7%.
**Solución:** reescritura completa como Poisson no homogéneo (D-1).
**Resultado:** AUC 0.496 → 0.731. Brier skill −65% → +15%.
**Riesgo residual:** el modelo nuevo sigue siendo esencialmente un reloj (ver A-1).

### P-2 · `learn.js:318` — `predictedGoal is not defined`
**Causa:** variable usada y nunca declarada. `ReferenceError` que mataba
`verifyPredictions()` entera en cuanto una predicción fallaba —el caso común— y abortaba
también las predicciones que venían después en la cola. Un `try/catch` de arriba se lo
tragaba e imprimía solo "Error en aprendizaje".
**Solución:** `learn.js` eliminado; sustituido por `verify.js`.
**Resuelto:** completamente.

### P-3 · `sanitizeLeague()` decapitaba los nombres de liga
**Causa:** la regex `/\s+[A-Z0-9]{6,}$/i` borra la última palabra de 6+ letras.
`Premier League` → `Premier`, `Copa Libertadores` → `Copa`.
**Solución:** ahora solo quita tokens que mezclen mayúsculas y dígitos (identificadores
reales). Clave canónica: `competitionId`.
**Riesgo residual:** quedan 26 nombres truncados en los datos históricos. `evaluate.js` los
cuenta y los reporta. No afectan al modelo actual (que no usa el nombre) pero sí a
cualquier análisis por liga sobre datos viejos.

### P-4 · El gate "100% de acierto" era n=3
**Causa:** umbral elegido mirando los mismos datos, sin exigencia de tamaño de muestra.
**Solución:** búsqueda con n≥20 y selección por límite inferior del IC de Wilson.

### P-5 · 93% de `weights.json` era estado muerto
**Causa:** migración a v4 que dejó las estructuras v3 sin desconectar. `analyzeGoal` solo
leía `w.betas`; `global`, `windows`, `byLeague` y `globalFallback` se recalculaban y
commiteaban cada ronda sin que nadie los leyera. Más `teams.json` (688 KB) cargado y pasado
como parámetro sin usarse.
**Solución:** eliminados.

### P-6 · Sombra del módulo `fs`
**Causa:** `const fs = fsStats[key]` dentro de un bloque tapaba el módulo `fs` de Node.
**Solución:** desapareció con la reescritura del orquestador.

### P-7 · `train.js` sobrescribía el modelo bueno
**Causa:** escribía siempre en `model.json` aunque se pidiera `--label h15`. Sobrescribió
un modelo con 2 gates por uno con 0.
**Solución:** respeta `--label`, y además se niega a reemplazar un modelo con gates por uno
sin gates sin `--force`.
**Riesgo evitado:** habría dejado el bot mudo **en silencio**.

### P-8 · Datos de cuotas corruptos producían "EV +71%"
**Causa:** el feed sirve bloques con 1X2 a rate `−1` y cuotas incoherentes con el estado
del partido.
**Solución:** cuatro guardas en `scores365.fetchGoalsMarket` (D-16).
**Riesgo residual:** las guardas son heurísticas. Pueden existir formas de corrupción no
cubiertas. La guarda de "ventaja implausible" es la red de seguridad final.

### P-9 · La clave de OpenAI estaba sin crédito
**Causa:** `exceeded your current quota`. El smoke test llevaba fallando desde antes de la
auditoría.
**Solución:** cascada de proveedores (Groq → NVIDIA → OpenAI → Anthropic) y `GROQ_API_KEY`
configurada. Verificado: `OK — IA lista. Provider: groq`.

### P-10 · Telegram con GET rompía en mensajes largos
**Solución:** POST con `URLSearchParams`.

---

## ABIERTOS

### A-1 · El modelo es un reloj bien vestido — **EL PROBLEMA CENTRAL**
**Síntoma:** las estadísticas aportan **0.000 de AUC** sobre tiempo + marcador (n=245 fuera
de muestra).
**Causa:** los goles llegan como un proceso de Poisson sin memoria. Está medido por cuatro
caminos independientes (ver `LEARNINGS.md` §2).
**Estado:** **sin resolver, y puede que no tenga solución por esta vía.**
**Camino abierto:** los remates SÍ son predecibles (corr 0.607). Cambiar de evento, no de
modelo. Ver `TODO.md` #4.

### A-2 · `teamSplit` está mal calibrado
**Síntoma:** en producción dijo 61% y acertó 33% (n=6). Los fallos son elocuentes: dijimos
"Marca Santiago Wanderers" y terminó **0-4**.
**Causa:** el reparto **ordena** razonablemente (AUC 0.644 fuera de muestra) pero el nivel
de la probabilidad es demasiado alto. Es fallo de calibración, no de variables.
**Intento fallido:** reemplazar las variables salió peor (D-14). **No repetir.**
**Solución correcta:** capa de calibración sobre la salida, con datos verificados.
**Bloqueo:** n=6. Hacen falta ~30 apuestas resueltas de ese tier.

### A-3 · GitHub Actions estrangula el cron — **BLOQUEA TODO LO DEMÁS**
**Síntoma:** el cron dice `*/10` pero `snapshots.jsonl` tiene huecos de 70+ minutos
(min 8 → min 81 del mismo partido). 288 líneas en un día cuando deberían ser ~4.000.
**Causa:** GitHub Actions retrasa y salta ejecuciones programadas, sobre todo con
frecuencias altas y en repos con poca actividad.
**Consecuencia:** el test de momentum de juego (la única hipótesis viva) **nunca llegará**
a tener datos con este ritmo.
**Opciones:** cron externo que dispare `workflow_dispatch` vía API; un runner propio; o un
servicio gratuito de cron. **Sin resolver esto, varias tareas del TODO son inalcanzables.**

### A-4 · Cobertura del mercado de goles: 40%
**Síntoma:** solo 10 de 25 partidos en vivo tienen línea Over/Under publicada, y solo de
BWIN.
**Mitigación actual:** sin cuota se avisa igual con el precio objetivo.
**Sin resolver:** no hay segunda fuente de cuotas.

### A-5 · Las cuotas no traen marca de tiempo
**Síntoma:** el objeto `odds` no tiene ningún campo temporal (verificado: `lineId`,
`gameId`, `bookmakerId`, `lineTypeId`, `lineType`, `link`, `bookmaker`, `options`,
`internalOption*`, `outcomeOptionNum`, `isConcluded`).
**Consecuencia:** no se puede saber si el precio está fresco.
**Mitigación:** el mensaje dice "verifica el precio antes de apostar".

### A-6 · Deuda: los gates entrenados ya no gobiernan
`train.js` sigue produciendo `gates` (ventana × umbral) que el gate por fase ya no usa, y
`evaluate.js` los reporta. Confunde. No es dañino.

### A-7 · Código muerto en `alert_gate.js`
`alertQuality`, `xgRemaining` y `bigChances` ya no los usa nadie. Borrables.

### A-8 · `flashscore_fetcher.js` sin auditar
Es la única dependencia pesada (Playwright) y su aporte no está medido. Su fallo no rompe
el ciclo, pero es la parte más cara.

### A-9 · SEGURIDAD: token de GitHub en texto plano
**Síntoma:** el clon de trabajo tiene un Personal Access Token incrustado en la URL del
remoto, en `.git/config`, sin cifrar.
**No está en el repo** — el historial está limpio — pero cualquiera con acceso a esa
carpeta o a una copia de seguridad del disco lo tiene.
**Acción pendiente del dueño:** rotarlo en GitHub → Settings → Developer settings → Tokens,
y reconfigurar el remoto sin credenciales incrustadas:
```bash
git remote set-url origin https://github.com/leandrobor94/gol-analyzer.git
```
