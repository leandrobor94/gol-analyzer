# Estado actual — 13 de agosto de 2026

Fotografía del proyecto tras cinco días del bot corriendo con la captura de datos
arreglada (commits del 7-8 de agosto).

---

## Resumen en una línea

El modelo de goles está **cerrado por falta de ventaja** (no bate al reloj). La única
hipótesis viva es que la casa valore mal ciertos estados; con 128 apuestas medidas
**no hay ventaja demostrada**, aunque la línea 3.5 muestra un indicio que necesita
más muestra.

---

## 1. Captura de datos — 3 de 5 funcionando

Los cuatro agujeros detectados el 7 de agosto se taparon. Verificación en producción
sobre 1.043 predicciones nuevas (desde el 8 de agosto, 12:00 UTC):

| campo | estado | cobertura |
|---|---|---|
| `odds` (1X2) | ✅ funciona | 684 |
| `strength` (fuerza de equipo) | ✅ funciona | 441 |
| snapshots con cuota + hora | ✅ funciona | 6.792 de 8.823 |
| `goalsMarket` (línea de la casa) | ⚠️ funciona, cobertura baja | 130 (12%) |
| `finalStats` (estadísticas finales) | ❌ **ROTO en producción** | 0 |
| `bet.odds` (cuota de la apuesta) | ❌ **ROTO** | 9 de 375 |

**Dos siguen sin guardar.** Los dos se probaron localmente y funcionaban
(`finalStats` verificado sobre 2 partidos terminados: remates 5-11, corners 3-3), así
que el fallo está en el recorrido de producción, no en la función. **Es lo primero que
hay que mirar.**

Sin `bet.odds` no se puede calcular el ROI de las alertas. Sin `finalStats` no se puede
reverificar el modelo de remates con datos propios.

---

## 2. Alertas — el acierto está cayendo

| periodo | resueltas | acierto |
|---|---|---|
| hasta el 7 de agosto | 104 | 55.3% |
| **desde el 8 de agosto** | **271** | **35.4%** |
| acumulado | 375 | 40.8% |

La caída de 20 puntos con n=271 no es ruido. Coherente con lo medido el 7 de agosto:
el modelo no aporta nada sobre el reloj, así que su acierto tiende a la tasa base del
estado que le toque, no a un nivel estable.

**Recomendación vigente: no apostar con estas alertas.**

---

## 3. La hipótesis viva — ¿valora mal la casa?

La pregunta es si la casa se equivoca en un ESTADO concreto (marcador + minuto + liga),
que se identifica sin modelo. 128 apuestas donde el over seguía vivo al capturar la
línea (se excluyeron 6 ya decididas, el 4%):

| grupo | n | acierto | ROI | IC 95% | P(ROI>0) |
|---|---|---|---|---|---|
| todas | 128 | 46.9% | +2.2% | [-16%, +30%] | 67% |
| línea 2.5 | 93 | 43.0% | -7.1% | [-32%, +15%] | 24% |
| **línea 3.5** | **25** | **60.0%** | **+42.1%** | **[-10%, +94%]** | **95%** |
| cuota 1.5-4 | 88 | 43.2% | +3.0% | [-19%, +31%] | 65% |

**Lectura honesta: no hay ventaja demostrada.** El global (+2.2%) tiene un intervalo
que va de perder el 16% a ganar el 30%: no dice nada. La línea 2.5, que es la mayoría
de la muestra, sale negativa.

**La línea 3.5 es lo único interesante**: 60% de over cuando la cuota implica 37.7%, y
el 95% de las remuestras dan positivo. Pero n=25 y el intervalo llega a -10%. Es un
indicio para vigilar, **no un resultado**. Con n=25 y cuotas de 2.65, tres partidos
distintos le dan la vuelta.

**Siguiente paso concreto:** acumular la línea 3.5 hasta n≥60 y volver a medir. Si el
ROI sigue positivo con el intervalo por encima de cero, ahí hay algo.

---

## 4. Modelo — sin cambios y cerrado

`model.json` sigue siendo la versión de 536 partidos (AUC 0.7313). No se ha reentrenado.

Lo medido el 7 de agosto y que sigue vigente:

- El modelo **no bate al reloj**: AUC 0.6737 contra 0.7020 de mirar solo el minuto.
  Su top 30% acierta 83.0%; el del reloj, 87.5%.
- La fuerza de equipo está **calculada pero desactivada** (D-18): el +0.032 que la
  justificaba era fuga de las tablas actuales. Sin fuga, resta.
- Donde el acierto es alto la cuota es 1.10; donde la cuota es decente el acierto es
  57%. No hay ninguna franja donde ambos coincidan.

---

## 5. ⚠️ Números retirados por un fallo de método

**El bootstrap usado durante la sesión del 7 de agosto estaba roto.** El índice de
remuestreo era `(j*7919 + i*104729) % n`, que es determinista: producía **la misma
remuestra en las 2.000 iteraciones**, así que no había varianza y el resultado solo
podía salir 0% o 100%.

Quedan **retiradas** estas cifras concretas:

- "bootstrap: gana en el 100% de las remuestras" (fuerza por tabla, D-17)
- "bootstrap: gana en el 0.0% de las remuestras" (fuerza por historial, D-18)

**Las conclusiones de D-17 y D-18 se mantienen**, porque no dependían del bootstrap:
el careo sobre los mismos 136 partidos (0.5848 sin fuerza / 0.6143 con fuga / 0.5442
limpia) es una comparación directa y sigue siendo válido. Pero el respaldo estadístico
que se les atribuyó no existía.

El bootstrap correcto usa un generador congruencial con semilla y remuestrea filas
completas. Está en la última medición de este documento.

---

## 6. Qué hacer, en orden

1. **Arreglar `bet.odds` y `finalStats`** — funcionan en local y no en producción. Sin
   `bet.odds` no hay ROI de alertas posible, que es la métrica que importa.
2. **Subir la cobertura de `goalsMarket`** — 12% es poco. El tope es de 25 por ronda;
   revisar si el cuello está ahí o en que la casa no publica línea.
3. **Acumular la línea 3.5 hasta n≥60** y volver a medir. Es la única hipótesis viva.
4. **No apostar** con las alertas actuales mientras tanto.
5. **Rotar el token de GitHub** en texto plano en `.git/config` (pendiente del dueño
   desde el 7 de agosto).

---

## 7. Lo que NO hay que volver a intentar

Todo medido y descartado con datos:

| candidato | resultado |
|---|---|
| estadísticas en vivo (xG, remates, ocasiones) | -0.014 a -0.019 AUC |
| momentum de juego | AUC 0.48-0.51, n=4.875 |
| córners | correlación -0.03 |
| fuerza de equipo desde la tabla | era fuga; sin fuga, -0.041 AUC |
| filtro de IA (prompt original) | 0.0 puntos sobre n=54 |
| modelo 1X2 contra el precio | -33% a -47% de ROI |
| mercado de remates | el modelo funciona, pero el mercado solo existe en
partidos grandes, donde la casa es fuerte |

El test de contexto por IA quedó **sin ejecutar**: cuatro intentos, los cuatro
frustrados por infraestructura (export ausente, límite de tokens de Groq, thinking de
Gemini, timeout). El canal está verificado y funcionando (Gemini responde en ~800ms
con 3 claves), pero el test nunca produjo números.
