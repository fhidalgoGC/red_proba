# 03 — El informe

Cada batch escribe un JSON válido en `orquestador/logs/<prueba>.json`, con el
detalle **segundo a segundo** de cada tenant.

La otra mitad la escribe C3 en `c3/logs/<prueba>__<tenant>.json`, con el mismo
identificador. Restarlas es lo que responde P4: **desde un solo lado nunca
puedes distinguir «no lo mandé» de «lo mandé y no llegó».**

---

## La forma

```
logs/<prueba>.json
├── prueba · inicio · fin · duracion_s · cerrado_por
├── config      ← con qué parámetros corrió
├── resumen     ← el acumulado + el veredicto
└── tenants
    └── tenant-01
        ├── total      ← suma de los minutos
        ├── minutes[]  ← suma de los segundos de cada minuto
        └── seconds[]  ← LO MEDIDO
```

**Los niveles están encadenados**: `seconds` es lo medido, `minutes` suma sus
segundos, `hours` suma sus minutos, `total` suma el nivel más alto que exista.
Si cada nivel se contara por su cuenta podrían discrepar y no habría manera de
saber cuál miente. Un descuadre acusa a la agregación, nunca a la medición.

### Las ventanas grandes solo aparecen si hay algo que agrupar

```
seconds   siempre
minutes   solo con más de 60 segundos
hours     solo con más de 60 minutos
```

`minutes` en una corrida de 20 s sería un array de un elemento idéntico al
total, y `hours` en una de cinco minutos, lo mismo: ruido que hay que leer
entero para descubrir que no dice nada. El orden en el JSON es
**`total · seconds · minutes · hours`** — primero lo que se mira, y debajo el
detalle por si hace falta.

---

## Un segundo

```jsonc
{
  "seg": 4,                                  // 1-based desde el arranque
  "at": "2026-08-30T22:22:18.000Z",
  "metrics": {
    "request": {                             // NIVEL PETICIÓN HTTP
      "target_per_s": 33,                    // peticiones/s que se sortearon
      "sent": 33,                            // salieron al cable
      "completed": 45,                       // el destino respondió
      "ok": 45,                              // 2xx
      "not_ok": 0,                           // 429, 503, 400…
      "failed": 0,                           // salió y NO volvió: timeout o red
      "dropped_lag": 0,                      // se pidió y no salió → culpa del arnés
      "dropped_saturation": 0,               // el tope en vuelo estaba lleno
      "latency_p50_ms": 548.1,
      "latency_p99_ms": 1304,
      "latency_max_ms": 1304,
      "latency_avg_ms": 573.3,
      "samples": 45                          // muestras de latencia, una por respuesta
    },
    "events": {                              // NIVEL DOCUMENTO
      "sent": 114,
      "weight": "257.9 KB",
      "completed": 147,
      "weight_completed": "323.8 KB",
      "ok": 147,
      "not_ok": 0,
      "failed": 0,
      "dropped_lag": 0,
      "dropped_saturation": 0,
      "per_request": 3.45                    // media de documentos por petición
    }
  }
}
```

## Por qué dos niveles y no uno

`request.client` fija **peticiones/s**; `events.client`, **cuántos documentos
lleva cada una**. Son cosas distintas y mezclarlas hacía que el informe
contestara la pregunta equivocada:

```jsonc
// ANTES — dos unidades en el mismo objeto, sin decirlo
"target_per_s": 37,          // PETICIONES
"sent": { "count": 110 }     // EVENTOS
```

37 al lado de 110 parecía un exceso del 197%. No lo era: eran dos cosas
medidas en unidades distintas.

**El reparto no es arbitrario.** La latencia y los códigos HTTP viven en
`request` porque **una respuesta es una petición**, lleve un documento o veinte
— medir latencia «por evento» no significa nada. Los bytes viven en `events`
porque el peso es de los documentos, no del sobre HTTP.

Sin los dos niveles no se puede decir si el destino se satura **por petición**
(concurrencia HTTP) o **por evento** (la firma de KMS). Son cuellos distintos y
se arreglan de forma distinta.

### En el `total` faltan dos campos, a propósito

`target_per_s` no aparece: cada segundo tuvo el suyo, sorteado dentro del
rango, y promediarlos daría un número que ningún segundo persiguió. `samples`
tampoco: en el total siempre coincide con `completed`, y repetir el mismo
número con otro nombre invita a creer que son cosas distintas.

