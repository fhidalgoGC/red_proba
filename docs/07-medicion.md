# 07 — Medición

Todo lo demás existe para producir cuatro números.

| | Pregunta | Se responde con |
|---|---|---|
| **P1** | ¿Cuánto tarda un documento? | Percentiles de los tres agregados |
| **P2** | ¿A qué ritmo procesa? | Eventos/s sostenidos, no de pico |
| **P3** | ¿Dónde está el límite? | El ritmo donde el outbox deja de vaciarse |
| **P4** | ¿Llegaron todos? | Ecuación de conciliación |

## Alcance

La medición **arranca cuando el payload está listo** y **termina cuando el
evento queda persistido en el Postgres de C4**.

El orquestador, el API y el generador quedan **fuera**: son el arnés de la
prueba, no el sistema que se evalúa.

## Las marcas

```
      ── C3 ──────────────────────────────┤ COLA ├── C4 ───────────
  e0    e1    e2    e3    e4    e5    e6    e7    e8    e9    e10
  │     │     │     │     │     │     │     │     │     │     │
listo  JCS  firma cifra commit relay  SQS  c4 rx desc. verif. COMMIT
```

| Marca | Instante | Dónde se guarda |
|---|---|---|
| `e0` | payload generado, entra al mapper | outbox (C3) |
| `e1` | canonizado | outbox |
| `e2` | KMS `Sign` devuelve | outbox |
| `e3` | cifrado | outbox |
| `e4` | COMMIT de la transacción de negocio | outbox |
| `e5` | el relay reclama la fila | outbox |
| `e6` | SQS confirma | outbox |
| `e7` | C4 recibe el mensaje | inbox (C4) |
| `e8` | descifrado | inbox |
| `e9` | firma verificada | inbox |
| `e10` | **COMMIT** en Postgres de C4 | inbox |

## Etapas y agregados

**Por etapa** (para saber qué arreglar):

| Intervalo | Etapa | Tipo |
|---|---|---|
| e0→e1 | Canonicalización | trabajo |
| e1→e2 | **Firma (KMS)** | ⚠ el sospechoso |
| e2→e3 | Cifrado | trabajo |
| e3→e4 | Commit del outbox | trabajo |
| e4→e5 | **Espera en outbox** | ⚠ saturación |
| e5→e6 | Publicación a SQS | trabajo |
| e6→e7 | **Tiempo en cola** | ⚠ saturación |
| e7→e8 | Descifrado | trabajo |
| e8→e9 | Verificación de firma | trabajo |
| e9→e10 | Persistencia en Postgres | trabajo |

**Agregados** (lo que se reporta):

| Agregado | Rango |
|---|---|
| **C3 completo** | e0 → e6 |
| **Tiempo en cola** | e6 → e7 |
| **C4 completo** | e7 → e10 |
| **Extremo a extremo** | e0 → e10 |

> Un solo número total no dice nada accionable; diez números sin agregar no se
> pueden comunicar. Por eso ambos niveles.

## La distinción que importa: trabajo vs espera

Canonizar, firmar, cifrar, descifrar y persistir son **trabajo**: tardan lo que
tardan y no crecen solos.

La espera en outbox y el tiempo en cola son **espera**: crecen sin techo cuando
el ritmo de llegada supera al de drenado.

**Si el total se dispara pero las etapas de trabajo siguen planas, el sistema no
se volvió lento: se llenó.**

El **tiempo en cola** (e6→e7) es el único intervalo que no pertenece a ningún
contenedor. Mezcla latencia propia de SQS con retraso del consumidor; se separan
comparándolo contra `ApproximateAgeOfOldestMessage`, que SQS publica gratis: si
esa métrica crece hay respaldo, si no es solo tránsito.

## Reglas de instrumentación

### M-01 · Dos tablas, unidas por `payload_hash`  ⚠ CRÍTICO

`e0..e6` en columnas de la fila del outbox. `e7..e10` en el inbox de C4.

**Nunca dentro del payload**: va firmado, y meterle metadatos de medición
cambiaría lo que se firma.

Las dos mitades se juntan al final con el `payload_hash`, que viaja en claro como
atributo del mensaje. Ahí está la ventaja de haberlo hecho explícito en D-11:
además de deduplicar, es la llave que hace posible medir extremo a extremo.

