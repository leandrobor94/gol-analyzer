# LEARNINGS — lo aprendido, y los caminos ya cerrados

> **Este es el documento más valioso del traspaso.** Cada sección de aquí costó horas y
> cientos de llamadas a la API. Si retomas el proyecto sin leerlo, es casi seguro que
> repetirás un experimento que ya salió negativo.

---

## 1. El objetivo del ">90%" — cómo se resolvió

### 1.1 Se alcanza, y no vale nada

El sistema definía acierto como *"¿hubo algún gol entre el aviso y el final del partido?"*.
Esa pregunta la contesta el reloj. Tasa base medida sobre 548 partidos verificados:

| Minuto del aviso | n | Hubo gol antes del final |
|---|---|---|
| 0–20 | 60 | **96.7%** |
| 20–35 | 47 | 85.1% |
| 45–60 | 176 | 70.5% |
| 70–80 | 147 | 60.5% |
| 80–90 | 40 | 30.0% |
| 90–99 | 33 | 12.1% |

**Avisar a ciegas sobre cualquier partido antes del minuto 20 acierta el 96.7%, sin modelo
ninguno.** El gate de precisión llegaba al 96.4% por eso: dispara temprano. El propio
`train.js` mide e imprime el aporte del modelo sobre el reloj, y dio **0.0 puntos**.

### 1.2 En ventana corta es imposible, y se demuestra

No es falta de modelo, es aritmética:

```
P(gol en T minutos) = 1 − exp(−λ·T)
Para P ≥ 0.90  →  λ·T ≥ 2.30
```

| Ritmo del partido | λ (goles/min) | Minutos necesarios para 90% |
|---|---|---|
| Típico (2.7 g/p) | 0.030 | **77 min** |
| Alto (3.5 g/p) | 0.039 | 59 min |
| Muy abierto (4.5 g/p) | 0.050 | 46 min |

En una ventana de 15 minutos harían falta **13.8 goles por partido** de ritmo sostenido.
No existe. **Un 90% exige tener 50–77 minutos por delante.** Ninguna IA cambia esto.

`evaluate.js` imprime esta frontera en cada auditoría para que la conclusión no dependa de
que alguien la recuerde.

---

## 2. Experimentos NEGATIVOS ya realizados — no repetir

### 2.1 Las estadísticas del partido no predicen goles
**Ablación out-of-sample, n=245:**
```
solo tiempo + marcador     AUC = 0.647
+ TODAS las estadísticas   AUC = 0.647
                aporte:    0.000
```
Se probaron xG estimado, remates totales, remates al área, remates a puerta, ocasiones
claras, ataques, posesión, córners. Ninguna aporta.

Corroborado por correlación directa controlando el tiempo (min 45–80, n=361):
`corr(xG, gol) = −0.04`, `corr(SOT, gol) = −0.05`, `corr(ocasiones, gol) = −0.01`.

### 2.2 La etiqueta "gol en los próximos 15 minutos" tampoco funciona
La hipótesis era que fijando el horizonte, el tiempo dejaría de dominar y las estadísticas
tendrían que importar.

Se pudo probar **sin esperar semanas**: la API sirve `game.events[]` de partidos de semanas
atrás, así que `backfill.js` recuperó el minuto exacto de cada gol de los 548 partidos del
histórico (548/548, cero fallos).

- Modelo entrenado sobre 299 partidos: **AUC 0.508, skill −2%**
- Rejilla temporal (`train_grid.js`), 341 partidos → 4.774 filas: **AUC 0.530, skill 0%**

**Y la razón está en la tasa base por minuto, que es PLANA:**

| Minuto | Gol en los próximos 15' |
|---|---|
| 10 | 33.7% |
| 30 | 36.4% |
| 50 | 39.3% |
| 70 | 41.3% |

`model15.json` se publica **con cero gates a propósito**: un modelo que no discrimina no
debe alertar.

### 2.3 El momentum de goles NO existe
Probado sobre 4.875 observaciones de rejilla:

| Goles en los últimos 15 min | n | Gol en los próximos 15 |
|---|---|---|
| 0 | 3052 | 39.5% |
| 1 | 1432 | 37.5% |
| 2 | 350 | 38.3% |
| 3+ | 41 | 39.0% |

| Minutos sin gol | n | Gol en los próximos 15 |
|---|---|---|
| 0–10 (acaba de caer) | 1327 | 37.5% |
| 35+ (partido muerto) | 1088 | **41.5%** |

AUC de cada señal de trayectoria: **0.48–0.51**. Azar puro.

**Los goles llegan sin memoria.** Un partido con 3 goles en 15 minutos tiene la misma
probabilidad que uno que lleva 40 minutos en 0-0 — de hecho el muerto sale ligeramente por
delante. Eso es literalmente la definición de un proceso de Poisson.

### 2.4 Los córners tampoco son predecibles
Contra la intuición: `corr(ritmo de córners hasta ahora, córners restantes) = −0.030`,
n=259. Nada. Y el número de córners que quedan es ~3.9 de media **independientemente** del
ritmo previo.

### 2.5 La trayectoria NO se puede reconstruir del historial de git
Se comprobó: 68 commits con datos en 3 meses, separación mediana **81 minutos**, y
**máximo 2 fotos de un mismo partido**, cero partidos con ≥3. El sistema viejo sobrescribía
la misma fila cada ronda, así que cada commit guarda un solo estado por partido.

Tampoco hay desglose por periodo en la API: `game/stats` no trae `stageId` ni separación
1T/2T (verificado: 0 de 82 estadísticas lo tienen).

---

## 3. El hallazgo POSITIVO que queda abierto

**Descompuesto sobre 259 partidos, comparando el ritmo hasta el minuto X con lo que ocurre
después:**