En las ventanas sí están, y `samples` ahí sí informa: si es **menor** que
`completed`, se alcanzó el techo de muestras por segundo y los percentiles
salen de una muestra, no de todo.

---

## `target_per_s` contra `request.sent`

Es la comparación que dice si la aleatoriedad hizo lo que prometía — y ahora
los dos números están en la **misma unidad**, que es todo el punto de haberlos
separado de los eventos.

```
 seg  target  sent  completed
   1      19    19          6
   2      33    33         45
   3      12    12         28
   4       7     7          6
```

- **`target == sent`** — el arnés cumplió su cuota.
- **`target > sent`** — no dio abasto: mira `dropped_lag` y `dropped_saturation`.
- **`sent ≠ completed` dentro de un segundo** — normal, es la latencia.

En los últimos segundos `target_per_s` es `null`: el reloj ya paró y el
planificador no sortea nada. Esos segundos solo reciben.

---

## Enviar no es completar

Lo que se envió en el segundo 5 puede completarse en el 7. **Casi nunca cuadran
dentro de un segundo, y siempre cuadran en el total.**

```
 seg   sent  completed   acum_sent  acum_completed   en_vuelo
   1     45          0          45               0          45
   5     75         54         279             165         114
  11     49         55         544             376         168
  16      0         13         544             531          13
  17      0          0         544             544           0   ← cierra
```

La columna `en_vuelo` —acumulado enviado menos acumulado completado— es **el
mejor indicador de saturación que tienes**. Si no vuelve a bajar cuando el
envío para, el destino dejó de drenar.

---

## Las latencias

Miden el viaje completo, desde `pool.request()` hasta la respuesta, y se anotan
**con los completados**. `samples` es exactamente `completed.count`.

| | |
|---|---|
| `latency_p50_ms` | mediana — **exacta** por segundo |
| `latency_p99_ms` | el 1% peor — **exacta** por segundo |
| `latency_max_ms` | el peor — exacta siempre |
| `latency_avg_ms` | la media — exacta siempre |

En `minutes` y `total` los **percentiles son aproximados**, ponderados por
número de muestras. Un percentil de percentiles no es el percentil real, y
calcularlo exacto pediría guardar cientos de millones de muestras. La media y
el máximo sí son exactos al agregar.

> ⚠ **Un timeout no aporta muestra.** Si el destino se ahoga y la mitad revienta
> por timeout, el p50 describe solo a los supervivientes, que son los rápidos.
> La latencia puede parecer buena justo cuando el sistema está peor. **Léela
> siempre junto a `failed`.**

Tope de **250 muestras por segundo y tenant**. A 2.000 ev/s entre 50 tenants
son ~40 por segundo, muy por debajo.

---

## El veredicto

Números sin conclusión obligan a leerlos dos veces.

```jsonc
"veredicto": {
  "ok": true,
  "notas": ["Todo lo enviado se completo: 1418 de 1418. Sin retraso del arnes, …"]
}
```

Cuando hay saturación **no se insinúa el culpable, se calcula**:

```
3105 descartados por saturacion: no llegaron a salir al cable.
⚠ EL CUELLO FUE EL EMISOR, no el destino: 32 conexiones ÷ 5.44s de latencia
= 6 req/s de techo, y se enviaron 53/s. Sube 'connections' a … o mas.
```

El umbral de `dropped_lag` es **proporcional**: 16 eventos de 4.187 es ruido de
frontera de segundo, no un arnés que no da abasto. Marcar eso como fallo
enseñaría a ignorar el veredicto.

---

## `cerrado_por`

| Valor | Qué significa |
|---|---|
| `fin del batch` | drenado limpio: no quedaba nada en vuelo |
| `fin del batch (quedaron respuestas sin volver)` | venció el techo de `timeout + 2 s`. `sent > completed` es legítimo aquí |
| `peticion HTTP` | se cerró desde `POST /batch/detener` |
| `apagado` | SIGTERM |

---

## Los tres números que mirar

**`sent.dropped_lag`** — si no es ~0, la corrida mide al orquestador y no a C3.
Ese batch no vale para conclusiones sobre el sistema.

**`sent.count` vs `completed.count` en el `total`** — si no cuadran y `failed`
es 0, el informe cerró antes de tiempo; `cerrado_por` lo dice.

**`completed.latency_p99_ms`** — sube antes que cualquier contador cuando el
destino empieza a ahogarse.

---

## La conciliación con C3

