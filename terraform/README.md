# Terraform — PoC RPF Proof Ledger

## Regla de oro: crear todo y borrar todo

Esta PoC factura por hora. El track `T` no está terminado hasta que
`destruir.sh` deja la cuenta en cero **verificado**, no supuesto.

Tres niveles, de menos a más agresivo:

| Nivel | Comando | Qué hace | Qué conserva |
|---|---|---|---|
| **Crear** | `scripts/crear.sh <esc>` | desde cero | — |
| **Actualizar** | `scripts/actualizar.sh <esc>` | aplica cambios, avisa si destruye | todo lo demás |
| **Apagar** | `scripts/apagar.sh <esc>` | cómputo y endpoints a 0 | red, llaves, colas, **datos** |
| **Encender** | `scripts/encender.sh <esc>` | vuelve a levantar | — |
| **Destruir** | `scripts/destruir.sh <esc>` | exporta, purga, destruye, verifica | nada |
| **Verificar** | `scripts/verificar-limpio.sh` | lista lo que quedó vivo | — |

Desde la raíz del repo hay un frente único sobre esos scripts, que además
decide **cuántos clientes**:

```bash
sh terraform:deploy --clients 1     # la prueba inicial · 1 tenant
sh terraform:deploy --clients 50    # hasta 200
sh terraform:deploy --down          # apaga: cómputo y endpoints a cero
sh terraform:deploy --estado        # qué hay desplegado
sh terraform:deploy --clients 8 --plan   # enseña el plan y no aplica
```

No reimplementa nada: escribe `clientes.auto.tfvars` con la lista de tenants
—mismo patrón que `estado.auto.tfvars`, y por la misma razón: un `-var` no
coincide con lo que el plan guardado relee— y delega en `crear.sh`,
`actualizar.sh`, `encender.sh` y `apagar.sh`.

Antes de aplicar **mira la cuenta**, no supone: consulta las cuotas reales de
RDS, KMS y Fargate, cuenta las instancias vivas —**las de otros equipos también
gastan cupo**— y se planta si no caben. No es un formalismo: cuando la cuota de
RDS no alcanza, el `apply` no falla al empezar, crea las que caben y revienta a
mitad con `InstanceQuotaExceeded`, dejando el estado a medias y bases
facturando.

También avisa de lo que no se arregla reintentando: bajar el número de clientes
**destruye** los tenants sobrantes con su Postgres; subirlo **reinicia el
orquestador** —su task definition lleva la lista de tenants— y, si cambia
`az_count`, reinicia además los tenants que ya existían. Y no enciende si las
imágenes no están en ECR: encender sin ellas no da un error de despliegue, da
servicios reintentando para siempre.

⚠ El escenario sigue siendo `oneClient` aunque pidas 50 clientes: es el único
root module con código, y eso es deliberado. `50client/` es el **runbook** de la
corrida de 50 —bloqueantes, radio de impacto, perillas y la prueba de
aislamiento— no un segundo `main.tf`. Ver [50client/README.md](50client/README.md).

Detalle en [scripts/README.md](scripts/README.md). Los IDs de cada apply
quedan en [docs/](docs/README.md).

Entre corridas se **apaga**, no se destruye: deja de facturar cómputo en
segundos y conserva el estado que costó horas montar (T-07).

## Estructura

```
terraform/
├── modules/          código real, uno por dominio (T-02 … T-06)
│   ├── network/      2 VPC (C3, C4), subnets, endpoints, Cloud Map. Sin peering
│   ├── security/     SG por for_each, roles IAM, las 4 llaves KMS
│   ├── messaging/    cola FIFO + DLQ + resource policy cross-account
│   ├── tenant/       for_each → task def + service + RDS + Cloud Map + logs
│   ├── c4/           consumidor del operador neutro + su RDS
│   └── orq/          contenedor de carga
├── oneClient/        EL root module — var.tenants la escribe terraform:deploy
├── 50client/         runbook de la corrida de 50 (sin .tf, a proposito)
└── scripts/          apagar · encender · destruir · verificar
```

