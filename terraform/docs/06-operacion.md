# 06 — Operación

## El frente único

Desde la raíz del repo:

```bash
sh terraform:deploy --clients 1     # despliega · 1 tenant (máximo 200)
sh terraform:deploy --clients 50    # sube a 50
sh terraform:deploy --down          # apaga: cómputo y endpoints a cero
sh terraform:deploy --estado        # qué hay desplegado
sh terraform:deploy --clients 8 --plan   # enseña el plan y no aplica
```

No reimplementa nada: escribe `clientes.auto.tfvars` con la lista de tenants
—mismo patrón que `estado.auto.tfvars`, y por la misma razón— y delega en los
scripts de abajo.

**Antes de aplicar avisa de lo que no se arregla reintentando:**

- bajar el número de clientes **destruye** los tenants sobrantes con su RDS;
- por encima de 39 clientes se topa con la cuota de instancias RDS;
- a partir de 50, con las de KMS y Fargate;
- y **no enciende si las imágenes no están en ECR** — encender sin ellas no da un
  error de despliegue, da servicios reintentando para siempre.

## Los scripts

| Script | Qué hace | Cuándo |
|---|---|---|
| `crear.sh <esc>` | levanta desde cero; `--encender` arranca servicios | la primera vez |
| `actualizar.sh <esc>` | aplica cambios, muestra el plan y **avisa si destruye** | cuando cambia el código |
| `apagar.sh <esc>` | cómputo y endpoints a cero | entre corridas |
| `encender.sh <esc>` | vuelve a levantar; necesita imágenes en ECR | antes de una corrida |
| `destruir.sh <esc>` | no deja nada: exporta, purga, destruye, verifica | al terminar |
| `verificar-limpio.sh` | lista lo que quedó vivo con nuestro tag | tras destruir, y al día siguiente |
| `costos.sh` | reporte por día, delta contra el baseline | al día siguiente |

Todos piden confirmación escribiendo `si`. Se salta con `--si` o `AUTO=1`.

**Ninguno crea recursos por su cuenta**: todo pasa por `tofu`. Lo único imperativo
es la higiene previa al destroy —exportar logs, purgar la cola—, que no crea nada.

## El orden de `destruir.sh` no es negociable

```
1. apagar     → drena tareas y libera ENIs
2. exportar   → los log groups SE VAN Y NO SE RECUPERAN
3. purgar     → la cola no se borra con mensajes en vuelo
4. destroy
5. verificar  → lo único que prueba que quedó limpio
```

Cada paso existe porque el destroy falla sin él:

| Paso | Qué rompe si falta |
|---|---|
| **apagar** | el destroy pelea con recursos en uso; las ENIs de los endpoints tardan en liberarse y la subnet no se borra |
| **exportar** | los log groups desaparecen y **no hay forma de recuperarlos** — es la única oportunidad |
| **purgar** | la cola no se borra con mensajes en vuelo |
| **verificar** | «destruido» sin verificar es una suposición, y esta PoC factura por hora |

> ⚠ **Las llaves de KMS no se destruyen.** Entran en periodo de espera de 7 días.
> No facturan uso, pero siguen contando para la cuota de llaves.

## Qué más rompe el destroy (T-08)

- **VPC endpoints** — sus ENIs tardan en liberarse; el destroy de la subnet falla
  mientras tanto.
- **Secretos** — con `recovery_window_in_days > 0` no se puede recrear un secreto
  con el mismo nombre durante la espera. Por eso está en `0`.
- **Backend de state (T-01)** — primero en crearse, último en destruirse. Se
  destruye a mano, fuera de estos scripts.

## Verificar que quedó limpio

`verificar-limpio.sh` lista, filtrando por nuestro tag: services con
`desiredCount ≠ 0`, tareas en `RUNNING`, VPC endpoints vivos y ENIs sin liberar.

Filtra por tag **a propósito**: sin eso reportaría el `cluster-test` y las dos VPC
preexistentes de otro equipo como basura nuestra.

Y al día siguiente:

```bash
scripts/costos.sh dias 3
# un día que vuelve al baseline (~$0,0811) confirma que quedó limpio
```

Ese es el único cierre real del track `T`. Un `destroy` que devuelve «Destroy
complete!» dice que Terraform terminó, no que la cuenta esté en cero.

## Antes de encender: las imágenes

Encender sin imágenes en ECR **no da un error de despliegue**: da servicios
reintentando para siempre. Desde la raíz:

```bash
sh imagenes              # construye las tres y las empuja
sh imagenes c3           # solo una
sh imagenes --estado     # qué hay en ECR ahora mismo
sh imagenes --solo-build # construye y no empuja
```

Lee `name_prefix` e `imagen_tag` del `terraform.tfvars` del escenario, así que
no hay una segunda copia del prefijo que se pueda desincronizar. Si el repo no
existe todavía se detiene diciéndolo: los repos los crea Terraform
(`modules/registry`), no el push.

**ARM64.** Las tres task definitions declaran
`runtime_platform { cpu_architecture = "ARM64" }` y el script construye
`linux/arm64`. Es nativo en las máquinas donde se construye y Fargate lo cobra
~20% más barato; nada de la PoC tiene módulos nativos, así que no hay nada que
compilar por arquitectura. **Si cambia uno de los dos lados hay que cambiar el
otro**: una imagen x86 sobre una task ARM64 arranca y muere con
«exec format error», y en la consola eso se lee como una tarea que reinicia en
bucle, no como un error de build.

