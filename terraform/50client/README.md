# 50client — la corrida de 50 tenants

> **Esto es un runbook, no un root module.** No hay `.tf` en esta carpeta y no
> los va a haber: la corrida de 50 se hace **sobre `../oneClient`**, subiendo
> `var.tenants`. Ver [«Por qué no hay código aquí»](#por-qué-no-hay-código-aquí).

```bash
sh terraform:deploy --clients 50 --az 1     # ← lee antes los bloqueantes
```

## Para qué

Responder P1–P4 con números (ver [../../docs/07-medicion.md](../../docs/07-medicion.md)).
`oneClient` responde «¿funciona el camino?». Esto responde «¿a qué ritmo, hasta
dónde, y llegó todo?».

---

## Bloqueantes · medidos, no supuestos

`sh terraform:deploy --clients 50` los comprueba **contra la cuenta** antes de
escribir nada y se planta si no caben. Esto es lo que había el 2026-08-31 en
`276076558677` / `us-west-2`:

| | Hace falta | Hay | |
|---|---|---|---|
| **RDS · instancias por región** | 51 (50 + la de C4) | **40** | ✘ faltan 11 |
| **KMS · ops criptográficas ECC** | hasta 2.000/s | **1.000/s** | ✘ mide throttling |
| Fargate · vCPU On-Demand | ~54 | 4.000 | ✔ |
| VPC por región | 2 | 5 | ✔ |

**Las dos que faltan tardan días y no son un reintento.** Pedirlas:

```bash
aws service-quotas request-service-quota-increase \
  --service-code rds --quota-code L-7B6409FD --desired-value 61 --region us-west-2

aws service-quotas request-service-quota-increase \
  --service-code kms --quota-code L-DC14942D --desired-value 3000 --region us-west-2
```

### Qué pasa si se aplica sin ellas

No son la misma clase de fallo, y por eso se tratan distinto:

- **RDS rompe el `apply`, y lo rompe A MITAD.** No falla al empezar: crea las 38
  que caben, se queda sin cupo y revienta con `InstanceQuotaExceeded` dejando el
  estado a medias, con 38 bases facturando y sin despliegue utilizable.
  Deshacerlo es otro `apply` de media hora. Por eso `terraform:deploy` **bloquea**.
- **KMS no rompe nada: falsea la medición.** La firma responde
  `ThrottlingException`, la latencia crece, el outbox se llena — y ningún log
  dice «cuota». Se mide la cuota en vez de la arquitectura. Por eso **avisa**.

**Mientras tanto caben 39 tenants** (39 + 1 de C4 = 40). No responde P1–P4 a
escala, pero sí ejercita el aislamiento y el reparto:

```bash
sh terraform:deploy --clients 39 --az 1
```

---

## Qué se reinicia al subir de 1 a 50

Medido con `tofu plan` sobre el estado real. Importa porque **una corrida en
vuelo muere con la task, y su log también** — vive en el disco efímero (T-07).

| | `--az 1` | `--az 2` |
|---|---|---|
| Recursos que se crean | 638 | 642 |
| Recursos que se modifican | **1** | **17** |
| Qué se reinicia | solo el orquestador | orquestador **+ los tenants que ya existían + C4** |
| Endpoints por VPC | 7 ENIs | 14 ENIs (+$3,36/día) |

**El orquestador se reinicia siempre y no hay forma de evitarlo**: la lista de
destinos vive en su task definition (`ORQ_TENANTS_JSON`), y que conozca los 50
endpoints es justo lo que se está pidiendo. Cambiarla es una revisión nueva y
ECS reemplaza la task.

**Los tenants existentes solo se reinician si cambia `az_count`**, porque cambia
la lista de subnets de su service. Con `--az 1` no se tocan.

> **El dato no se pierde en ninguno de los dos casos.** El outbox está en RDS y
> la RDS no se reemplaza. Lo que se pierde es la corrida en vuelo.

### Entonces, ¿1 AZ o 2?

`--az 2` es lo que pide el doc y lo que hay que usar para la corrida que se
reporta: con una sola AZ no hay reparto que enseñar. `--az 1` es para **añadir
los tenants sin tocar lo que ya está corriendo**, y luego subir a 2 en una
ventana en la que no importe reiniciar.

---

## Perillas que hay que mover · no las mueve el número de clientes

`--clients 50` cambia `tenants` y `az_count`. **Todo lo demás se queda como
estaba**, y tres cosas dejan de servir a esta escala. Van en
`oneClient/terraform.tfvars`:

```hcl
orq_manifiesto_tope = 3600000    # ← la que deja P4 sin respuesta
rds_class_c4        = "db.m6g.large"
c4_replicas         = 8
c4_concurrencia     = 8
```

**`orq_manifiesto_tope` es la que muerde primero y la que no avisa.** El tope se
gasta en eventos, no en tiempo, así que la duración útil de una corrida se
divide entre el número de tenants:

| | ritmo | tope 200.000 dura |
|---|---|---|
| 1 tenant | 40 ev/s | 83 min — por eso nunca se vio |
| 50 tenants | 2.000 ev/s | **1,6 min** |

Pasado el tope el manifiesto sale `truncado: true` y la conciliación **se niega
a dar `ok`** — la corrida entera queda con asterisco aunque todos los eventos
hayan llegado bien. 3.600.000 cubren 30 min a 2.000 ev/s y son ~790 MB de heap,
dentro de los 6.144 que declara la task. La alternativa sin memoria es
`eventos_por_hilo: 10` en el cuerpo del batch.

**`rds_class_c4`**: `db.t4g.medium` es de ráfaga. Una corrida sostenida agota
los créditos de CPU y se estrangula al baseline. El síntoma es que `e9→e10`
crece **sin que crezca ningún otro tramo** y ningún error lo explica — igual que
el throttling de KMS. Si aparece, sospechar de esto antes que del código.

**`c4_replicas` y `c4_concurrencia`**: un consumidor procesa ~80 msg/s. Ocho
réplicas son ~640, no 2.000; para llegar hacen falta los cambios de código
(lote en paralelo, varios lazos de recepción, INSERT multifila). Y las ocho
pegan a la misma RDS — de ahí la clase de arriba.

---

## Verificación de aislamiento — obligatoria (D-02)

Un error de índice en el `for_each` **no rompe nada visible**: simplemente el
tenant 08 puede leer la base del 07. Solo lo detecta la prueba explícita, y con
1 tenant no hay contra quién correrla — esta es la primera vez que se puede.

```bash
# el endpoint de la base del 07, visto desde fuera
sh sql db 07 --resumen

# ahora desde la TASK del tenant 08, contra el endpoint del 07
TAREA=$(aws ecs list-tasks --cluster rpf-one-c3 --service-name rpf-one-api-08 \
  --query 'taskArns[0]' --output text --region us-west-2)

aws ecs execute-command --cluster rpf-one-c3 --task "$TAREA" \
  --container api --interactive --region us-west-2 \
  --command "node -e \"require('net').connect(5432,'rpf-one-db-07.<sufijo>.us-west-2.rds.amazonaws.com')
    .on('connect',()=>{console.log('AISLAMIENTO ROTO');process.exit(1)})
    .on('error',e=>console.log('ok:',e.code))\""
```

**Debe dar timeout** (`ETIMEDOUT`). Si diera `connect` —o «password
authentication failed»— la conexión TCP se estableció y **el aislamiento no
existe**: el descarte tiene que ocurrir en la interfaz de red, antes de que el
paquete toque Postgres.

> Que la contraseña sea **la misma para las 51 bases** es a propósito y es lo
> que hace la prueba concluyente: con claves distintas, un SG mal asignado daría
> «password authentication failed» y se confundiría con un problema de
> credenciales. Con la misma clave, si el aislamiento está roto el `select 1`
> simplemente **funciona**, y eso no se puede malinterpretar.

---

## Operar 50 · lo que cambia respecto a 1

Los bastiones **no cambian**: son dos, uno por VPC, y cuestan lo mismo con 1
tenant que con 200 (~$0,48/día). El de C3 alcanza el orquestador, los 50 API y
las 50 bases; el de C4, su health y su base. Son dos porque **la RDS de C4 está
en la VPC de C4 y no hay ruta desde C3** — eso es el invariante, no un
obstáculo.

```bash
sh tunel --lista              # los puertos se DERIVAN: api NN → 18000+NN, db NN → 15400+NN
sh tunel orq --fondo          # lanzar la corrida
sh sql db --todos --resumen   # ← LAS 50 BASES, una fila cada una, con TOTAL
sh sql c4 --resumen           # la otra mitad de P4
```

`sh sql db --todos` es el que aparece con 50: la mitad «salió» de P4 no vive en
una base, vive repartida en las 50. Sumarlas a mano son 50 comandos y una hoja
de cálculo, y ahí es donde se cuela el error que invalida la conciliación. Va de
una en una a propósito — cada base necesita su túnel, y 50 sesiones de Session
Manager simultáneas contra un `t4g.nano` es pedirle al bastión lo que no es.

---

## Antes del `destroy`

Los log groups **se van y no se recuperan**. Exportar a S3 primero:

- las 51 tablas de medición (`c3.outbox` de los 50 + `c4.inbox`)
- los log groups de los 53 services

Sin eso la corrida no deja evidencia.

---

## Por qué no hay código aquí

El [README del track](../README.md) lo dice: lo único que distingue un escenario
de otro es `var.tenants`. Duplicar `main.tf` para cambiar un número es
exactamente lo que ese documento prohíbe — **lo que validaste con 1 tenant
dejaría de ser lo que corres con 50**, y la prueba de humo dejaría de probar
nada.

`terraform:deploy` escribe la lista en `oneClient/clientes.auto.tfvars` y aplica
sobre el mismo estado. Consecuencia buscada: los tenants que ya existen se
conservan tal cual —subir de 1 a 50 **añade 49**, no recrea 50— y siguen
compartiendo una sola cola, un solo C4 y un solo juego de llaves KMS, que es lo
que hace comparable la medición.

El precio: **un solo estado**. Dos personas aplicando a la vez lo corrompen. Si
esto deja de ser una persona, hay que descomentar el backend S3 de
[`oneClient/versions.tf`](../oneClient/versions.tf) antes de la corrida.
