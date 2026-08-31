# 01 — Arquitectura y decisiones

## Topología

```
┌─ VPC C3 · cuenta c3-dev · PARTICIPANTE ──────────────────┐
│                                                           │
│  sg-orq  [ Load Driver ]  ← andamio, no es un dominio     │
│              │ HTTP :8080 · api-NN.poc.local              │
│              ▼                                            │
│  sg-tenant-01 [ API NestJS ] ←→ [ RDS Postgres ]          │
│  sg-tenant-02 [ API NestJS ] ←→ [ RDS Postgres ]          │
│  …47 más                                                  │
│  sg-tenant-50 [ API NestJS ] ←→ [ RDS Postgres ]          │
│                                                           │
│  VPC Endpoints: ECR · KMS · Secrets · Logs · SQS          │
│  sin NAT · sin salida a internet                          │
└──────────────────────┬────────────────────────────────────┘
                       │ evento firmado y cifrado
                       ▼
                 ┌───────────┐
                 │ SQS FIFO  │   ← única ruta
                 └─────┬─────┘
                       ▼
┌─ VPC C4 · cuenta c4-dev · OPERADOR NEUTRO ───────────┐
│  sg-c4                                                │
│    Consumidor · descifra · verifica · persiste        │
│  RDS Postgres — el inbox                              │
└───────────────────────────────────────────────────────┘

  ✗ NO hay peering, ni Transit Gateway, ni PrivateLink en toda la PoC
  ✗ El orquestador NO se conecta a C4 — ni por red ni por IAM
```

**Dos VPC, no tres.** El orquestador corre dentro de la de C3, en su propio
security group. Es andamio de prueba, no un dominio de confianza: darle VPC
propia obligaba a un peering, y un peering es exactamente el tipo de ruta que
alguien podría replicar después hacia C4. Sin VPC de ORQ no hay ni una sola
conexión entre VPC en toda la infraestructura.

## Decisiones

### D-01 · Una VPC por dominio de confianza, no por tenant

Dos VPC porque hay dos dueños con intereses distintos: C3 y C4. 50 VPC no
darían más seguridad y multiplicarían endpoints, rutas y CIDR por 50.

El orquestador **no suma una tercera**: no es un dueño, es el arnés de carga.
Vive en la VPC de C3 separado por security group, igual que un tenant se separa
de otro.

El SaaS multi-tenant real no hace VPC por cliente: no escala más allá de unas
decenas. Cuando se necesita aislamiento más fuerte se salta a **cuenta por
cliente**, que sí es frontera de seguridad. La VPC por tenant es el peor punto
medio.

### D-02 · Aislamiento entre tenants por security group auto-referenciado

La app y su Postgres comparten `sg-tenant-NN`. La regla de entrada es 5432 con
origen el propio grupo.

```hcl
resource "aws_security_group" "tenant" {
  for_each = toset(var.tenants)
  vpc_id   = aws_vpc.c3.id
  name     = "sg-tenant-${each.key}"
}

resource "aws_vpc_security_group_ingress_rule" "tenant_db" {
  for_each                     = toset(var.tenants)
  security_group_id            = aws_security_group.tenant[each.key].id
  referenced_security_group_id = aws_security_group.tenant[each.key].id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}
```

El descarte ocurre en la interfaz de red, antes de que el paquete toque el
proceso de Postgres. Mismo enforcement que separar VPC, con 50 recursos en vez
de 50 redes.

**Trade-off** — dentro del grupo la app y la base se ven en ambos sentidos, y
no puedes aplicar reglas distintas a capa de aplicación y de datos. Si esto va
a producción, separar `sg-app-NN` y `sg-db-NN`.

**Falla en silencio.** Un error de índice en el `for_each` no rompe nada
visible: simplemente el tenant 08 puede leer la base del 07. La única forma de
detectarlo es la verificación explícita:

```bash
# desde la tarea del tenant 08, contra el endpoint RDS del 07
psql -h rpf-db-07.xxxx.rds.amazonaws.com -U app -c 'select 1'
# DEBE dar timeout. Si da "password authentication failed",
# la conexión TCP se estableció y el aislamiento NO existe.
```

### D-03 · SQS como único canal entre C3 y C4

Sin peering, sin Transit Gateway, sin PrivateLink entre ellas. Cada una alcanza
SQS por su propio VPC endpoint.

Con peering, el invariante "única ruta permitida" sería una regla que alguien
puede modificar. Sin peering es una propiedad de la topología: no hay camino
que aflojar. Eso es lo que se puede afirmar ante una auditoría.

### D-04 · Las llaves de firma viven en C3 y C4 no puede usarlas

La llave Ed25519 y la HMAC de pseudonimización están en el KMS de C3, con
política que niega el uso desde C4.

