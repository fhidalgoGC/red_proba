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
reintentando para siempre. Los repos y el comando de login quedan en
[`docs/<escenario>-referencia.md`](08-referencia-generada.md) después de cada
`apply`:

```bash
aws ecr get-login-password --region $(jq -r '.resumen.value.region' oneClient-outputs.json) \
  | docker login --username AWS --password-stdin \
      $(jq -r '.ecr.value["c3-api"]' oneClient-outputs.json | cut -d/ -f1)
```

## La cola sobrevive a `reset-scratch`

`sh reset-scratch` vacía las tres bases locales y borra los logs, pero **no toca la
cola SQS**: está en AWS y es compartida. Si quedaron mensajes de la corrida
anterior, C4 los insertará al arrancar y la siguiente medición saldrá inflada. El
script imprime el `purge-queue` para que lo decidas tú.

> ⚠ `purge-queue` solo se admite **una vez cada 60 s** por cola. El paso 3 de
> `destruir.sh` lo tiene en cuenta y sigue adelante si se lo rechazan.
