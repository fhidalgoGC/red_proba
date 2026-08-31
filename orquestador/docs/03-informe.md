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

**Los tres niveles están encadenados**: `seconds` es lo medido, `minutes` suma
sus segundos, `total` suma sus minutos. Si cada nivel se contara por su cuenta
podrían discrepar y no habría manera de saber cuál miente. Un descuadre acusa a
la agregación, nunca a la medición.

---

## Un segundo

```jsonc
{
  "seg": 4,                                  // 1-based desde el arranque
  "at": "2026-08-30T22:22:18.000Z",
  "target_per_s": 122,                       // la cuota que se sorteó
  "metrics": {
    "sent": {                                // el lado del ENVÍO — lo pone el reloj
      "count": 122,
      "weight": "270.7 KB",
      "dropped_lag": 0,                      // se pidió y no salió → culpa del arnés
      "dropped_saturation": 0                // el tope en vuelo estaba lleno
    },
    "completed": {                           // el lado de la RESPUESTA — lo pone C3
      "count": 113,
      "weight": "252.5 KB",
      "ok": 113,                             // 2xx
      "not_ok": 0,                           // 429, 503, 400…
      "failed": 0,                           // salió y NO volvió: timeout o red
      "latency_p50_ms": 890,
      "latency_p99_ms": 1459.4,
      "latency_max_ms": 1503,
      "latency_avg_ms": 858.7,
      "samples": 113                         // = completed.count
    }
  }
}
```

Misma forma en `minutes[]`, en `total` y en `resumen`.

### Por qué agrupado por etapa

Plano, los doce campos obligaban a recordar cuál pertenece a qué momento: `ok`
es del lado de la respuesta, `dropped_lag` del lado del envío, y los dos pesos
se leían como dos datos sueltos en vez de como el mismo dato en dos instantes
distintos.

Agrupado, la pregunta **«¿esto lo mide el reloj o lo mide el destino?»** se
contesta mirando en qué bloque cayó.

`failed` va en `completed` aunque no sea un completado: salió al cable y su
desenlace fue «no hubo respuesta». Ponerlo en `sent` lo confundiría con los
descartes, que ni llegaron a salir.

---

## `target_per_s` contra `sent.count`

Es la comparación que dice si la aleatoriedad hizo lo que prometía.

```
 seg  target  sent  completed
   1     142   142         33
   2     188   188        170
   3     123   123        195
   4     144   144        192
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
cat c3/logs/xx01__tenant-01.json | jq '.totales'
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
