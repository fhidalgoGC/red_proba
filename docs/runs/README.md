# Corridas — resultados medidos

Cada corrida deja aquí su informe navegable y los datos crudos que lo
sustentan. **Los datos son lo que no se puede regenerar**: al apagar el
despliegue las bases se destruyen (`rds_persistente = false`) y las filas
originales desaparecen.

---

## 2026-09-01 · 39 tenants · 600 s · 781 ev/s

| | |
|---|---|
| [**Informe**](2026-09-01-39clients-600s.html) | el análisis completo — abrir desde el disco, sin servidor |
| [**Infraestructura**](2026-09-01-infraestructura.html) | inventario de los 616 recursos, con diagramas |
| [`__informe.json`](2026-09-01-39clients-600s__informe.json) | el informe del orquestador, con la serie por segundo de los 39 (10 MB) |
| [`__serie-orq.json`](2026-09-01-39clients-600s__serie-orq.json) | 600 puntos agregados: eventos, peticiones, peso, errores |
| [`__serie-c4.json`](2026-09-01-39clients-600s__serie-c4.json) | 600 puntos del inbox de C4: cuántos y cuántos bytes |
| [`__outbox-39.json`](2026-09-01-39clients-600s__outbox-39.json) | por tenant: documentos, filas en tabla y percentiles de cada tramo |
| [`__barrido.txt`](2026-09-01-39clients-600s__barrido.txt) | la salida cruda de `sh sql db --todos` |

### Lo que respondió

| | |
|---|---|
| **P1 · extremo a extremo** | **326 ms** por documento — 263 de C3, 23 de cola, 40 de C4 |
| **P2 · ritmo sostenido** | **781,3 ev/s** · p95 829 · 2,29 MB/s · desviación entre minutos < 1 % |
| **P3 · qué se satura primero** | **nada de lo esperado.** Ni KMS (6 ms por firma, 78 % de la cuota), ni C4 (cola en 0), ni CPU (5-8 %). El techo de latencia es `OUTBOX_POLL_MS`; el de errores, `C3_BD_POOL` |
| **P4 · ¿llegó todo?** | **468 678 = 468 678.** Cero pérdida entre C3 y C4, cero duplicados, cero en la DLQ |

### Los tres hallazgos

1. **El cuello de botella es un temporizador, no una saturación.** La espera en
   el outbox son 227 ms de los 263 de C3 — el 86 %. No crece con la carga: es
   medio periodo de `OUTBOX_POLL_MS = 500`. Los 39 tenants dieron entre 221 y
   236 ms.

2. **El 93 % del coste es la operación más rápida.** Firmar cuesta 6 ms y
   $0,000015 por documento: $7,03 de los $7,60 de la corrida. Toda la
   infraestructura —39 contenedores, 40 bases, 14 endpoints— sumó 46 centavos en
   esos mismos diez minutos. **El coste escala con los eventos, no con los
   tenants.**

3. **Los 107 perdidos son de un solo tenant.** `tenant-01`, el único que
   arrastraba datos de una corrida anterior: 81 464 filas contra ~12 000 de los
   demás. Tocó exactamente `C3_BD_POOL = 10` conexiones; ningún otro pasó de 3.

### Cómo leerlos

⚠ **No restes `occurred_at` de `e10_persistido`.** Da 5 643 ms y parece el
extremo a extremo, pero el planificador materializa los documentos **cinco
segundos por delante** (`VENTANA_MATERIALIZACION`) y ese campo se fija al
construirlos. El extremo a extremo real —326 ms— sale de las marcas `e0`–`e10`,
que escriben C3 y C4 con sus propios relojes. Detalle en
[orquestador/docs/01-como-funciona.md](../../orquestador/docs/01-como-funciona.md).

⚠ **Un timeout del arnés no es una pérdida.** C4 acabó con 66 documentos *más*
de los que el orquestador contó como `ok`. La conciliación se hace contra las
bases, no contra el informe del arnés.

---

## Cómo se genera una entrada

```bash
curl -s localhost:9090/batch/<id> > docs/runs/<fecha>-<nombre>__informe.json
sh sql db --todos "... where prueba = '<id>'"     # los N outboxes
sh sql c4 "... where prueba = '<id>'"             # el inbox
```

Y **antes de apagar**: si hace falta conservar las filas crudas, exportarlas.
`sh terraform:deploy --down` destruye las bases.
