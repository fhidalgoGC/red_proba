# terraform/scripts

Envoltorios finos sobre Terraform. **Ninguno crea recursos por su cuenta**:
todo pasa por `tofu`. Lo único imperativo es higiene previa al destroy
(exportar logs, purgar la cola), que no crea nada.

## Ciclo de vida

```
crear.sh ──► actualizar.sh ──► destruir.sh
   │                              ▲
   └──► apagar.sh ⇄ encender.sh ──┘
```

| Script | Qué hace | Cuándo |
|---|---|---|
| `crear.sh <esc>` | Levanta desde cero. `--encender` para arrancar servicios. | La primera vez |
| `actualizar.sh <esc>` | Aplica cambios. Muestra el diff y avisa si destruye. | Cuando cambia el código |
| `apagar.sh <esc>` | Cómputo y endpoints a cero. Conserva red, llaves, colas, **datos**. | Entre corridas |
| `encender.sh <esc>` | Vuelve a levantar. Necesita imágenes en ECR. | Antes de una corrida |
| `destruir.sh <esc>` | No deja **nada**. Exporta, purga, destruye, verifica. | Al terminar |
| `verificar-limpio.sh` | Lista lo que quedó vivo con nuestro tag. | Tras destruir, y al día siguiente |
| `costos.sh` | Reporte por día. | Al día siguiente |

Todos piden confirmación escribiendo `si`. Se salta con `--si` o `AUTO=1`.

## Los tres estados y lo que cuestan

| Estado | Cómputo | Endpoints | Costo |
|---|---|---|---|
| **Destruido** | — | — | $0 |
| **Apagado** (`desired_count=0`) | 0 | 0 | **~$0,15/día** |
| **Encendido** (`desired_count=1`) | tareas | 15 ENIs | ~$3,60/día + Fargate |

Los interface endpoints siguen a la perilla de encendido a propósito. Si no
lo hicieran, estar "apagado" costaría ~$3,60/día con `az_count=1` — casi
50× el baseline de la cuenta, sin nada corriendo.

**"Apagado" no es gratis, es barato.** Lo que sigue facturando con cero
cómputo son las **4 llaves de KMS a $1/mes cada una** más el secreto a
$0,40 — unos **$4,40/mes ≈ $0,15/día**. Es casi el doble del baseline de la
cuenta, así que se nota en el reporte diario. Si la PoC va a quedar quieta
más de una semana, conviene `destruir.sh` en vez de `apagar.sh`.

El gateway de S3 es la excepción: no sigue la perilla porque **es gratis**,
y es el que se olvida.

## Por qué `destruir.sh` tiene ese orden

1. **apagar** — drena tareas y libera ENIs. Sin esto el destroy pelea con
   recursos en uso.
2. **exportar** — los log groups se van con el destroy y **no se
   recuperan**. Es la única oportunidad.
3. **purgar** — la cola no se borra con mensajes en vuelo.
4. **destroy**
5. **verificar** — lo único que prueba que quedó limpio.

Lo que sobrevive igual: las **llaves de KMS** entran en periodo de espera de
7 días. No facturan uso, pero siguen contando para la cuota de llaves.
