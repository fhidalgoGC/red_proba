# Terraform — documentación del track `T`

La **infraestructura**: dos VPC sin ninguna ruta entre ellas, 51 instancias RDS,
una cola FIFO, cuatro llaves de KMS y ~52 servicios de Fargate.

El track no está terminado cuando algo despliega. Está terminado cuando
`destruir.sh` deja la cuenta en cero **verificado**, no supuesto.

> **[Diagramas](diagramas.html)** — la arquitectura dibujada: la topología, el
> aislamiento por security group, las cuatro llaves y el ciclo de vida. Es un HTML
> autocontenido: ábrelo desde el disco, sin servidor ni conexión.

---

## Los documentos

| | Qué responde |
|---|---|
| [01 · Cómo funciona](01-como-funciona.md) | Qué despliega, los tres estados, y por qué `oneClient` y `50client` no son dos copias |
| [02 · La red](02-red.md) | Las dos VPC, el aislamiento por SG, y los cinco greps que prueban que SQS es el único canal |
| [03 · Seguridad](03-seguridad.md) | Las cuatro llaves, los tres `Deny` explícitos, y la desviación que hay que decir en la demo |
| [04 · Las bases de datos](04-bases.md) | Una RDS por tenant más la de C4, y por qué apagar las borra |
| [05 · Costes y perillas](05-costos.md) | Qué cuesta cada estado, las cuatro perillas y las cuotas que tardan días |
| [06 · Operación](06-operacion.md) | Los scripts, el orden del destroy, y qué significa «quedó limpio» |
| [07 · Reglas que no se negocian](07-reglas.md) | Las diez decisiones que si se rompen invalidan algo |
| [08 · La referencia generada](08-referencia-generada.md) | Los archivos que escriben los scripts tras cada `apply` |
| [Diagramas](diagramas.html) | La arquitectura dibujada — abrir en el navegador |

El **diseño** del track vive aparte, en
[../../docs/06-infraestructura.md](../../docs/06-infraestructura.md). Esto es la
implementación.

---

## Arranque rápido

```bash
sh terraform:deploy --clients 1   # despliega · 1 tenant (máximo 200)
sh terraform:deploy --estado      # qué hay desplegado
sh terraform:deploy --down        # apaga: cómputo y endpoints a cero
```

Entre corridas se **apaga**, no se destruye (T-07). Para coste cero absoluto:

```bash
terraform/scripts/destruir.sh oneClient
```

### ⚠ Apagar borra las bases

RDS **no escala a cero**: la única forma de no pagarlo es destruir la instancia.
Por eso sigue la misma perilla que los endpoints, y por eso apagar con el defecto
(`rds_persistente = false`) se lleva las 51 instancias y sus datos.

Si la medición tiene que sobrevivir a un apagado, hay dos vías: `rds_persistente =
true` y asumir ~$2,10/día, o exportar las tablas a S3 antes — que es lo que hace
`destruir.sh` en su paso 2.

---

## Estado

| Tarea | |
|---|---|
| `T-01` Backend de estado remoto | ⏳ listo para descomentar antes de `50client` |
| `T-02` Módulo de red | ✅ |
| `T-03` Módulo de seguridad | ✅ |
| `T-04` Módulo de mensajería | ✅ |
| `T-05` Módulo de tenant, parametrizado | ✅ |
| `T-06` Módulos de C4 y del orquestador | ✅ |
| `T-07` Apagar sin destruir | ✅ |
| `T-08` Destruir de verdad — ensayar antes | ✅ `destruir.sh` en 5 pasos |
| `T-09` Ensayo completo cronometrado | ⏳ pendiente en `oneClient` |
| `T-10` Verificación de que no queda nada vivo | ✅ `verificar-limpio.sh` |

---

## En una frase

Dos VPC que **no se tocan** —el único canal es una cola FIFO— con 50 tenants
aislados entre sí por un security group auto-referenciado, cada uno con su propia
instancia RDS; cuatro llaves de KMS con un `Deny` explícito que impide que el
operador neutro firme aunque un admin le afloje IAM; y todo detrás de una sola
perilla que apaga cómputo, endpoints y bases en segundos, porque esto factura por
hora y el track no cierra hasta que la cuenta vuelve al baseline.
