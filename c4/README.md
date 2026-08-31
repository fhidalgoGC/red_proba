# c4 — Contenedor consumidor (track `G`)

El **operador neutro**. Consume de la cola FIFO, descifra, verifica la firma y
persiste.

Termina cuando el evento queda guardado en el Postgres de C4 — ese COMMIT es
`e10`, **el final de la medición**.

**Documentación completa: [docs/](docs/)** — cómo funciona, la criptografía, la
base, la medición, la configuración, las reglas y las pruebas.

> **Diagramas** — [`docs/diagramas.html`](docs/diagramas.html) (HTML
> autocontenido, se abre desde el disco) · publicado en
> [**claude.ai**](https://claude.ai/code/artifact/80828c05-58ef-4586-9ad8-80bb80d0a344)

Diseño del track: [../docs/05-contenedor-c4.md](../docs/05-contenedor-c4.md)

## Estado

| Tarea | Estado |
|---|---|
| `G-01` Consumidor FIFO con long polling | ✅ |
| `G-02` Descifrado y verificación, en ese orden | ✅ |
| `G-03` Inbox e idempotencia | ✅ |
| `G-04` Proyección a los cinco schemas | ✅ |
| `G-05` Detección de huecos | ✅ |
| `G-06` Marcas de tiempo `e7..e10` | ✅ (+ `e7b`, ver abajo) |
| `G-07` Manejo de DLQ | ✅ |
| `G-08` Volcado del inbox para conciliar | ✅ (`npm run informe`) |
| `G-09` Endpoint de salud (`/health`, `/status`) | ✅ |

**El informe se saca por CLI**, no por HTTP:

```bash
npm run informe -- --nombre <prueba> --desde <ISO>   # → c4/logs/<prueba>__inbox.json
```

Ese archivo es la mitad «llegó» de P4; la otra la escribe el orquestador y las
cruza `npm run conciliar` (ver `orquestador/README.md`). `G-05` por sí solo ve
únicamente huecos **interiores** — una cola truncada o un expediente perdido
entero son invisibles desde aquí, porque el rango con el que compara sale de los
propios datos que llegaron.

**Sigue sin ser un API.** La cola es su única entrada y el Postgres su única
salida; lo único que sirve por HTTP es su propia salud (`G-09`):

```bash
curl localhost:3003/health    # ok, base, cola, estado del consumidor
curl localhost:3003/status    # solo contadores, no toca la base
open  http://localhost:3003/docs   # Swagger
```

Ese endpoint existe porque **un proceso vivo no dice nada**: C4 puede estar
corriendo con el Postgres caído y seguir sacando mensajes de la cola — los
borraría sin persistir y P4 daría de menos, sin un solo error visible desde
fuera. Por eso `ok` refleja **la base**, no el proceso, igual que en C3 (C-08).

Documentado en Swagger, como C3 y el orquestador: **`http://localhost:3003/docs`**.

Escucha en `127.0.0.1`, así que la task definition de `terraform/modules/c4`
sigue **sin `portMappings` y sin balanceador** — el único que lo consulta es el
`healthCheck` de la propia task, desde dentro del contenedor. Y con
`C4_PORT=0` arranca como contexto puro, sin abrir nada: exactamente como corría
antes de `G-09`.

## El camino de un mensaje

```
ReceiveMessage (lote 10, long polling 20 s)
  → e7   llegó el lote
  → e7b  le toca a este mensaje
  → ¿tiene forma de sobre?           no → DLQ con alarma
  → Decrypt de la edk (cache) + AES-256-GCM
  → e8   descifrado                  falla → DLQ con alarma
  → verificación Ed25519 LOCAL
  → e9   verificado                  falla → DLQ con alarma
  → ¿grupo == rpf_id? ¿dedup declarado == recalculado? ¿rpf_id es UUID?
  → [ TRANSACCIÓN: inbox + los cinco schemas ]
  → e10  después del COMMIT          falla → NO se borra, que SQS reentregue
  → DeleteMessageBatch
```

### La verificación es local, no `kms:Verify`

Se baja la llave pública una vez con `GetPublicKey`, se cachea y se verifica
en proceso con `node:crypto`. Dos razones, y la segunda es la que importa:

1. `Verify` sería una llamada de red por evento (~30 ms) contra una cuota que
   comparten los 50 tenants. C4 se saturaría en KMS antes que en cualquier
   componente que la PoC quiere medir, y **P3 respondería «el límite es KMS»
   por un motivo que es de implementación**.
2. La llave pública es pública: verificar en proceso da exactamente la misma
   garantía y deja escrito que C4 solo necesita `GetPublicKey`, **nunca
   `Sign`**. El invariante de la regla 7 se vuelve visible en el código, no
   solo en la policy.

### ⚠ `C4_LLAVES_FIRMA` no es opcional en serio

`key_id` viaja **dentro del sobre y lo escribió quien publicó**. Si C4 fuera a
buscar la llave que el propio mensaje pide, cualquiera con permiso de publicar
en la cola podría firmar con **su** llave, poner su ARN en `key_id`, y la
firma verificaría perfectamente.

Sin lista blanca, la verificación prueba **integridad**. Solo con lista blanca
prueba **autoría**. El proceso arranca sin ella, pero grita en el log.

## Los cinco schemas (`G-04`)

| Tabla | Qué es |
|---|---|
| `journal` | Append-only. El libro. Un `INSERT`, nunca un `UPDATE`. |
| `case_header` | El expediente consultable: primer/último evento, rango de `sequence`, totales. |
| `shared_map` | Con quién opera cada participante, sin saber quién es ninguno. |
| `policy_registry` | Qué `event_type` y qué `schema_version` están en curso. |
| `key_registry` | Qué llave cubrió qué eventos. Es lo que permite acotar el daño el día que una se rote o se comprometa. |

Más `inbox` (la clave de la idempotencia) y `descartes` (la evidencia de
`G-07`). El esquema se aplica solo al arrancar y es idempotente.

## `G-07` · DLQ: dos caminos distintos

| Caso | Quién mueve el mensaje | C4 borra de la principal |
|---|---|---|
| Falla la **proyección** (base caída, pool agotado) | **SQS**, por redrive automático a las 5 recepciones | ❌ lo deja vencer |
| No **descifra** / no **verifica** / no cuadra | **C4**, `SendMessage` explícito + alarma | ✅ en el acto |

**Por qué el veneno se manda a mano.** `MessageGroupId = rpf_id`, y en FIFO un
mensaje sin borrar **bloquea la cabeza de su grupo**. Dejarlo al redrive
automático cuesta 5 recepciones × 60 s de visibility = **5 minutos con toda la
secuencia de ese expediente congelada**, y `G-05` reportaría un hueco que no es
un hueco: un falso positivo en la única métrica que afirma que el orden se
mantuvo.

**Por qué el conteo no vive en la cola.** Al republicar se conserva el
`payload_hash` original, así que un mismo veneno repetido se descarta en silencio
durante 5 minutos. Es lo deseable —no se duplica la evidencia— pero implica
que la **profundidad de la DLQ no sirve para contar**. El conteo vive en
`descartes`, y por eso `P4` cierra:

```
ofrecidos = persistidos + duplicados + descartes + en_vuelo
```

C4 **mira** la profundidad de la DLQ, no la consume: leerla y borrarla
destruiría la evidencia. Drenarla es una herramienta aparte y manual
(`test/drenar-dlq.ts`).

## `e7b`, la marca que no está en 07-medicion

`e7` es «llegó el lote»: los hasta 10 mensajes de un `ReceiveMessage` llegan en
el mismo instante, pero se procesan en serie. Sin `e7b`, el tramo `e7→e8` del
último mensaje del lote **incluye el procesamiento de los nueve anteriores**.

En la corrida de prueba eso se ve claro:

```
e7 → e10 medio    402 ms
  espera en lote  358 ms   ← esto NO es descifrado
  descifrado       18 ms
  verificación     18 ms
  persistencia      7 ms
```

Sin separarlo, el informe habría dicho «descifrar tarda 400 ms» y `P3` habría
señalado al componente equivocado. (Y aún así, esos 18 ms son medias que
cargan con la primera llamada del proceso: un `Decrypt` de KMS y un
`GetPublicKey` repartidos entre 12 eventos. En régimen, verificar es
sub-milisegundo.)

## Correrlo

```bash
npm ci && npm run build

AWS_REGION=us-west-2 \
SQS_QUEUE_URL=https://sqs.<region>.amazonaws.com/<cuenta>/rpf-one-eventos.fifo \
SQS_DLQ_URL=https://sqs.<region>.amazonaws.com/<cuenta>/rpf-one-eventos-dlq.fifo \
DATABASE_URL=postgres://usuario:clave@host:5432/c4 \
KMS_ENCRYPT_KEY_ID=arn:aws:kms:...:key/... \
C4_LLAVES_FIRMA=arn:aws:kms:...:key/... \
node dist/main.js
```

| Variable | Defecto | Qué hace |
|---|---|---|
| `SQS_QUEUE_URL` | — | **Obligatoria.** Sin ella el proceso muere al arrancar. |
| `DATABASE_URL` | — | **Obligatoria.** Sin base no hay `e10`. |
| `SQS_DLQ_URL` | — | Sin ella el veneno se cuenta y se borra, pero no queda evidencia en cola. |
| `C4_LLAVES_FIRMA` | — | Lista blanca de `key_id` aceptados, separados por coma. Ver arriba. |
| `KMS_ENCRYPT_KEY_ID` | — | Se le pasa a `Decrypt` para que un blob ajeno falle diciendo que no es de aquí. |
| `AWS_REGION` | de la URL | Región de los clientes. |
| `C4_ESQUEMA` | `c4` | Esquema de Postgres. |
| `SQS_BATCH_SIZE` | `10` | Tope duro: 10. |
| `SQS_WAIT_SECONDS` | `20` | Long polling. Tope duro: 20. |
| `C4_BORRAR` | `true` | `false` = espiar la cola sin consumirla. **Modo inspección, no de corrida.** |
| `C4_BD_POOL` | `10` | Conexiones del pool. |
| `C4_GUARDAR_PAYLOAD` | `true` | Guardar el documento en claro en el `journal`. |
| `C4_RESUMEN_MS` | `10000` | Cada cuánto sale el resumen. |
| `C4_SALIR_TRAS_VACIOS` | `0` | Salir tras N ciclos vacíos seguidos. `0` = no salir nunca. |

## Pruebas

```bash
npm test              # unitarias + integración contra Postgres
npm run e2e           # punta a punta: KMS real, cola real, Postgres real
npm run e2e -- --lento  # + reentrega real de SQS (~90 s)
```

`test/productor.ts` **hace de C3 sin tocar C3**: firma con la llave Ed25519
real, cifra con una data key real y publica en la cola real. No es C3 ni
pretende serlo — no hay outbox, ni relay, ni marcas `e0..e6`. Es lo mínimo para
que C4 tenga algo legítimo que abrir, y sobre todo algo **ilegítimo** con lo
que probar `G-07`.

El punta a punta publica 12 documentos legítimos (3 expedientes × 4 eventos,
tamaños sorteados en `[2048, 4096]`) y **6 venenos**, uno por cada guarda:

| Veneno | Motivo esperado |
|---|---|
| el cuerpo no es un sobre | `no_es_sobre` |
| ciphertext alterado | `no_descifra` |
| descifra pero la firma no cubre el documento | `firma_invalida` |
| `key_id` fuera de la lista blanca | `llave_no_aceptada` |
| `payload_hash` declarado que no es el del payload | `dedup_no_coincide` |
| `rpf_id` que no es UUID | `rpf_id_invalido` |

Que el total de descartes cuadre no basta: se comprueba que **cada uno cayó por
su motivo**. Dos venenos rechazados por el motivo equivocado darían el mismo
total y esconderían que una de las dos guardas no funciona.

### El test que más importa

`test/jcs.test.ts` compara `src/comun/jcs.ts` con
`../orquestador/src/generador/jcs.ts` y **falla si divergen**. Son la misma
implementación duplicada, y si una deriva el síntoma no es «hay dos copias»:
es que la firma deja de verificar y C4 manda todo a la DLQ con alarma —
indistinguible de un intento de inyección. Cuando C3 exista de verdad, las tres
copias tienen que colapsar en un paquete compartido.

## Lo que C4 sigue sin hacer

- **No hay `/health`.** `BdService.viva()` existe y nadie lo llama: sin
  servidor HTTP no hay dónde colgarlo. Cuando la task definition tenga
  health check, ahí se conecta.
- **El `shared_map` cuenta expedientes por `sequence <= 1`.** Si un expediente
  empezara en otro número, el conteo de expedientes se desviaría (el de
  eventos no).
- **No hay backpressure.** Si el Postgres se pone lento, C4 sigue pidiendo
  lotes de 10 y acumulando reintentos hasta el redrive. Con 20.000 mensajes en
  vuelo la cola deja de entregar con `OverLimit` y el síntoma **parece** que se
  vació.
