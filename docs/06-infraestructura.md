# 06 — Infraestructura

## Inventario de AWS

### Cómputo y registro

| Servicio | Para qué | Dónde | Cuántos |
|---|---|---|---|
| **ECS + Fargate** | Dos clusters. Cada tenant aporta dos task definitions y dos services (API + Postgres). En C4, los servicios del operador y su base. | C3, C4, ORQ | ~106 services |
| **ECR** | Un repo para el API y otro para el Postgres con su init. Una imagen sirve a los 50. | C3, C4 | 2–3 repos |

### Mensajería

| Servicio | Para qué | Dónde | Cuántos |
|---|---|---|---|
| **SQS FIFO** | El único canal entre dominios. Modo de alto rendimiento activado. Más su DLQ. | C4 | 2 colas |

### Criptografía y secretos

| Servicio | Para qué | Dónde | Cuántos |
|---|---|---|---|
| **KMS** | Cuatro llaves, ninguna hace el trabajo de otra (ver abajo). | C3, C4 | 4 llaves |
| **Secrets Manager** | Credenciales de Postgres. Uno por tenant, o uno solo si la PoC no ejercita eso. | C3, C4 | 1–51 |

**Las cuatro llaves:**

| Llave | Dónde | C3 puede | C4 puede |
|---|---|---|---|
| Ed25519 de firma | C3 | `Sign` | **nada** |
| HMAC de pseudonimización | C3 | `GenerateMac` | **nada** |
| Simétrica de cifrado de mensajes | C4 | `GenerateDataKey` | `Decrypt` |
| Cifrado de la cola en reposo | C4 | `GenerateDataKey` | `Decrypt` |

**La asimetría es el invariante**: C4 descifra pero no firma; C3 firma y cifra
pero no descifra.

### Red

| Servicio | Para qué | Dónde | Cuántos |
|---|---|---|---|
| **VPC** | Una por dominio de confianza, CIDR sin traslape. | ×3 | 3 |
| **Subnets** | Privada (aplicación) y aislada sin ruta a internet (datos), en 2 AZ. | C3, C4 | 8+ |
| **Security Groups** | 50 auto-referenciados en C3, 1 en C4, 1 en ORQ. | ×3 | 52 |
| **VPC Endpoints** | Interfaz: `ecr.api`, `ecr.dkr`, `secretsmanager`, `kms`, `logs`, `sqs`. Gateway: S3. Duplicados en C3 y C4. | C3, C4 | 12 + 2 |
| **Cloud Map** | Namespace privado: `api-NN.poc.local`, `db-NN.poc.local`. | C3 | 1 + 100 |
| **VPC Peering** | ORQ ↔ C3, más las rutas en ambas tablas. Sin cargo por hora. | ORQ, C3 | 1 |

> **El endpoint gateway de S3 es obligatorio** aunque no uses S3 directamente:
> ECR guarda las capas de imagen en S3, y sin él las descargas fallan aunque
> tengas `ecr.api` y `ecr.dkr`. Es gratis, y se olvida.

### Identidad

| Recurso | Para qué |
|---|---|
| **IAM execution role** | Lo usa ECS, no tu código: pull de ECR, leer el secreto, escribir logs. |
| **IAM task role** | Lo usa tu proceso: `kms:Sign`, `kms:GenerateDataKey`, `sqs:SendMessage`. En C4: `ReceiveMessage`, `DeleteMessage`, `kms:Decrypt`. |
| **Resource policy de la cola** | Permite `SendMessage` al task role de C3. **Se olvida siempre.** |

### Observabilidad

| Servicio | Para qué |
|---|---|
| **CloudWatch Logs** | Un log group por service, retención de 1 día. **Obligatorio**: cuando un evento no verifique, el log es lo único que dice por qué. |
| **Métricas nativas de SQS** | `ApproximateNumberOfMessagesVisible` y `ApproximateAgeOfOldestMessage`. Gratis, y contestan lo de la cola. |
| **S3** | Destino de la exportación de logs y de las tablas de medición. |

