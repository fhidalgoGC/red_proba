# oneClient — 1 tenant

Root module de humo. Misma infraestructura que `50client`, con
`tenants = ["01"]`.

## Para qué

Responder **"¿funciona el camino completo?"** antes de gastar en escala:

```
API tenant 01 → genera → JCS → firma KMS → cifra → outbox
              → relay → SQS FIFO → C4 → descifra → verifica → inbox
```

Si un evento entra por el API y sale persistido en el Postgres de C4 con la
firma verificada, la arquitectura está probada. Todo lo demás es volumen.

## Qué NO responde

Nada de P1–P4. Con 1 tenant y carga mínima no hay percentiles, no hay
saturación y no se ejercita el techo de 300 msg/s por `MessageGroupId`.
Eso es `50client`.

## Checklist de humo

- [ ] `apply` completa y las tareas quedan en `RUNNING` (no `PROVISIONING`)
- [ ] `GET /health` del tenant 01 responde 200 **y toca la base** (C-08)
- [ ] `POST { n: 10 }` devuelve id de lote de inmediato (C-01, no procesa inline)
- [ ] las 10 filas del outbox pasan `PENDING` → `SENT`
- [ ] las 10 llegan al inbox de C4 con firma verificada
- [ ] `e0..e10` están todas pobladas y en orden creciente
- [ ] reenviar el mismo evento → `duplicado = true`, no una segunda fila (G-03)
- [ ] `desired_count=0` → `apply` → `destroy` sin huérfanos (T-09, cronometrar)

## Aislamiento — no aplica todavía

Con 1 tenant no hay contra quién probar D-02. La verificación de conexión
cruzada (`psql -h db-07` desde el tenant 08 **debe dar timeout**) vive en
`50client`, y es la única forma de detectar un `for_each` mal indexado:
falla en silencio.
