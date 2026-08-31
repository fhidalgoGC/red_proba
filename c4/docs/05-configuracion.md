# 05 · Configuración

Todo por variable de entorno: una sola imagen, igual que C3 (D-07).

El proceso **falla al arrancar** si falta lo esencial. Un consumidor que
arranca «sano» apuntando a ninguna parte es peor que uno que no arranca: el
health check queda en verde y nadie se entera de que P4 no se está midiendo.

## Obligatorias

| Variable | Qué pasa si falta |
|---|---|
| `SQS_QUEUE_URL` | El proceso muere: no tiene de dónde leer |
| `DATABASE_URL` | El proceso muere: sin base no hay `e10`, y `e10` es el final de la medición |

## De seguridad

| Variable | Defecto | |
|---|---|---|
| `C4_LLAVES_FIRMA` | — | **Lista blanca de `key_id` aceptados**, separados por coma. Sin ella la firma prueba integridad pero **no autoría** — ver [02 · Criptografía](02-criptografia.md#-c4_llaves_firma-la-lista-blanca-no-es-configuración-es-seguridad). Arranca igual, pero grita |
| `KMS_ENCRYPT_KEY_ID` | — | La llave simétrica de mensajes. Se le pasa a `Decrypt` para que un blob ajeno falle diciendo que no es de aquí, en vez de un `AccessDenied` ambiguo |

## Operativas

| Variable | Defecto | |
|---|---|---|
| `SQS_DLQ_URL` | — | Sin ella el veneno se cuenta en `descartes` y se borra, pero **no queda evidencia en ninguna cola** |
| `AWS_REGION` | se deduce de la URL | Región de los clientes SQS y KMS |
| `C4_ESQUEMA` | `c4` | Esquema de Postgres |
| `C4_BD_POOL` | `10` | Conexiones del pool |
| `SQS_BATCH_SIZE` | `10` | Mensajes por `ReceiveMessage`. **Tope duro: 10** |
| `SQS_WAIT_SECONDS` | `20` | Long polling. **Tope duro: 20** |
| `C4_GUARDAR_PAYLOAD` | `true` | Guardar el documento en claro en el `journal` |
| `C4_RESUMEN_MS` | `10000` | Cada cuánto sale la línea de resumen |

## Perillas de prueba

| Variable | Defecto | |
|---|---|---|
| `C4_BORRAR` | `true` | `false` = espiar la cola sin consumirla |
| `C4_SALIR_TRAS_VACIOS` | `0` | Salir tras N ciclos vacíos seguidos. `0` = no salir nunca |

> ⚠ **`C4_BORRAR=false` es modo inspección, no de corrida.** Si no se borra, el
> mensaje reaparece al vencer el visibility timeout y se vuelve a procesar en
> bucle hasta agotar `maxReceiveCount` y caer en la DLQ. El inbox lo absorbe
> como duplicado —no se corrompe nada— pero verías miles de recepciones de un
> solo evento y la DLQ se llenaría de mensajes legítimos.

`C4_SALIR_TRAS_VACIOS` existe para drenar una corrida y salir. Sin él habría
que matar el proceso, y matarlo es justo lo que deja mensajes procesados y sin
borrar.

---

## Lo que la cola aporta, y no se configura aquí

Vive en `terraform/modules/messaging`:

| | |
|---|---|
| `visibility_timeout_seconds` | 60 — debe superar lo que tarda C4 en descifrar, verificar y persistir |
| `maxReceiveCount` | 5 — recepciones antes del redrive automático a la DLQ |
| `content_based_deduplication` | **false** — D-11: el ciphertext cambia en cada cifrado, el `payload_hash` lo calcula C3 sobre el claro |
| `deduplication_scope` | `messageGroup` — 300 msg/s **por grupo** en vez de para toda la cola |
| retención de la DLQ | 14 días, el máximo |

Si el visibility timeout se quedara corto respecto de lo que tarda C4, el
mensaje reaparecería **mientras se está procesando** y se dispararía trabajo
duplicado. El inbox lo absorbe, pero cuesta.
