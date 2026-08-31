# 03 — Seguridad

## Las cuatro llaves

Ninguna hace el trabajo de otra. **La asimetría es el invariante.**

| Llave | Spec | Vive en | C3 puede | C4 puede | ORQ |
|---|---|---|---|---|---|
| Firma | `ECC_NIST_EDWARDS25519` | C3 | `Sign` · `GetPublicKey` | **solo** `GetPublicKey` | nada |
| HMAC de pseudonimización | `HMAC_256` | C3 | `GenerateMac` · `VerifyMac` | nada | nada |
| Cifrado de mensajes | simétrica | C4 | `GenerateDataKey` | `Decrypt` | nada |
| Cifrado de la cola en reposo | simétrica | C4 | `GenerateDataKey` | `Decrypt` | nada |

Leído en una línea: **C4 descifra pero no firma. C3 firma y cifra pero no
descifra.** Ese es el Proof Ledger, y vive en las key policies, no en el código.

## El `Deny` explícito es lo que lo hace inviolable

```hcl
statement {
  sid       = "C4NuncaFirma"
  effect    = "Deny"
  actions   = ["kms:Sign"]
  principals { identifiers = [aws_iam_role.c4_task.arn, aws_iam_role.orq_task.arn] }
}
```

Un `Deny` explícito en la key policy **gana sobre cualquier `Allow` de IAM**,
incluso el de un administrador. No es una convención de código: el rol de C4 no
puede firmar aunque alguien le adjunte una política permisiva mañana.

Hay tres `Deny` así, uno por invariante:

| Sid | Qué imposibilita |
|---|---|
| `C4NuncaFirma` | que el operador neutro produzca una firma — perdería el valor probatorio |
| `C4NuncaPseudonimiza` | que C4 recalcule `party_id` y pueda revertir la pseudonimización |
| `C3NuncaDescifra` | que el participante lea lo que ya mandó — el canal dejaría de ser unidireccional |

## La desviación que hay que decir en la demo

> ⚠ **El diseño pide dos cuentas AWS** (`c3-dev`, `c4-dev`) en OUs separadas. Esta
> PoC corre en **una sola**, porque es la única disponible.

Lo que se mantiene: el `Deny` explícito sigue siendo real y verificable.

Lo que se pierde: **un admin de la cuenta puede editar la key policy**. Con dos
cuentas no podría. Decirlo de entrada evita que alguien lo descubra en la demo.

La verificación va en los outputs, para que se pueda correr delante de quien
pregunte:

```bash
# asumiendo el rol de C4 — DEBE dar AccessDenied
aws kms sign --key-id <firma> --message $(echo -n test | base64) \
  --signing-algorithm ED25519_SHA_512 --message-type RAW

# asumiendo el rol de C4 — DEBE funcionar
aws kms get-public-key --key-id <firma>
```

## El techo de 4.096 bytes

`ED25519_SHA_512` con `MessageType: RAW` acepta mensajes de 0 a **4.096 bytes**, y
el techo del payload canónico es exactamente 4.096 (`pool.tamano_bytes` va a
`[2048, 4096]`).

**Margen cero.** Subir el tope un solo byte hace fallar `kms:Sign` en C3, con un
error de KMS que no apunta al generador. Para ir más arriba hay que pasar a
`ED25519_PH_SHA_512` con digest, y los dos `MessageType` **no son
intercambiables**: C3 y C4 tendrían que cambiar a la vez.

## Los roles: dos por tarea, y la diferencia importa

| Rol | Lo usa | Para qué |
|---|---|---|
| **execution role** (compartido) | ECS, no tu código | pull de ECR, leer el secreto, escribir logs |
| **task role** (uno por dominio) | tu proceso | KMS, SQS |

| Task role | KMS | SQS |
|---|---|---|
| `c3-task` | `Sign`, `GenerateMac`, `GenerateDataKey` | `SendMessage`, `SendMessageBatch` |
| `c4-task` | `Decrypt`, `GetPublicKey` | `Receive`, `Delete`, `ChangeMessageVisibility`, `SendMessage` a la DLQ |
| `orq-task` | **ninguno** | **ninguno** |

El orquestador no recibe política de KMS ni de SQS. Su execution role alcanza
para hacer pull de ECR y escribir logs, y nada más — que es exactamente lo que
debe poder hacer un arnés de prueba.

### Lo único que los tres comparten: `ecs-exec`

Los tres task roles llevan `ssmmessages:*Channel`
(`modules/security/exec.tf`). **Es la única puerta de entrada a la PoC**: sin
IGW, NAT ni balanceador, el `POST /batch` del orquestador no es alcanzable desde
fuera y no habría forma de lanzar una corrida. Cómo se usa está en
[06 · Operación](06-operacion.md#cómo-se-lanza-una-corrida-ecs-exec).

No abre ninguna ruta: es una sesión **saliente** hacia el endpoint
`ssmmessages` de la propia VPC. No hay puerto que escuche y no hay regla de
entrada en ningún security group — lo que autoriza es IAM, no la red.

Y **no toca el invariante**: da una shell con el mismo task role que ya tenía el
proceso. El de C4 sigue sin `kms:Sign`, y el `Deny` explícito de la key policy
seguiría ganando aunque alguien aflojara la política de identidad.

## La resource policy de la cola: «se olvida siempre»

En el diseño de dos cuentas es cross-account y es obligatoria. Aquí es la misma
cuenta, así que técnicamente la política de identidad de C3 bastaría — se deja
explícita para que el día que se separen las cuentas no haya que descubrirla.

Cuando falta, el error es `AccessDenied` y **no distingue** si falta la policy de
la cola o el permiso de KMS.

> ⚠ La resource policy de SQS solo admite una lista corta de acciones, y las
> variantes `*Batch` **no están** en ella: `SetQueueAttributes` rechaza
> `sqs:SendMessageBatch` con `InvalidParameterValue`. `SendMessage` ya la cubre.
> No confundir con las políticas de **identidad**, que sí aceptan las `*Batch`. Son
> dos lenguajes distintos para el mismo servicio.

## Las contraseñas de Postgres: una sola, a propósito

Un único secreto compartido por las 51 instancias. El diseño lo permite («uno por
tenant, o uno solo si la PoC no ejercita eso») y a 50 tenants ahorra ~$19,60/mes.

Pero la razón buena es otra: **hace más visible la prueba de aislamiento de D-02**.
Con contraseñas distintas, un SG mal asignado daría «password authentication
failed» y podría confundirse con un problema de credenciales. Con la misma clave,
si el aislamiento está roto el `select 1` simplemente **funciona** — y eso no se
puede malinterpretar.

> ⚠ `recovery_window_in_days = 0` en el secreto. Por defecto son 7–30 días de
> espera, y en ese plazo **no se puede recrear un secreto con el mismo nombre**: el
> siguiente `apply` falla con «already scheduled for deletion». Es una de las cosas
> que rompen el destroy (T-08).