> **Cero métricas personalizadas durante la corrida.** A 2.000/s,
> `PutMetricData` por evento son 2.000 llamadas de red por segundo — estarías
> midiendo tu propia instrumentación. Todo el análisis se hace después, con SQL.

### Gobierno

| Recurso | Nota |
|---|---|
| **Organizations** | OU Workload-C3 y Workload-C4. La frontera de cuenta es lo que hace real la separación. |
| **Service Quotas** | Aumento de Fargate vCPU **y** de operaciones criptográficas de KMS. Tardan días. |

### Lo que deliberadamente NO lleva

| No usamos | Por qué |
|---|---|
| **NAT Gateway** | Reemplazado por VPC endpoints. Con 100+ descargas de imagen sería el gasto de red dominante, y abriría salida a internet donde no debe haberla. |
| **Internet Gateway** | Nada entra ni sale de internet. |
| **ALB / NLB** | Los tenants no reciben tráfico externo; el orquestador llega por IP interna vía peering y Cloud Map. |
| **PrivateLink** | Obligaría a un NLB delante de los 50 API. Descartado por costo y complejidad. |
| **VPC Peering C3↔C4** | Es la **ausencia** que sostiene D-03. |
| **RDS** | El diseño real lo usa; la PoC no, por el requisito de que todo vaya en Fargate. Es la desviación documentada. |
| **EventBridge Scheduler** | El relay y el purgado corren con `@nestjs/schedule` dentro del proceso. |

---

## Terraform

### T-01 · Backend de estado remoto, antes que nada

Bucket S3 con versionado y bloqueo. Son dos cuentas y va a haber más de una
persona aplicando: con estado local, dos `apply` simultáneos corrompen el estado
y la recuperación se come horas. **Primero en crearse, último en destruirse.**

### T-02 · Módulo de red

Las tres VPC con CIDR sin traslape, subnets en 2 AZ, VPC endpoints en C3 y C4,
peering ORQ↔C3 con rutas en ambas tablas, asociación de la zona de Cloud Map a
la VPC del orquestador.

### T-03 · Módulo de seguridad

Los 50 SG por `for_each`, el de C4, el de ORQ. Los roles de IAM. Las cuatro
llaves de KMS con sus policies.

### T-04 · Módulo de mensajería

Cola FIFO con alto rendimiento, DLQ, resource policy cross-account, cifrado en
reposo.

### T-05 · Módulo de tenant, parametrizado

`for_each` sobre la lista de 50 → dos task definitions, dos services, registro
en Cloud Map, log groups. Todo lo que cambia son variables de entorno.

### T-06 · Módulos de C4 y del orquestador

### T-07 · Apagar sin destruir

Una variable `desired_count` que puedas llevar a cero con un `apply`. Deja de
facturar cómputo en segundos y **conserva red, llaves, colas y datos** — que es
lo que quieres entre corridas.

```bash
terraform apply -var 'desired_count=0'   # apagar
terraform apply -var 'desired_count=1'   # volver a encender
```

### T-08 · Destruir de verdad — ensayar antes

El `destroy` falla más seguido de lo que parece:

- Los **VPC endpoints** tienen ENIs que tardan en liberarse.
- La **cola** no se borra con mensajes en vuelo.
- Las **llaves de KMS** no se destruyen: entran en periodo de espera.
- Los **log groups se van y no se recuperan** → la exportación a S3 tiene que
  ocurrir antes.

El orden importa y hay que probarlo.

### T-09 · Ensayo completo con dos tenants

`apply` → carga mínima → `desired_count=0` → `apply` → `destroy`, cronometrado.
Da el tiempo real de arranque y confirma que la destrucción no deja huérfanos.

### T-10 · Verificación de que no queda nada vivo

Script que liste, en ambas cuentas: services con `desiredCount` ≠ 0, tareas en
`RUNNING`, ENIs sin liberar. Correrlo tras el destroy y otra vez al día
siguiente contra Cost Explorer.