| Evento | corr(ritmo actual, resto) |
|---|---|
| **Remates** | **0.607** ← señal fuerte |
| Tarjetas | 0.162 |
| Goles | 0.130 |
| Córners | −0.030 |

**Interpretación, y es la clave del proyecto:**

> El **tempo** del partido es estable y predecible. Lo **aleatorio** es la conversión de
> remates en goles.

Toda la auditoría estuvo midiendo la capa aleatoria (goles) y concluyendo "no hay señal".
La señal está en la capa de debajo. Los mercados de *total de remates* y *remates a puerta*
existen en las casas de apuestas, aunque 365scores no publique esas cuotas.

**Esta es la línea de trabajo más prometedora que queda.** Ver `TODO.md` #4.

---

## 4. Errores propios cometidos en esta sesión — patrón a evitar

### 4.1 Medir dentro de muestra y creerlo (EL MÁS GRAVE)

Medí que los ataques relativos (AUC 0.595) y la posesión (0.580) predecían quién marca,
mientras remates a puerta (0.483) y xG (0.494) no daban nada. Reescribí `teamSplit` con las
dos primeras, medí AUC 0.638, y **lo subí a producción**.

Estaba todo dentro de muestra. Validado en serio (5 pliegues temporales, ajustando solo en
train):

| Reparto | AUC | Brier |
|---|---|---|
| Viejo (remates/xG/área), escrito a ojo | **0.644** | **0.2368** |
| "Mejorado" (ataques rel. + posesión) | 0.538 | 0.2632 |

Bootstrap 2.000 remuestreos: el nuevo gana el **5.6%** de las veces. Revertido en `2b4a059`.

**Es exactamente el error que le audité al código original** (el gate calibrado con n=3),
cometido por mí y con más aparato estadístico encima, que es lo que lo hace más peligroso.

**Regla que sale de aquí:** ninguna medición cuenta si el ajuste y la evaluación tocan los
mismos datos. Ni las mías.

### 4.2 Generalizar desde un tramo con n pequeño

Afirmé "el modelo se queda un 43% corto con los equipos que dominan" a partir de UN tramo
con n=30. Mirando los cuatro tramos, las desviaciones iban en direcciones opuestas (ruido,
no sesgo) y un ajuste por máxima verosimilitud confirmó que los parámetros existentes ya
eran el óptimo. No había nada que corregir.

### 4.3 Confundir dos cuotas distintas

Puse el mínimo de 1.5 sobre **nuestra** cuota justa (1/p, que mide convicción) en vez de
sobre la de **la casa** (que mide premio). Como 1.5 equivale a 67%, eso excluía
mecánicamente todo análisis fuerte. Es el error que producía alertas del 57–59% cuando el
dueño pedía convicción alta.

### 4.4 Sobrescribir un modelo bueno con uno vacío

`train.js` escribía siempre en `model.json` aunque se pidiera la etiqueta `h15`, y
sobrescribió el modelo con gates por uno de 0 gates. Habría dejado el bot mudo en silencio.
Ahora hay una salvaguarda que exige `--force`.

---

## 5. Supuestos que resultaron falsos

| Supuesto | Realidad medida |
|---|---|
| "El xG es la mejor señal" | corr −0.04 con el resultado. El xG de 365scores es estimado y triple-cuenta el mismo remate |
| "Un equipo que domina va a marcar" | Dominio aplastante (>80%) → 62.5%. Techo real, no 80-90% |
| "Un equipo que va perdiendo empuja y marca" | **Al revés**: dominando y perdiendo, 0 de 7 marcaron. Suele dominar porque no sabe rematar |
| "Los córners son predecibles" | corr −0.03. Tan sin memoria como los goles |
| "La API no tiene cuotas de goles" | **Sí las tiene**, en `game.promotedPredictions` con `lineTypeId 3` |
| "Hay que esperar semanas para tener minutos de gol" | **No**: la API los sirve retroactivamente. `backfill.js` recuperó 548/548 |
| "El momentum reciente calienta el partido" | AUC 0.48–0.51. No existe |
| "Isotónica es mejor calibrador que Platt" | Con ~500 muestras la isotónica crea mesetas que empatan casos distintos y **destruye el orden**: AUC 0.731 → 0.709 |

---

## 6. Buenas prácticas descubiertas

1. **Ir a buscar el dato antes de asumir que no existe.** Dos veces en esta sesión di algo
   por imposible y estaba en la API: el timeline de goles retroactivo y el mercado
   Over/Under. Ambas veces cambió el proyecto.

2. **Elegir umbrales por el límite inferior del intervalo de confianza, no por la precisión
   puntual.** Así un "100% con n=3" nunca gana a un "93% con n=45". Implementado en
   `train.js`.

3. **Verificar el esquema de la API contra la API real antes de escribir el código que lo
   consume.** El campo de la línea Over/Under no está en el objeto `odds` sino en el título
   del contenedor; asumirlo habría producido código roto.

4. **Guardar la decisión con el dato, no solo el resultado.** Cada alerta congela su
   apuesta (`bet`) con la cuota que había. Sin eso el ROI real no se puede calcular después.

5. **Hacer que la herramienta diga la verdad incómoda sola.** `train.js` imprime el aporte
   del modelo sobre el reloj; `evaluate.js` imprime la frontera aritmética del 90%. Así la
   conclusión no depende de que alguien la recuerde.

6. **Distinguir fallo de orden y fallo de nivel.** El tier de equipo ordena bien (AUC
   0.644) pero está mal calibrado (dice 61%, acierta 33%). Son problemas distintos con
   soluciones distintas, y confundirlos me llevó a cambiar variables cuando había que
   calibrar la salida.
