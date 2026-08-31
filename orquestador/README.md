# orquestador — Driver de carga (track `O`)

Contenedor Fargate en su propia VPC. **Genera los documentos**, decide a qué
tenant le pega, cuántas veces y cuándo, y registra lo que ofreció contra lo que
le aceptaron.

**Es andamio.** Existe solo para la prueba y desaparece con ella. Que no se
cite después como parte del diseño del producto.

**Documentación completa: [docs/](docs/)** — cómo funciona, la API, el informe,
la configuración y las reglas que no se negocian.

> **Diagramas** — [`docs/diagramas.html`](docs/diagramas.html) (HTML
> autocontenido, se abre desde el disco) · publicado en
> [**claude.ai**](https://claude.ai/code/artifact/caafc080-acc9-4c54-8951-3902e3e1ed1d)

Diseño del track: [../docs/04-orquestador.md](../docs/04-orquestador.md)

---

## Cambio de diseño: el generador se mudó acá

Antes el orquestador mandaba `POST { n }` y **C3 generaba** los `n` payloads.
Ahora el orquestador construye los documentos y se los manda hechos.

| | Antes | Ahora |
|---|---|---|
| Genera el payload | C3 | **el orquestador** |
| Decide `rpf_id` / `sequence` | C3 | **el orquestador** |
| Cuerpo del request | `{ n: 40 }` | `{ documentos: [...] }` |
| C3 hace | generar, canonizar, firmar, cifrar, outbox | canonizar, firmar, cifrar, outbox |

**Por qué mejora la prueba, no solo la mueve:**

- **P4 se vuelve contestable.** El orquestador conoce cada `event_id` que
  emitió. La conciliación deja de ser «conté 2.457 filas» y pasa a ser «estos
  ids salieron, estos llegaron, estos faltan».
- **La medición queda más limpia.** [07-medicion](../docs/07-medicion.md) ya
  decía que la medición arranca *cuando el payload está listo* y que el
  generador queda **fuera** del alcance. Sacarlo de C3 alinea el código con lo
  que el documento ya afirmaba: `e0` pasa a ser «C3 recibió el documento y lo
  entrega al mapper», y generar deja de contaminar el tramo `e0→e6`.
- **`eventos_por_hilo` pasa a ser una perilla global.** Quien decide cómo se
  agrupan los eventos decide cuántos `MessageGroupId` distintos ve SQS, y por
  lo tanto si la prueba llega al techo de 300 msg/s por grupo (D-06). Esa
  decisión no puede vivir dentro de un tenant aislado.

**Lo que hay que vigilar:** el cuerpo del request pasó de 10 bytes a ~2,3 KB por
evento. A escala smoke es irrelevante (5,7 MB en toda la corrida). Al perfil de
2.000 ev/s son ~4,5 MB/s saliendo de un solo contenedor, y ahí el orquestador
**sí** podría volverse el cuello de botella. La defensa es `eventos_por_request`
y el contador `descartados_retraso` — ver más abajo.

---

## La trampa que el pool tenía que evitar

Las plantillas se pre-generan para que el orquestador sea rápido. Pero **reusar
una plantilla tal cual habría sido un error grave, no una optimización**:

> `MessageDeduplicationId` es el sha256 del payload canónico **en claro**. Dos
> envíos del mismo documento producen el mismo `payload_hash`, y SQS FIFO descarta
> el segundo **en silencio** durante su ventana de 5 minutos. Perderías la
> mayor parte de los eventos y P4 daría un falso negativo masivo, sin un solo
> error en los logs.

Por eso cada envío refresca los campos de identidad. El invariante de tamaño
sobrevive porque todos son de largo fijo salvo uno:

| Campo | Largo |
|---|---|
| `rpf_id`, `event_id` | UUID, 36 |
| `occurred_at` | ISO-8601, 24 |
| `party_id` | `hmac:` + 64 hex, 69 · ver [docs/06](docs/06-party-id-y-payload-hash.md) |
| `sequence` | entero, **variable** |

`sequence` es el único que mueve el tamaño, y su delta es exactamente la
diferencia de dígitos: se compensa recortando `padding`, en O(1) y sin
re-canonizar. Cada plantilla reserva 8 bytes de relleno justamente para eso.

El receptor de C3 cuenta `event_id` repetidos (`GET /status`) porque es la
manera más barata de detectar que esto se rompió.

---

## Tamaño de las plantillas

Variado, no fijo. `pool.tamano_bytes: [2048, 4096]`. **70 atributos hoja
fijos**, +8 por ítem.

**El piso está medido, no estimado** — y sobre el peor caso, no el medio. El
esqueleto del documento fiscal — los **70 atributos hoja** de
[02-payload](../docs/02-payload.md) — pesa hasta **1.864 bytes canónicos sin un
solo ítem**, y **2.024 con el ítem mínimo**. Un documento fiscal sin ítems no
existe. El mínimo admisible es **2.032** (2.024 + 8 de relleno reservado), y la
config lo rechaza por debajo; los 2 KB del defecto entran con 16 de margen.

Se mide sobre el peor caso porque el esqueleto oscila ~25 bytes según el largo
de los importes, del número de puerta y del nombre de calle. Un piso calibrado
con el caso medio pasa mil plantillas y revienta en la dos mil, en
`ajustarATamano`, a mitad del arranque del pool.

**El techo también está fijado por fuera:** 4.096 es el límite de `kms:Sign` con
`MessageType: RAW`, el que exige `ED25519_SHA_512`. A 4.096 bytes canónicos la
firma entra con **margen cero** — un byte más y falla en C3, con un error de KMS
que no apunta al generador.

`items_por_documento: [1, 5]` se recorta solo si no entra en el tamaño
sorteado: una plantilla de 2 KB no admite 5 ítems y el generador baja a los que
quepan en vez de fallar.

Tamaño fijo sigue siendo expresable: `tamano_bytes: 4096`.

### Verlas en disco

Las plantillas viven **solo en memoria** durante una corrida. Para inspeccionarlas:

```bash
npm run volcar                 # → salida/plantillas/ (1.000 JSON + indice.csv)
npm run volcar -- /otra/ruta
```

Escribe la forma **canónica** de cada una —la que se mide y la que C3 firma— más
un `indice.csv` con `archivo,bytes_canonicos,items,relleno`. Es reproducible: la
misma `pool.semilla` da las mismas 1.000 plantillas byte a byte.

`reset-scratch` **no las borra**: vacía `salida/` pero salta
`salida/plantillas/`. El manifiesto de expedientes es salida de una corrida; las
plantillas son entrada fija de la prueba.

**Consecuencia para la medición:** con tamaño variado, eventos/s y MB/s dejan
de ser la misma métrica. Cuál de las dos se aplana primero es lo que dice si el
límite es **por operación** (firma de KMS) o **por byte** (cifrado, red, cola).
`/status` reporta las dos.

---

## Modos

`perfil.yaml → modo`.

### `smoke` — corrida funcional

Un total fijo de eventos repartido entre los tenants, con un número aleatorio
de llamadas por tenant. Cada llamada es una **ráfaga**: sus eventos salen todos
a la vez, en requests concurrentes.

```yaml
smoke:
  eventos_totales: 2500
  llamadas_por_tenant: [10, 15]
  duracion_objetivo: 60s
```

### `carga` — la prueba de verdad

El perfil de fases de [04-orquestador](../docs/04-orquestador.md): ritmo
sostenido en eventos/segundo, con Zipf y Poisson.

⚠ Toda la curva vive por encima del límite por defecto de KMS (1.000 ops/s).
Sin el aumento de cuota, la prueba mide throttling en vez de arquitectura.

---

## Tareas

| | Qué | Dónde |
|---|---|---|
| `O-01` | Perfil como YAML, no como código | `config/perfil.yaml`, `src/config/` |
| `O-02` | **Lazo abierto** ⚠ | `src/planificador/planificador.service.ts` |
| `O-03` | Reparto Zipf entre tenants | `src/planificador/reparto.ts` |
| `O-04` | Llegadas de Poisson | `src/planificador/llegadas.ts` |
| `O-05` | Cliente HTTP con pool y timeouts | `src/emisor/emisor.service.ts` |
| `O-06` | **Ofrecido vs aceptado** ⚠ | `src/metricas/metricas.service.ts` |
| `O-07` | Endpoint `/status` | `src/metricas/status.controller.ts` |
| `O-08` | **Manifiesto de expedientes** ⚠ | `src/metricas/manifiesto.service.ts` |
| `O-09` | Conciliación contra C4 | `src/conciliacion/`, `src/cli/conciliar.ts` |

### Las dos que no se negocian

**`O-02` lazo abierto.** En este código significa una cosa concreta: en
`planificador.service.ts` **nunca se hace `await` de un envío**.
`EmisorService.enviar()` devuelve un booleano, no una promesa. Si alguien le
pone un `await`, un tenant lento recibiría menos carga y medirías un sistema
que se ve sano porque nadie lo está presionando — omisión coordinada.

**`O-06` ofrecido contra aceptado.** La contabilidad separa cuatro maneras de
que un evento no llegue, porque cada una acusa a un culpable distinto:

| Contador | Culpable |
|---|---|
| `descartados_retraso` | ⚠ **el arnés**. Si no es ~0, la corrida no mide C3: mide el orquestador. |
| `descartados_saturacion` | el tenant no drena tan rápido como se le ofrece. Es señal, no error. |
| `rechazados` | el tenant contestó != 2xx (429, 503, 400…). |
| `fallidos` | timeout o error de red. No hubo respuesta. |

---

## El manifiesto y la conciliación (`O-08` / `O-09`)

**El problema**: C4 sabe lo que llegó, pero no lo que tenía que llegar. Su
consulta de huecos compara el rango que ve contra los valores que tiene dentro,
y ese rango lo definen los propios datos que llegaron — así que si falta la
**cola** de un expediente, el `MAX` se desplaza y el rango sigue siendo denso.
Y un relay que se detiene con filas todavía pendientes en su outbox se lleva
justo la cola.

**La solución**: el orquestador decide `rpf_id` y `sequence`, así que es el
único que puede afirmar qué salió. Al cerrar la corrida escribe el manifiesto:

```json
{
  "rpf_id": "3c77b808-…", "tenant": "tenant-01",
  "emitidos":   [[1, 10]],
  "aceptados":  [[1, 9]],      ← el destino contestó 2xx: esto SÍ se le exige
  "rechazados": [[10, 10]],    ← contestó 503: nunca entró
  "fallidos":   [],
  "no_emitidos":[]             ← se planificó y no salió: es el arnés
}
```

Los rangos no son una optimización cosmética: en el perfil grande son 2,5
millones de expedientes, y la resta se hace sobre estructuras del tamaño del
número de huecos, que en una corrida sana es cero.

### Las tres cosas que hacen que el número sea defendible

1. **Se anota donde el evento sale por el cable** (`EmisorService`), no donde se
   planifica. Las secuencias se asignan segundos antes de disparar; anotarlas
   ahí contaría como emitido lo que solo estaba previsto.
2. **`no_emitidos` existe.** Un evento que el planificador no alcanzó a disparar
   deja un hueco en el espacio de secuencias que **no es un hueco del sistema**.
   Sin esa marca, la conciliación acusaría a C3 de perder eventos que nunca
   existieron.
3. **El tope se declara.** `ORQ_MANIFIESTO_TOPE` (200.000). Un manifiesto
   truncado nunca sale `ok`: un cero limpio sobre datos a medias es peor que no
   conciliar.

### Cruzarlo

```bash
cd c4          && npm run informe   -- --nombre <prueba> --desde <ISO>
cd orquestador && npm run conciliar -- logs/<prueba>__manifiesto.json \
                                       ../c4/logs/<prueba>__inbox.json
```

```
  PERDIDA              13   aceptado y ausente en C4      ← el defecto
  sin confirmar        19   salió y nadie contestó
  no emitidos           0   nunca salieron: arnés
  huecos interiores     1   ⚠ invalidan el orden
  colas truncadas       1
  expedientes idos      1
```

Los contadores de orden **solo miran lo exigible**: un hueco que dejó un 503 se
ve en el detalle, pero no dispara la métrica grave. Sale con código 1 si hay
pérdida.

### Probarlo sin AWS

```bash
npm run e2e:manifiesto
```

Levanta dos C3 de mentira, corre una corrida de verdad contra ellos y le quita
eventos al inbox a mano: una cola, un hueco interior y un expediente entero.
Comprueba que la conciliacion encuentra exactamente esos y ni uno mas — y que
con el inbox intacto el veredicto sale limpio pese a los 503.

## Registro de destinos

`config/tenants.yaml`. **Lo genera Terraform** con el mismo `for_each` que crea
los tenants, para que no se desincronice del inventario real.

```yaml
tenants:
  - id: tenant-01
    url: http://api-01.poc.local:3000
```

`peso` es opcional y es **todo o nada**: si algún tenant lo declara, todos
deben, y entonces manda el peso explícito sobre `reparto`.

---

## Uso

```bash
npm install
npm test                 # JCS con vectores fijos + invariante de tamaño + reparto
npm run build
npm start                # :3000 · Swagger en /docs · los batches se piden por HTTP

ORQ_CONFIG_DIR=/ruta npm start  # config desde otra carpeta
ORQ_LOGS_DIR=/ruta npm start    # logs a otra carpeta
```

| Endpoint | Qué |
|---|---|
| `GET /status` | ofrecido vs aceptado del último minuto, acumulado, config |
| `GET /status/tenants` | el desglose por tenant — el reparto Zipf se ve acá |
| `GET /status/serie?segundos=120` | la serie segundo a segundo (P2 y P3) |
| `GET /status/plan` | el reparto tal como lo calculó el planificador |


### Swagger — `http://localhost:3000/docs`

Toda la API, con «Try it out» y cinco ejemplos precargados: rangos de ritmo, un
solo cliente, el objetivo de la PoC, por total de eventos, y forzar el techo de
D-06. El receptor de C3 también tiene el suyo en `:3001/docs`.

### `POST /batch` lanza · `GET /batch/{id}` consulta

```bash
curl -X POST localhost:3000/batch -H 'content-type: application/json' -d '{
  "id": "xxt",
  "client": "all",
  "seconds": 20,
  "request": {
    "client":      { "min": 20,  "max": 60  },
    "all_tenants": { "min": 800, "max": 2300 }
  }
}'
```

**Devuelve 202 al momento. No espera.** Una petición HTTP abierta cinco minutos
la corta cualquier balanceador, y ahí te quedas sin informe aunque la corrida
siga viva. Lanzar y consultar por separado es lo único que funciona detrás de
un ALB, que es donde esto va a vivir.

```bash
curl localhost:3000/batch/xxt
# mientras corre  -> { "estado": "procesando", "fase": "enviando", "progreso": {...} }
# al terminar     -> { "estado": "terminado",  "resumen": {...}, "minutos": [...] }
```

| Campo | Por defecto | Qué hace |
|---|---|---|
| `id` | `corrida-<fecha>` | nombra los logs de los dos lados |
| `client` | todos | `"all"`, `1`, `"1"`, o `"tenant-02"` |
| `seconds` | 20 | duración |
| `request.client` | — | `{min,max}` ev/s **por cliente y por segundo** |
| `request.all_tenants` | — | `{min,max}` ev/s **agregados**, por segundo |
| `rate` | 40 | ritmo plano por tenant — excluyente con `request` |
| `events` | — | total en vez de ritmo — excluyente con los dos |
| `perRequest`, `concurrency`, `timeout` | del YAML | envío |
| `arrivals`, `spread`, `thread` | del YAML | poisson/uniforme, zipf/uniforme, D-06 |
| `seed`, `size`, `items`, `pool` | del YAML | reconstruyen el pool (~40 ms) |

Los rangos aceptan también `[min, max]` y un escalar.

**Los rangos gobiernan el ENVÍO, no la terminación.** Cada segundo se sortea un
ritmo nuevo dentro del rango, así la carga varía en vez de ser plana. Medido con
`{"min":20,"max":200}` sobre un cliente:

```
enviados/s:  57  92  184  106  184  197  132  194  126  61
```

Con `client` y `all_tenants` a la vez: se sortea el agregado, se reparte por
Zipf, se recorta cada cliente a su rango y el residuo se redistribuye entre los
que aún tienen margen, en una pasada. La coherencia se comprueba antes de
arrancar:

```
400  imposible: 2 cliente(s) a 100 ev/s como maximo suman 200,
     por debajo del minimo agregado de 500.
409  el batch 'xxt' ya esta corriendo
409  el batch 'xxt' ya termino — su informe ya existe y no se sobrescribe
```

Ese último 409 no es una molestia: sin él, repetir un id **sobrescribiría el
informe anterior en silencio**.

| Endpoint | Qué |
|---|---|
| `POST /batch` | lanza, 202 al momento |
| `GET /batch/{id}` | progreso en vivo, o el informe completo |
| `GET /batch` | los batches que hay |
| `POST /batch/detener` | corta el envío; el informe se cierra solo |

### Las tres etapas, que no son lo mismo

| | |
|---|---|
| `ofrecidos` | lo que el reloj pidió |
| `enviados` | lo que salió al cable — **envío** |
| `aceptados` | lo que el destino confirmó — **terminación** |

Un sistema que se atasca mantiene el envío y hunde la terminación. Si el arnés
regulara por terminación dejaría de presionar justo cuando empieza lo
interesante — omisión coordinada por la puerta de atrás.

### Los logs de las dos mitades

Cada corrida escribe en **los dos lados**, con el mismo identificador:

```
orquestador/logs/<prueba>.json               lo que se OFRECIO
orquestador/logs/<prueba>__manifiesto.json   que (rpf_id, sequence) SALIO
c3/logs/<prueba>__<tenant>.json              lo que se RECIBIO
c4/logs/<prueba>__inbox.json                 lo que LLEGO      (npm run informe)
orquestador/logs/<prueba>__conciliacion.json el veredicto P4   (npm run conciliar)
```

El identificador viaja en la cabecera `x-prueba-id` de cada request — en
cabecera y no dentro del documento, porque el payload se firma y meterle
metadatos de la prueba cambiaría lo que se firma. Es la misma regla que
mantiene las marcas de tiempo fuera del payload.

**Un objeto JSON válido por archivo**, con las ventanas de un minuto en
`minutos[]` y el acumulado en `resumen` / `totales`. Se abre en cualquier
editor y `jq .` lo formatea entero.

Se reescribe completo en cada ventana, con temporal + `rename`: si fallara a
media escritura, un archivo truncado se llevaría la corrida entera y no solo
la última ventana.

```jsonc
// orquestador/logs/xxt.json
{
  "prueba": "xxt", "inicio": "...", "duracion_s": 20, "cerrado_por": "peticion HTTP",
  "config":  { "destinos": ["tenant-01"], "reparto": {...}, "llegadas": {...}, ... },
  "resumen": { "ofrecidos": 800, "aceptados": 800, "deficit": 0,
               "descartados_retraso": 0, "descartados_saturacion": 0,
               "rechazados": 0, "fallidos": 0,
               "bytes_aceptados": 1839121, "eventos_por_s": 40, "mb_por_s": 0.088,
               "veredicto": { "ok": true, "notas": ["Todo lo ofrecido fue aceptado…"] } },
  "minutos": [ { "minuto": "...", "completo": false, "ofrecidos": 800, "aceptados": 800,
                 "ofrecidos_por_s": 40, "segundos_activos": 20,
                 "latencia_http_p50_ms": 2.3, "latencia_http_p95_ms": 3.1 } ],
  "por_tenant": [ ... ]
}

// c3/logs/xxt__tenant-01.json   (detalle por SEGUNDO; ver c3/docs/07-medicion.md)
{
  "prueba": "xxt", "tenant": "tenant-01", "actualizado": "...",
  "total":   { "request": { "init": 800, "completed": 800, "failed": 0, ... },
               "events":  { "init": 800, "completed": 800, "bytes": 1839121,
                            "event_ids_unicos": 800, "event_ids_duplicados": 0,
                            "steps": { "canonical": {...}, "sign": {...}, ... } },
               "sqs":     { "batches": 80, "messages": 800, "ok": 800, ... } },
  "seconds": [ { "seg": 1, "at": "...", "metrics": { ... } } ],
  "minutes": [ ... ]
}
```

**Por qué las dos mitades y no una.** Desde un solo lado nunca puedes
distinguir «no lo mandé» de «lo mandé y no llegó». Restando:

| | Qué significa |
|---|---|
| `ofrecidos > aceptados` | el destino no da abasto, o la red se comió algo |
| `aceptados > eventos` en C3 | imposible — si pasa, la contabilidad está mal |
| `ofrecidos = aceptados = eventos` | la corrida cierra |

**Cuándo se escribe una línea.** El bucket es el minuto, pero esperar al
cambio de minuto dejaría sin log una corrida de 20 segundos: terminarías la
prueba y el archivo seguiría vacío. Una línea se cierra cuando el minuto
termina (`completo: true`), cuando la prueba lleva 8 s callada, o al apagar el
proceso. La línea dice cuál fue, para que nadie confunda un minuto parcial con
un minuto flojo.

Los ritmos se calculan sobre los **segundos activos**, no sobre 60: en un
minuto parcial dividir por 60 daría un ritmo inventado hacia abajo.

**Conciliación medida** de un batch de 12 s a los dos tenants:

```
  ORQ  ofrecidos 1534 · aceptados 1534 · bytes 3528026
  C3   eventos   1534                    bytes 3528026
  duplicados: 0                            ✓ CIERRA
```

Los bytes coinciden **exactamente** y eso no es casualidad: el orquestador
cuenta bytes canónicos de sus plantillas y C3 los mide del cuerpo crudo que
llegó por el cable, descontando el envoltorio. Que den lo mismo confirma que
el JCS del ajuste de tamaño produce exactamente lo que se serializa.

### Ver las plantillas

Las 1.000 plantillas viven **solo en memoria**: se construyen al arrancar desde
`pool.semilla` y no se lee ni se escribe ningún archivo. La reproducibilidad
viene de la semilla, no del disco.

Para inspeccionarlas:

```bash
npm run volcar            # -> salida/plantillas/ + indice.csv + histograma
```

El único campo que no se reproduce es `padding`: usa `randomBytes` a propósito,
porque su contenido no se firma y solo importa su largo.

---

## Corrida de verificación local

```bash
# dos receptores de C3
PORT=3001 node ../c3/dist/main.js &
PORT=3002 node ../c3/dist/main.js &
npm start
```

Resultado esperado (2 tenants, Zipf, 2.500 eventos):

```
ofrecidos 2500 · aceptados 2500 · descartados 0 · fallidos 0
tenant-01: 1667 eventos, 1667 event_id únicos, 0 duplicados
tenant-02:  833 eventos,  833 event_id únicos, 0 duplicados
bytes en el receptor == bytes canónicos del orquestador (5.724.475)
```

⚠ **Dimensiona `concurrencia_por_tenant` contra la ráfaga, no contra el ritmo
medio.** Con `eventos_por_request: 1` una llamada de smoke dispara sus N
eventos de golpe. Con 2 tenants y Zipf, al grande le tocan ráfagas de ~120: un
tope de 64 le descartaba un tercio de la corrida y P4 quedaba sin respuesta.

---

## Red

Corre **dentro de la VPC de C3**, en `sg-orq` (ORQ-06). Sin peering: resuelve
`api-NN.poc.local` por Cloud Map, que ya vive en esa VPC, y llega al API por
8080. No alcanza ninguna base — su SG no está en el ingress de 5432 de ningún
tenant.

**No se conecta a C4 en absoluto**, ni por red ni por IAM: del lado de C3 no hay
ruta hacia C4, su task role no tiene `sqs` ni `kms`, y la resource policy de la
cola solo nombra a los roles de C3 y C4. Si necesita verificar lo que llegó, lee
métricas, no la cola.
