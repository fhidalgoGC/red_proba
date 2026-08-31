# 50client — 50 tenants

Root module de la prueba real. Mismos `modules/` que `oneClient`, con
`tenants = ["01" … "50"]`.

Solo se corre **después** de que `oneClient` pasó su checklist de humo.

## Para qué

Responder P1–P4 con números (ver [../../docs/07-medicion.md](../../docs/07-medicion.md)).

## Antes del primer `apply` — bloqueantes

Sin esto la corrida se cancela o mide la cosa equivocada:

- [ ] **Cuota KMS ops criptográficas ECC: 1.000 → 3.000/s.** Todo el perfil
      de carga vive por encima del default, incluso el valle de 900. **Tarda días.**
- [ ] **Cuota Fargate On-Demand vCPU** para ~106 tareas (~150 vCPU).
      Sin ella las tareas se quedan en `PROVISIONING`.
- [ ] **Alto rendimiento activado en la cola FIFO.** No cuesta nada y sube el
      techo de 300/s por grupo.
- [ ] Presupuesto aprobado: la firma es el renglón dominante,
      ~**$540** por 5 h a 2.000 ev/s. Ver [../../docs/08-limites.md](../../docs/08-limites.md).

## Verificación de aislamiento — obligatoria (D-02)

Un error de índice en el `for_each` **no rompe nada visible**: simplemente el
tenant 08 puede leer la base del 07. Solo lo detecta la prueba explícita.

```bash
# desde la tarea del tenant 08, contra el host del 07
psql -h db-07.poc.local -U app -c 'select 1'
# DEBE dar timeout.
# Si da "password authentication failed", la conexión TCP se estableció
# y el aislamiento NO existe.
```

## Antes del `destroy`

Los log groups **no se recuperan**. Exportar a S3 primero:
- ambas tablas de medición (`outbox` de los 50, `inbox` de C4)
- los log groups de todos los services

Sin eso la corrida de $540 no deja evidencia.
