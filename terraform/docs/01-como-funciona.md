# 01 — Cómo funciona

## Qué despliega

Dos VPC, 51 instancias RDS, una cola FIFO, cuatro llaves de KMS y ~52 servicios
de Fargate. Todo con `for_each` sobre una lista de tenants: **nunca 50 bloques
copiados**.

```
terraform/
├── modules/          el código real
│   ├── network/      2 VPC, subnets, endpoints, Cloud Map, DB subnet groups
│   ├── security/     52 SG, 3 roles de tarea, las 4 llaves KMS
│   ├── messaging/    cola FIFO + DLQ + resource policy
│   ├── tenant/       for_each → task def + service + RDS + Cloud Map + logs
│   ├── c4/           consumidor + su RDS
│   ├── orq/          driver de carga (dentro de la VPC de C3)
│   └── registry/     3 repos de ECR
├── oneClient/        root module — el único con código hoy
├── 50client/         root module — hoy solo un README
└── scripts/          crear · actualizar · apagar · encender · destruir · verificar
```

## `oneClient` y `50client` no son dos copias

Son dos **root modules delgados** sobre los mismos `modules/`. Lo único que
cambia es la lista:

```hcl
tenants = ["01"]                      # oneClient
tenants = ["01", "02", …, "50"]       # 50client
```

Si el código se duplicara entre las dos carpetas, lo que validas con 1 tenant
dejaría de ser lo que corres con 50 — y la prueba de humo no probaría nada.

Cada root module tiene su propio state, así que se pueden tener las dos vivas o
destruir una sin tocar la otra.

> ⚠ Hoy el escenario es `oneClient` **aunque pidas 50 clientes**: es el único
> root module con código. `terraform:deploy --clients 50` escribe
> `clientes.auto.tfvars` con la lista larga y aplica sobre `oneClient/`.

## Los tres estados

No son dos —creado y borrado— sino tres, y la diferencia es toda la gestión de
costo de la PoC.

| Estado | Cómputo | Endpoints | RDS | Coste |
|---|---|---|---|---|
| **Destruido** | — | — | — | $0 |
| **Apagado** (`desired_count=0`) | 0 tareas | 0 | destruidas¹ | ~$0,15/día |
| **Encendido** (`desired_count=1`) | tareas | 14 por AZ | 51 | ~$3,36/día por AZ + RDS + Fargate + KMS |

¹ salvo `rds_persistente = true`. Ver [04 · Bases de datos](04-bases.md).

**Entre corridas se apaga, no se destruye** (T-07): deja de facturar cómputo en
segundos y conserva red, llaves y colas, que es lo que costó horas montar.

## El ciclo de vida

```
crear.sh ──► actualizar.sh ──► destruir.sh
   │                              ▲
   └──► apagar.sh ⇄ encender.sh ──┘
```

Desde la raíz del repo hay un frente único sobre esos scripts, que además decide
cuántos clientes:

```bash
sh terraform:deploy --clients 1     # la prueba inicial · 1 tenant (máx. 200)
sh terraform:deploy --down          # apaga
sh terraform:deploy --estado        # qué hay desplegado
sh terraform:deploy --clients 8 --plan   # enseña el plan y no aplica
```

No reimplementa nada: escribe `clientes.auto.tfvars` y delega en los scripts.

## Por qué la perilla se escribe en un archivo

`apagar.sh` y `encender.sh` no pasan `-var desired_count=N`. **Escriben**
`estado.auto.tfvars`.

El bug que evita: al aplicar un plan guardado, OpenTofu vuelve a leer los
`tfvars` y compara. Un `-var` de la línea de comandos no coincide con lo que hay
en el archivo y da `Mismatch between input and plan variable value`.

Efecto lateral bueno: el estado de encendido queda **visible en disco** en vez de
vivir en el historial de la terminal.

## El orden de trabajo

1. **`oneClient` primero.** Prueba de humo: 1 tenant, un puñado de eventos, el
   camino completo C3 → SQS → C4. Responde «¿funciona?».
2. **`50client` después.** Escala. Responde P1–P4.

El ensayo completo de T-09 —`apply` → carga → `apagar` → `destruir`,
cronometrado— se hace en `oneClient` **antes** de tocar `50client`.
