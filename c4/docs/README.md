# C4 — documentación del track `G`

El **operador neutro**. Consume de la cola FIFO, descifra, verifica la firma y
persiste.

Termina cuando el evento queda guardado en el Postgres de C4 — ese COMMIT es
`e10`, **el final de la medición**.

> **[Diagramas](diagramas.html)** — el mecanismo explicado etapa por etapa, con
> siete diagramas. Es un HTML autocontenido: ábrelo desde el disco, sin
> servidor ni conexión. También publicado en
> [claude.ai](https://claude.ai/code/artifact/80828c05-58ef-4586-9ad8-80bb80d0a344).

---

## Los documentos

| | Qué responde |
|---|---|
| [01 · Cómo funciona](01-como-funciona.md) | El camino de un mensaje, paso a paso, y dónde puede salirse |
| [02 · Criptografía](02-criptografia.md) | Qué descifra KMS y qué no, y por qué la firma se verifica en local |
| [03 · La base](03-base.md) | El inbox, los cinco schemas, los descartes y las consultas que responden P4 |
| [04 · Medición](04-medicion.md) | `e7..e10`, la marca `e7b` que hubo que añadir, y los números medidos |
| [05 · Configuración](05-configuracion.md) | Variables de entorno, y cuál de ellas es de seguridad y no de config |
| [06 · Reglas que no se negocian](06-reglas.md) | Las decisiones que si se rompen invalidan la prueba |
| [07 · Pruebas](07-pruebas.md) | Cómo se prueba contra KMS, cola y Postgres reales |
| [Diagramas](diagramas.html) | El mecanismo dibujado — abrir en el navegador |

El **diseño** del track vive aparte, en
[../../docs/05-contenedor-c4.md](../../docs/05-contenedor-c4.md). Esto es la
implementación.

---

## Arranque rápido

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

**No expone endpoints.** La cola es su única entrada; el Postgres y los logs,
su única salida. No es un API: es un worker, y por eso arranca con
`createApplicationContext` y no con un servidor HTTP — igual que dice la task
definition de `terraform/modules/c4`, sin `portMappings` y sin balanceador.

---

## Estado

| Tarea | |
|---|---|
| `G-01` Consumidor FIFO con long polling | ✅ |
| `G-02` Descifrado y verificación, en ese orden | ✅ |
| `G-03` Inbox e idempotencia | ✅ |
| `G-04` Proyección a los cinco schemas | ✅ |
| `G-05` Detección de huecos | ✅ |
| `G-06` Marcas de tiempo `e7..e10` | ✅ (+ `e7b`) |
| `G-07` Manejo de DLQ | ✅ |

---

## En una frase

Toma lotes de diez de una cola FIFO, le pide a KMS **una llave** —no el
documento—, abre el sobre en local, comprueba con una clave pública cacheada
que la firma cubre exactamente lo que va a guardar, y escribe el inbox y los
cinco schemas **en una sola transacción**; lo que no abre o no verifica sale de
la cola en el acto y va a la DLQ con alarma, porque dejarlo congelaría su
expediente entero durante cinco minutos.