### Un solo root module, y por qué

Al principio esto iban a ser dos carpetas con código, una por escala. No lo son,
y la razón está en el propio argumento que las justificaba: lo ÚNICO que
distingue un escenario de otro es `var.tenants`. Duplicar `main.tf` para cambiar
un número es exactamente lo que D-07 y T-05 prohíben —`for_each` sobre la lista,
nunca 50 bloques copiados— y en cuanto los dos archivos divergen, **lo que
validaste con 1 tenant deja de ser lo que corres con 50**.

Así que la lista la escribe `terraform:deploy` en
`oneClient/clientes.auto.tfvars` y se aplica sobre el mismo estado:

```hcl
tenants  = ["01"]                       # sh terraform:deploy --clients 1
tenants  = ["01", "02", ..., "50"]      # sh terraform:deploy --clients 50
```

**Consecuencia buscada:** subir de 1 a 50 **añade 49**, no recrea 50. Los
tenants que ya existen conservan su RDS y su outbox, y los 50 comparten una
sola cola, un solo C4 y un solo juego de llaves KMS — que es lo que hace
comparable la medición entre escalas.

**El precio:** un solo state, y local. Dos personas aplicando a la vez lo
corrompen. Antes de la corrida de 50, descomentar el backend S3 de
[`oneClient/versions.tf`](oneClient/versions.tf) si va a aplicar más de uno.

## Orden de trabajo

1. **1 tenant primero.** Prueba de humo: un puñado de eventos, el camino
   completo C3 → SQS → C4. Responde "¿funciona?".
2. **50 después.** Escala. Responde P1–P4, y es la primera vez que se puede
   correr la prueba de aislamiento de D-02 — con un solo tenant no hay contra
   quién.

El ensayo completo de T-09 (`apply` → carga → `apagar` → `destruir`,
cronometrado) se hace con 1 tenant antes de subir a 50.

## Lo que rompe el `destroy` (T-08)

Probado antes, no descubierto el día de la demo:

- **VPC endpoints** — sus ENIs tardan en liberarse; el destroy de la subnet
  falla mientras tanto.
- **Cola SQS** — no se borra con mensajes en vuelo. Purgar antes.
- **Llaves KMS** — no se destruyen: entran en periodo de espera (7–30 días).
  Siguen contando para la cuota de llaves.
- **Log groups** — se van y **no se recuperan**. La exportación a S3 tiene
  que ocurrir ANTES del destroy.
- **Backend de state (T-01)** — primero en crearse, último en destruirse.
  Se destruye a mano, fuera de estos scripts.

## Pendiente de decidir antes de escribir `.tf`

- [ ] ¿Una cuenta AWS o dos (`c3-dev` / `c4-dev`)? El doc asume dos + una OU
      por dominio. Con una sola cuenta el invariante C3/C4 se sostiene solo
      con IAM, no con frontera de cuenta.
- [ ] Región: `us-east-1` (~$64 el cómputo) vs `sa-east-1` (~$86).
- [ ] CIDR de las dos VPC (C3 y C4) — ya no hay peering que exija que no se
      traslapen, pero mantenerlos separados sigue siendo higiene.
- [ ] Bucket + tabla de lock del backend remoto (T-01).
- [ ] **Los aumentos de cuota, y son dos, no tres.** Medido el 2026-08-31 en
      `us-west-2`: Fargate ya da 4.000 vCPU (sobra), pero **RDS son 40 por
      región y hacen falta 51**, y KMS ECC son 1.000 ops/s y hacen falta 3.000.
      **Tardan días.** Sin la de RDS el apply revienta a mitad; sin la de KMS la
      prueba mide throttling. Comandos y detalle en
      [50client/README.md](50client/README.md) y
      [../docs/08-limites.md](../docs/08-limites.md).