### M-02 · Guardar muestras crudas, no promedios  ⚠ CRÍTICO

**Los percentiles no se promedian.** Si cada uno de los 50 contenedores reporta
su p99, no existe operación que combine esos 50 números en el p99 del sistema —
el resultado no significa nada.

Conservar las muestras, o histogramas con los mismos buckets, y calcular sobre
el conjunto completo.

### M-03 · Para una PoC, la base de datos ES el almacén de métricas

No montes un stack de observabilidad para una ventana de 8 horas. Ya tienes las
tablas. Al terminar la carga, exportas ambas a S3 y calculas todo con SQL.

Dato completo, sin muestreo, y lo puedes rebanar de formas que no anticipaste.
Un millón de filas con doce columnas de tiempo son unos cientos de MB.

### M-04 · Medir no debe perturbar lo medido

Escribir una métrica a CloudWatch por evento añadiría una llamada de red por
evento — al ritmo objetivo duplicarías el tráfico saliente. Todo se agrega en
memoria y se descarga cada 10–30 segundos.

### M-05 · Señales en vivo: pocas y sin cardinalidad

Durante la corrida solo necesitas saber si seguir o parar. Cuatro series:

1. Profundidad total del outbox
2. Edad del mensaje más viejo en la cola (métrica nativa de SQS, gratis)
3. Ritmo ofrecido (del `/status` del orquestador)
4. Ritmo aceptado (idem)

**Sin dimensión por tenant** — multiplica por 50 el costo y no dice nada que
necesites en el momento.

### M-06 · Un reloj MONÓTONO para las duraciones, además de las marcas

Las marcas `e0..e10` son ISO 8601: resolución de **milisegundo**. Con eso basta
para el extremo a extremo y para conciliar, pero no para los tramos internos —
canonizar 3 KB tarda ~0,05 ms y verificar Ed25519 es sub-milisegundo. Restar dos
marcas da `0 ms` y el informe diría que el pipeline es gratis.

Así que los tres procesos llevan, **además**, muestras de duración tomadas con
`process.hrtime.bigint()`: monótono —no lo mueve un ajuste de NTP a mitad de
corrida— y con resolución de nanosegundo. Van a los logs por segundo
(`C-09` en C3, `G-11` en C4, el informe del orquestador) y **no sustituyen a las
marcas**: las marcas son instantes que sobreviven al proceso y se cruzan entre
dominios; estas son duraciones que viven en memoria.

Cada tramo lleva su par `init`/`completed`, anotados en el segundo en que
**empezó** y en el que **terminó**. Que no coincidan es lo normal y es el dato:
`init − completed` señala en qué paso se quedó lo que no salió.

### M-07 · El id de corrida viaja con el evento, fuera del payload

`x-prueba-id` lo genera el orquestador, va en la cabecera hasta C3, C3 lo guarda
en `outbox.prueba`, el relay lo copia al `MessageAttribute` `prueba` del mensaje
SQS, y C4 lo lee y lo guarda en `inbox.prueba`.

Es lo que hace que los cuatro archivos de una corrida compartan prefijo y que se
puedan cruzar. Sin él, C4 —que es uno para los 50 tenants y consume una cola
compartida— sumaría dos corridas seguidas en el mismo montón.

**Fuera del payload, siempre** (M-01): el payload va firmado y el id de una
prueba no pertenece a un asiento fiscal. Y no toca la deduplicación, que es
explícita por `payload_hash` (D-11).

### M-08 · Reloj común

`e6` lo estampa un contenedor de C3 y `e7` otro de C4, en otra cuenta. La resta
solo tiene sentido si los relojes están sincronizados. Con el servicio de tiempo
de AWS la deriva es de microsegundos, pero conviene registrarla al arrancar cada
tarea: si un intervalo entre hosts sale negativo, ya sabes por qué.

## Definición operativa del límite (P3)

> El sistema está saturado cuando **la profundidad del outbox deja de volver a
> cero** entre ráfagas.

No es la latencia ni el uso de CPU: es que la cola de pendientes ya no se vacía.