**Sin atestaciones.** El script pasa `--provenance=false --sbom=false`. Sin eso
buildx publica un OCI index con un manifiesto de atestación de plataforma
`unknown/unknown` colgando; ECS lo resuelve, pero el día que algo de la cadena
no lo haga el síntoma vuelve a ser `CannotPullContainerError` y nadie va a
sospechar de una atestación.

**Una imagen nueva no reinicia nada.** El service apunta a una revisión de task
definition, y esa revisión apunta a un tag. Empujar el mismo tag no cambia la
revisión: hay que forzar el reemplazo de la tarea (`--down` y `--encender`, o un
`update-service --force-new-deployment`).

Los repos y el comando de login crudo quedan igualmente en
[`docs/<escenario>-referencia.md`](08-referencia-generada.md) después de cada
`apply`.

## Cómo se lanza una corrida: ECS Exec

No hay IGW, ni NAT, ni balanceador, ni bastión. Eso es deliberado (D-03) y tiene
una consecuencia que hay que resolver: **el `POST /batch` del orquestador no es
alcanzable desde fuera de la VPC**, y sin él no hay corrida.

La puerta es ECS Exec, y no abre ninguna ruta: es una sesión **saliente** del
agente de ECS hacia el endpoint `ssmmessages` de la propia VPC. No hay puerto
que escuche, no hay regla de entrada en ningún security group, y lo que la
autoriza es IAM. Las piezas son tres —`enable_execute_command` en los tres
services, el endpoint `ssmmessages` en las dos VPC, y la política `ecs-exec` de
`modules/security/exec.tf`— y en el cliente hace falta el
`session-manager-plugin`:

```bash
brew install --cask session-manager-plugin

TAREA=$(aws ecs list-tasks --cluster rpf-one-orq --query 'taskArns[0]' --output text)

# lanzar la corrida
aws ecs execute-command --cluster rpf-one-orq --task "$TAREA" \
  --container driver --interactive --command \
  "wget -qO- --post-data='{\"id\":\"aws01\",\"seconds\":20,\"rate\":5}' \
   --header=Content-Type:application/json http://127.0.0.1:9090/batch"
```

Con el mismo mecanismo se vuelca el inbox de C4 (`npm run informe`, G-08) sin
abrirle a C4 una sola ruta de red.

**No toca el invariante.** Exec da una shell dentro del contenedor con el mismo
task role que ya tenía el proceso: el de C4 sigue sin `kms:Sign` y la key policy
de la llave Ed25519 se lo sigue negando. Una shell en C4 no puede firmar nada.

> ⚠ Es la puerta de servicio de la PoC. Si esto fuera producto iría detrás de
> una condición de sesión y un registro de auditoría, no suelto en el rol.

## Dos pares de colas: despliegue y local

| Output | Cola | La usa |
|---|---|---|
| `cola_url` / `dlq_url` | `rpf-one-eventos.fifo` | las tasks de Fargate |
| `cola_local_url` / `dlq_local_url` | `rpf-one-local-eventos.fifo` | `c3/.env` y `c4/.env` |

**Por qué están separadas.** El pipeline local firma con KMS real y publica a
SQS real — es lo que hace que probar en local signifique algo. Pero con **una
sola cola**, el C4 del portátil y el C4 de Fargate son dos **consumidores
competidores** de la misma FIFO: SQS reparte los mensajes entre los dos.

Y no falla. Cada mitad se descifra, se verifica y se persiste sin un solo error
en ningún log. Simplemente el inbox de AWS acusa la mitad de los eventos, **P4
da un falso negativo**, y el hueco parece un problema de red o de la cola.

Medido en la prueba de humo del 31/08: 105 eventos publicados por C3 en Fargate,
**56** en el inbox de C4 en AWS y **49** en el `rpf_c4` del portátil. Las
métricas de la cola decían `Sent=105`, `Received=105`, `Deleted=105` — porque
los 105 sí se entregaron, solo que a dos sitios. Con la cola local aparte: 306
publicados, 306 en el inbox, 0 duplicados, 0 huecos.

La cola local es **idéntica en configuración** a la del despliegue: mismo dedup
por grupo, mismo cifrado con la misma llave, misma DLQ, mismo visibility
timeout. Tiene que serlo, o lo que pruebas en local no es lo que corre en AWS.

Lo que **no** tiene son los permisos de los task roles, y eso no es una
omisión — es obligatorio:

> ⚠ Las políticas de identidad del módulo son **inline y con nombre fijo**
> (`c3-sqs`, `c4-sqs`) sobre roles que son los mismos para las dos instancias.
> `PutRolePolicy` con un nombre que ya existe **sobrescribe**: la instancia
> local le quitaría a la C3 desplegada el permiso sobre su cola y se lo daría
> sobre la local. Terraform no lo ve venir —son dos direcciones de recurso
> distintas— y el síntoma sería un `AccessDenied` en el relay de producción
> después de un apply que no tocó producción. De ahí
> `permisos_de_task = false`.

Cuestan ~$0: SQS se cobra por petición y una cola parada no hace ninguna. Por
eso **no siguen la perilla de encendido** — apagar el despliegue no tiene por
qué dejarte sin entorno local.

## La cola sobrevive a `reset-scratch`

`sh reset-scratch` vacía las tres bases locales y borra los logs, pero **no toca la
cola SQS**: está en AWS y es compartida. Si quedaron mensajes de la corrida
anterior, C4 los insertará al arrancar y la siguiente medición saldrá inflada. El
script imprime el `purge-queue` para que lo decidas tú.

> ⚠ `purge-queue` solo se admite **una vez cada 60 s** por cola. El paso 3 de
> `destruir.sh` lo tiene en cuenta y sigue adelante si se lo rechazan.