Es lo que hace verificable la firma. Si el operador neutro pudiera firmar, la
firma no probaría que el evento vino del participante y el Proof Ledger pierde
su valor probatorio.

### D-05 · Outbox transaccional, no publicación directa

El cambio de estado y la fila del outbox se escriben en la misma transacción.
Un relay separado publica a SQS después.

Publicar dentro del handler parece más simple, pero si el commit falla después
del publish tienes un evento firmado que afirma algo que nunca ocurrió.

### D-06 · `MessageGroupId` = `rpf_id`

El identificador del expediente, no el del tenant ni una constante.

FIFO garantiza orden dentro de un grupo y paraleliza entre grupos. El orden que
importa es el de los eventos de un mismo expediente. Con un group id constante
el techo es 300 mensajes/s **para los 50 tenants juntos**.

### D-07 · Una sola imagen, configuración por variables de entorno

50 task definitions que difieren solo en variables. 50 imágenes serían 50 cosas
que pueden divergir.

### D-08 · Serialización canónica antes de firmar

JCS, RFC 8785. La misma entrada produce siempre los mismos bytes.

Sin canonicalización, dos serializaciones equivalentes del mismo objeto
producen firmas distintas y la verificación falla sin razón aparente. **Es el
componente que hay que probar con vectores fijos antes que ningún otro.**

### D-09 · El API recibe un entero, no payloads

La petición lleva un solo número `n`. El generador, dentro del contenedor,
produce esa cantidad de eventos sintéticos.

Convierte la carga en un único parámetro y elimina la red como variable: lo que
mides es la cadena de firma y publicación, no el ancho de banda de subida.

**Trade-off** — el payload deja de ser realista. Si hay que validar el Canonical
Mapper contra datos reales, el generador tiene que producir la misma forma y
variedad que la fuente de verdad.

### D-10 · Firmar primero, cifrar después

Se firma el texto canónico y luego se cifra el conjunto payload + firma con
AES-256-GCM, usando una data key envuelta con una llave simétrica de C4.

La firma cubre el documento tal como lo emitió el participante, no un cifrado
que cualquiera pudo rehacer.

**Trade-off** — C4 tiene que descifrar antes de poder verificar, así que no puede
rechazar impostores sin gastar un `Decrypt`.

### D-11 · La deduplicación se calcula sobre el texto en claro

`MessageDeduplicationId` = hash del payload canónico, calculado **antes** de
cifrar y pasado explícitamente. La deduplicación por contenido de SQS queda
desactivada.

AES-GCM usa un IV distinto en cada operación: el mismo evento cifrado dos veces
produce ciphertext distinto. Si SQS hasheara el mensaje nunca detectaría un
duplicado — y como el relay reintenta, los duplicados son normales.

**Consecuencia** — el `rpf_id` viaja en claro como atributo del mensaje, porque
FIFO lo necesita para agrupar. No es contenido fiscal, pero revela qué
expedientes están activos: por eso el identificador de tenant que va en el
payload está pseudonimizado con HMAC.

**Bonus** — el `payload_hash` explícito es además la llave que une el outbox de C3
con el inbox de C4 para medir extremo a extremo. Ver [07-medicion](07-medicion.md).

### ORQ-06 · El orquestador vive dentro de la VPC de C3

Se descartaron las dos alternativas que suponen VPC propia. PrivateLink
obligaría a montar un NLB delante de los 50 API. El peering no cuesta por hora,
pero deja una conexión entre VPC en el inventario — y el argumento de D-03 es
justamente que **no hay ninguna**. Un revisor que encuentra un peering ORQ↔C3
tiene que aceptar el razonamiento de "no es transitivo" en vez de mirar el
diagrama y ver que no hay nada que aflojar.

Con el driver en la VPC de C3 no hace falta nada: resuelve `api-NN.poc.local`
por la zona de Cloud Map, que ya está ahí, y llega al API por IP privada.

**Lo que separa a ORQ de los tenants** es lo mismo que separa a un tenant de
otro: el security group. `sg-orq` no aparece en el ingress de 5432 de ningún
tenant, así que no alcanza ninguna base. Su egress es 8080 hacia el CIDR de C3
y 443 hacia los endpoints.

**Sigue sin poder recibir** — `sg-orq` no tiene reglas de entrada. Los security
groups son stateful: las respuestas de C3 fluyen igual y C3 no puede iniciar
nada hacia él. Es la unidireccionalidad que daba PrivateLink, sin NLB.

**No toca D-03** — el orquestador está del lado de C3, y del lado de C3 a C4 no
hay ruta. Además su task role no tiene `sqs` ni `kms`, y la resource policy de
la cola solo nombra a los roles de C3 y C4: aunque alcance el endpoint de SQS de
C3 por red, no puede escribir ni leer nada.

**Requisito** — los CIDR de C3 y C4 no se tocan, pero ya no por el peering: es
higiene, no un requisito técnico.