**Procedimiento**: subir el ritmo por escalones y anotar el último en el que el
outbox todavía se drenaba. **Ese número es el resultado de la prueba.**

**Cuál componente se satura primero** lo dice cuál intervalo ⚠ crece antes:

| Crece | Significa |
|---|---|
| Espera en outbox | El relay no da abasto, o SQS está limitando |
| Tiempo en cola | El consumidor de C4 es el lento |
| Intervalo de firma | No es saturación de cola: es throttling de KMS. Confirmar con la tasa de `ThrottlingException`. |

## Conciliación (P4)

```
emitidos = únicos en C4 + en vuelo + fallidos
```

Cualquier residuo es **pérdida** y hay que explicarlo.

⚠ **La trampa**: la entrega es al-menos-una-vez, así que C4 puede contar **más**
de lo emitido. Por eso se cuentan únicos por `payload_hash` y los duplicados se
reportan aparte.

> Un duplicado es salud del sistema. Una pérdida es un defecto.

**Huecos** son otra cosa: el `sequence` por `rpf_id` detecta si falta un evento
intermedio. Con FIFO no debería ocurrir nunca, y por eso vale medirlo — un solo
hueco invalida la afirmación de orden.

### ⚠ Contar desde C4 solo no basta

La consulta de huecos de C4 (G-05, más abajo) agrupa el inbox por `rpf_id` y
compara el rango que ve contra los valores distintos que tiene dentro. **El
rango lo definen los propios datos que llegaron**, así que solo encuentra
huecos *interiores*:

| Qué falta | ¿Lo ve C4? | Por qué |
|---|---|---|
| El `sequence` 5 de 1..10 | ✅ | El rango sigue siendo 1..10 y le faltan valores |
| El `sequence` 1 | ❌ | `MIN` pasa a 2 y el rango 2..10 es denso |
| Los `sequence` 9 y 10 | ❌ | `MAX` pasa a 8 y el rango 1..8 es denso |
| El `rpf_id` entero | ❌ | No hay fila, no hay grupo, no hay nada que agrupar |

Y el fallo más probable de esta PoC —un relay que se detiene con filas todavía
pendientes en su outbox— **se lleva justo la cola**. Desde C4 ese caso es
indistinguible de un expediente que terminó ahí.

Le falta un dato que solo tiene quien emitió: **cuántos eventos tenía que
llevar ese expediente**. El payload no lo lleva, y no puede llevarlo — va
firmado.

### El manifiesto cierra el punto ciego