```bash
cat orquestador/logs/xx01.json | jq '.resumen.sent.count, .resumen.completed.count'
cat c3/logs/xx01__tenant-01.json | jq '.total.request, .total.events'
```

C3 mide el peso del **cuerpo crudo** que llegó por el cable, descontando el
envoltorio. Que coincida con los bytes canónicos del orquestador confirma que
el JCS del ajuste de tamaño produce exactamente lo que se serializa — es una
comprobación del canonicalizador hecha desde fuera, por otro proceso.

| Comparación | Qué significa |
|---|---|
| `ofrecidos > aceptados` | el destino no da abasto, o la red se comió algo |
| `aceptados > eventos` en C3 | **imposible** — si pasa, la contabilidad está mal |
| todo igual | la corrida cierra |

> Da a C3 sus **8 segundos de silencio** para cerrar la última ventana antes de
> conciliar. Una lectura temprana parece un descuadre y no lo es.


---

## Medido · 39 tenants en paralelo, 600 s

Corrida `test-deploy-39clients-600s-6-10-1-4` del 2026-09-01.
`request 6-10` peticiones/s agregadas, `events 1-4` documentos por petición,
reparto zipf, llegadas poisson.

| | |
|---|---|
| Ritmo sostenido | **781,3 ev/s** · p50 782, p95 829, p99 851 |
| Peticiones | 312,4/s · **2,5 documentos por petición** |
| Latencia HTTP | p50 **29,1 ms** · p99 50,2 ms |
| Peso | 1,44 GB canónicos · 2,21 GB en el cable (×1,53) |
| Ofrecidos → enviados | 468 787 → 468 785 (2 por redondeo del segundo) |
| Aceptados `202` | 468 612 |

### El paralelismo, demostrado desde los dos extremos

Que los 39 disparan a la vez no se supone: se mide, y con dos fuentes
independientes.

**Desde el planificador** — tenants con tráfico en cada segundo:

```
segundo 1 (parcial, 78 ms)    9 de 39
segundo 2                    39 de 39   1023 eventos
segundo 3                    39 de 39    578
segundo 4                    39 de 39    614
…                            39 de 39
```

**Desde C4**, que no sabe nada del planificador y solo ve sobres llegando:
agrupando su inbox por segundo, **hubo tres segundos en los que recibió
documentos de los 39 `party_id` distintos**. Esa medida es la fuerte: para que
ocurra, los 39 API tuvieron que recibir, firmar, cifrar, escribir su outbox y
publicar **en paralelo**. Si algo de la cadena fuera secuencial, se vería un
tenant por segundo.

De paso confirma que la pseudonimización es determinista y sin colisiones: 39
tenants dan exactamente 39 `party_id`, y C4 nunca ve el id real.

### Y en el código

El paralelismo no es una casualidad del despacho, es una regla:

> *«En este archivo NUNCA se hace `await` de un envío. `EmisorService.enviar()`
> devuelve un booleano, no una promesa. Si algún día alguien le pone un await,
> la prueba deja de medir lo que dice medir.»* — `planificador.service.ts`

Es **lazo abierto (O-02)**: dispara según el reloj, no según las respuestas. Si
esperases la respuesta para mandar lo siguiente, un sistema lento recibiría
menos carga y medirías un sistema que se ve sano porque nadie lo está
presionando — **omisión coordinada**, la forma más común de que una prueba de
carga mienta.

El segundo nivel es el `EmisorService`: **un `Pool` de undici por destino**, 39
pools independientes. Si un tenant se cuelga, no bloquea a los otros 38 — para
eso está el timeout explícito de O-05.

### Los errores, y cómo leerlos

173 documentos afectados de 468 785 (**0,037 %**), en **dos ráfagas** —el
segundo 381 y la ventana 477-492—. Del 492 al 600 no hubo ninguno: se recuperó
solo.

| | peticiones | documentos | ¿pérdida? |
|---|---|---|---|
| HTTP `500` | 43 | 105 | **Sí** — C3 falló antes del commit |
| `UND_ERR_HEADERS_TIMEOUT` | 24 | 68 | **66 no**, llegaron a C4 igual |

**Un timeout del arnés no es una pérdida.** El inbox de C4 acabó con 66
documentos *más* de los que este informe contó como `ok`. Por eso la
conciliación se hace contra las bases, no contra este archivo.

Pérdida real: **107 · 0,0228 %**, y los 107 salieron del mismo tenant — el único
con una tabla de outbox siete veces mayor que las demás. Ver
`c3/docs/06-configuracion.md`.
