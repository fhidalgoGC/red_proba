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

Detalle en [scripts/README.md](scripts/README.md). Los IDs de cada apply
quedan en [docs/](docs/README.md).

Entre corridas se **apaga**, no se destruye: deja de facturar cómputo en
segundos y conserva el estado que costó horas montar (T-07).

## Estructura

```
terraform/
├── modules/          código real, uno por dominio (T-02 … T-06)
│   ├── network/      3 VPC, subnets, endpoints, peering ORQ↔C3, Cloud Map
│   ├── security/     SG por for_each, roles IAM, las 4 llaves KMS
│   ├── messaging/    cola FIFO + DLQ + resource policy cross-account
│   ├── tenant/       for_each → 2 task defs + 2 services + Cloud Map + logs
│   ├── c4/           servicios del operador neutro + su Postgres
│   └── orq/          contenedor de carga
├── oneClient/        root module — var.tenants = ["01"]
├── 50client/         root module — var.tenants = ["01" … "50"]
└── scripts/          apagar · encender · destruir · verificar
```

### `oneClient` y `50client` NO son dos copias

Son dos **root modules delgados** sobre los mismos `modules/`. Lo único que
cambia es la lista de tenants:

```hcl
# oneClient/terraform.tfvars
tenants = ["01"]

# 50client/terraform.tfvars
tenants = ["01", "02", ..., "50"]
```

Esto es D-07 y T-05 aplicados: `for_each` sobre la lista, nunca 50 bloques
copiados. Si el código se duplicara entre las dos carpetas, lo que validaste
con 1 tenant dejaría de ser lo que corres con 50 — y la prueba de humo no
probaría nada.

Cada root module tiene su **propio state** (backend con `key` distinta), así
que se pueden tener las dos vivas o destruir una sin tocar la otra.

## Orden de trabajo

1. **`oneClient` primero.** Prueba de humo: 1 tenant, un puñado de eventos,
   el camino completo C3 → SQS → C4. Responde "¿funciona?".
2. **`50client` después.** Escala. Responde P1–P4.

El ensayo completo de T-09 (`apply` → carga → `apagar` → `destruir`,
cronometrado) se hace en `oneClient` antes de tocar `50client`.

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
- [ ] CIDR de las tres VPC — no pueden traslaparse (requisito de ORQ-06).
- [ ] Bucket + tabla de lock del backend remoto (T-01).
- [ ] ¿Ya se pidieron los aumentos de cuota? KMS 1.000 → 3.000 ops/s y
      Fargate vCPU. **Tardan días** y sin ellos la prueba mide throttling.
      Ver [../docs/08-limites.md](../docs/08-limites.md).
