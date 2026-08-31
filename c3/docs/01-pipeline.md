# 01 · El pipeline

Seis pasos, y **el orden no es negociable**. Cada uno depende del anterior de
una forma que, si se altera, no falla ahí: falla en C4, horas después, con un
síntoma que no se parece a la causa.

```
documento del orquestador   ← ya hecho, con party_id de relleno
   │
   ├─ 1  validar        la forma contra el contrato, y el peso contra el rango
   ├─ 2  party_id       ← el HMAC-SHA256 real del participante
   ├─ 3  canonizar      JCS RFC 8785 → los bytes exactos que se firman
   │     payload_hash   ← SHA-256 de esos bytes
   ├─ 4  firmar         Ed25519 (KMS Sign)
   ├─ 5  cifrar         AES-256-GCM sobre { payload, signature }
   └─ 6  [ TRANSACCIÓN: expediente + fila de outbox ] · COMMIT
            ⋮   (el relay, en el mismo proceso, cada OUTBOX_POLL_MS)
         reclamar → SendMessageBatch → SQS FIFO → SENT
```

---

## Por qué ese orden

### `party_id` antes de canonizar

`party_id` es **un campo del payload**, así que entra en lo que se canoniza y
se firma. Sustituirlo después dejaría la firma cubriendo el placeholder de
relleno, y C4 la rechazaría con `firma_invalida` — indistinguible de una
inyección: DLQ con alarma, en otra cuenta de AWS.

El `payload_hash` tiene el mismo problema: sale del canónico en claro, así que
calcularlo antes de la sustitución daría una llave que **no corresponde al
documento que viajó**, y la conciliación outbox↔inbox no cerraría.

### Firmar antes de cifrar

Es la regla 6. La firma cubre el documento, no un cifrado que cualquiera pudo
rehacer. Por eso la firma viaja **dentro** del sobre, cifrada junto al payload,
y no como un campo en claro al lado.

### Commit antes de publicar

Es la regla 3, y por eso el paso 6 y el relay están separados. Publicar dentro
de la transacción daría el caso «se publicó y luego el commit falló»: un evento
en la cola que no existe en tu base, imposible de reconciliar y de detectar.

---

## Validar cuesta microsegundos y ahorra un incendio

C3 firma cualquier cosa que le den. Un documento al que le falta `totals` se
canoniza igual, se firma igual y viaja igual — y muere del otro lado, en C4,
con un INSERT que revienta o una firma que no verifica.

A 2.000 ev/s ese síntoma llega a la DLQ **en otra cuenta**, sin el `event_id` a
mano y sin manera de saber qué tenant lo produjo. Validar aquí convierte ese
incidente en un descarte con nombre, motivo y campo.

Ver [02 · El contrato](02-contrato.md).

---

## Un documento malo no tumba a los buenos

`POST /events` devuelve `aceptados` y `descartados` por separado:

```jsonc
{ "recibidos": 3, "aceptados": 1,
  "descartados": [
    { "event_id": "018f…", "indice": 1, "motivo": "importe_no_es_string", "campo": "totals.icms" },
    { "event_id": "018f…", "indice": 2, "motivo": "campo_faltante",      "campo": "document.access_key" }
  ] }
```

Con `eventos_por_request = 1` da igual. Con lotes de 20, un documento
defectuoso se llevaría los otros 19 por delante y el ritmo medido caería por
una causa que no es de arquitectura.

**Y el conteo vuelve al orquestador.** Si C3 se comiera los descartes en su
log, la conciliación de P4 daría un falso negativo sin un solo error a la vista.

---

## Lo que todavía no está

`C-01` pide **encolar el trabajo y contestar 202 de inmediato**. Hoy C3 procesa
dentro del handler. Con lotes grandes y firmas de KMS de por medio, unos pocos
miles de eventos pasan del minuto: si no encolas, el techo que mides es el del
cliente HTTP, no el de tu arquitectura.

A 25-50 ev/s con lotes de 1 no molesta. A 2.000 con lotes de 20, sí.