El orquestador decide `rpf_id` y `sequence` (ver
[04-orquestador](04-orquestador.md#o-08--manifiesto-de-expedientes)), así que es
el único que sabe qué salió. Al cerrar la corrida escribe
`orquestador/logs/<prueba>__manifiesto.json` con, por expediente, los rangos de
`sequence` en cuatro estados:

| Estado | Qué significa | ¿Se le puede exigir a C3? |
|---|---|---|
| `aceptados` | El destino contestó 2xx | **Sí.** Si no está en C4, es pérdida |
| `rechazados` | Contestó, pero != 2xx | No: nunca entró |
| `fallidos` | Timeout o error de red | No: no se sabe si entró |
| `no_emitidos` | Se planificó y nunca salió | No: **no es un hueco, es el arnés** |

⚠ **`no_emitidos` no es contabilidad decorativa.** Las secuencias se asignan al
*planificar*, con segundos de antelación; un evento que el planificador no
alcanza a disparar se lleva su `sequence` a la tumba. Sin esa marca, la
conciliación vería su hueco en C4 y **acusaría a C3 de perder un evento que
nunca existió**.

El cruce se hace con dos comandos, después de la corrida:

```bash
cd c4          && npm run informe   -- --nombre <prueba> --desde <ISO>
cd orquestador && npm run conciliar -- logs/<prueba>__manifiesto.json \
                                       ../c4/logs/<prueba>__inbox.json
```

`--desde` no es opcional en la práctica: la base de C4 sobrevive a la corrida y
sin corte temporal el volcado arrastra los expedientes de todas las pruebas
anteriores.

El veredicto sale con código 1 si hay pérdida, y separa lo que acusa a cada uno:

```
  PERDIDA              13   aceptado y ausente en C4      ← el defecto
  sin confirmar        19   salió y nadie contestó
  no emitidos           0   nunca salieron: arnés
  huecos interiores     1   ⚠ invalidan el orden
  colas truncadas       1
  expedientes idos      1
```

⚠ **Los contadores de orden solo miran lo exigible.** Un hueco que dejó una
petición rechazada con 503 aparece en el detalle, pero **no** cuenta como hueco
de orden: ese evento nunca entró al sistema, y dejar que dispare la métrica más
grave de la prueba borraría justo la distinción que O-06 existe para sostener.

## Esquema y consultas

```sql
-- Outbox de cada tenant (C3): tramo e0..e6
ALTER TABLE outbox
  ADD COLUMN e0_listo       TIMESTAMPTZ,
  ADD COLUMN e1_canonizado  TIMESTAMPTZ,
  ADD COLUMN e2_firmado     TIMESTAMPTZ,
  ADD COLUMN e3_cifrado     TIMESTAMPTZ,
  ADD COLUMN e4_commit      TIMESTAMPTZ,
  ADD COLUMN e5_reclamado   TIMESTAMPTZ,
  ADD COLUMN e6_publicado   TIMESTAMPTZ;

-- Inbox de C4: tramo e7..e10
ALTER TABLE inbox
  ADD COLUMN e7_recibido    TIMESTAMPTZ,
  ADD COLUMN e8_descifrado  TIMESTAMPTZ,
  ADD COLUMN e9_verificado  TIMESTAMPTZ,
  ADD COLUMN e10_persistido TIMESTAMPTZ,   -- después del COMMIT
  ADD COLUMN duplicado      BOOLEAN NOT NULL DEFAULT false;
```

```sql
-- Los tres agregados y las dos etapas que diagnostican.
-- Percentiles sobre el conjunto completo, nunca promediando los de cada contenedor.
SELECT
  date_trunc('minute', o.e0_listo)                                             AS minuto,
  count(*)                                                                     AS eventos,

  percentile_disc(0.99) WITHIN GROUP (ORDER BY o.e6_publicado   - o.e0_listo)     AS p99_c3,
  percentile_disc(0.99) WITHIN GROUP (ORDER BY i.e7_recibido    - o.e6_publicado) AS p99_cola,
  percentile_disc(0.99) WITHIN GROUP (ORDER BY i.e10_persistido - i.e7_recibido)  AS p99_c4,
  percentile_disc(0.99) WITHIN GROUP (ORDER BY i.e10_persistido - o.e0_listo)     AS p99_total,

  -- trabajo vs espera: si p99_total sube y estos no, se llenó
  percentile_disc(0.99) WITHIN GROUP (ORDER BY o.e2_firmado   - o.e1_canonizado)  AS p99_firma,
  percentile_disc(0.99) WITHIN GROUP (ORDER BY o.e5_reclamado - o.e4_commit)      AS p99_espera_outbox

FROM outbox o
JOIN inbox  i USING (payload_hash)      -- la unión que hace posible el extremo a extremo
WHERE NOT i.duplicado
GROUP BY 1 ORDER BY 1;
```

```sql
-- Conciliación
SELECT
  (SELECT count(*) FROM outbox)                              AS emitidos,
  (SELECT count(*) FROM inbox WHERE NOT duplicado)           AS unicos_c4,
  (SELECT count(*) FROM inbox WHERE duplicado)               AS duplicados,
  (SELECT count(*) FROM outbox WHERE status = 'PENDING')     AS en_vuelo,
  (SELECT count(*) FROM outbox WHERE status = 'FAILED')      AS fallidos;
-- emitidos - unicos_c4 - en_vuelo - fallidos  DEBE dar 0
```

```sql
-- Huecos por expediente
SELECT rpf_id, sequence + 1 AS falta
  FROM inbox i
 WHERE NOT duplicado
   AND NOT EXISTS (
     SELECT 1 FROM inbox n
      WHERE n.rpf_id = i.rpf_id AND n.sequence = i.sequence + 1)
   AND sequence < (SELECT max(sequence) FROM inbox m WHERE m.rpf_id = i.rpf_id);
```
