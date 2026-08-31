# 04 — Orquestador de carga

> **⚠ CAMBIO DE DISEÑO — el generador se mudó acá.**
>
> Este documento describía un orquestador que llamaba a cada tenant con un
> número y **C3 generaba** los payloads. Ya no: **el orquestador construye los
> documentos** y se los manda hechos. El cuerpo del request pasó de
> `{ n: 40 }` a `{ documentos: [...] }`.
>
> Además, las plantillas ya **no pesan todas 3.072 bytes**: se sortean en un
> rango (`[1536, 3072]` por defecto). Ver [02-payload](02-payload.md).
>
> Lo que sigue vigente sin cambios: O-01 a O-07, el perfil de fases, Zipf,
> Poisson y el lazo abierto. Lo que cambió está detallado en
> [../orquestador/README.md](../orquestador/README.md).

Contenedor Fargate en su propia VPC. **Genera los documentos** y decide
cuántos le manda a quién y cuándo. Es lo que convierte 50 sistemas
independientes en una prueba de carga con forma.

**Es andamio**: existe solo para la prueba y desaparece con ella. Que no se
cite después como parte del diseño del producto.

## Los números

| | |
|---|---|
| Objetivo | 2.000 eventos/s en total |
| Por tenant (si fuera parejo) | 40 eventos/s |
| Llamadas HTTP del orquestador | **50 req/s** con `eventos_por_request: 40` |
| Firmas KMS que provoca | **2.000/s** |
| Bytes que empuja | ~4,5 MB/s (2.000 × ~2,3 KB) |

La asimetría era el punto: 50 peticiones por segundo, cada una pidiendo ~40
eventos. **Con el generador acá esa asimetría ya no es gratis**: el cuerpo del
request pasó de 10 bytes a ~2,3 KB por evento, y a 2.000 ev/s son ~4,5 MB/s
saliendo de un solo contenedor.

La defensa es doble: `eventos_por_request` (subirlo amortiza el overhead por
request) y el contador **`descartados_retraso`**, que acusa explícitamente al
arnés. Si ese número no es ~0, la corrida no está midiendo C3: está midiendo
el orquestador, y hay que subirle recursos o bajar el ritmo antes de creerle
a nada.

## Perfil de carga

```
2.500 ┤
2.300 ┤              ╭──╮              ╭───╮
2.000 ┤        ╭─────╯  ╰╮             │   │
1.500 ┤        │         ╰────╮        │   │
1.200 ┤  ╭─────╯              │        │   ╰────
1.000 ┼──┼───────────────────────────────────────  ← límite KMS por defecto
  900 ┤  │                    ╰────╮   │
    0 ┤──╯                         ╰───╯
      └──────────────────────────────────────────
```

**Toda la curva vive por encima del límite por defecto de KMS.** Incluso el
valle de 900 no deja margen para reintentos. Sin el aumento de cuota, la prueba
mide throttling en vez de arquitectura.

La forma importa tanto como el número: una carga plana de 2.000 no simula nada.
Los sistemas reales fallan en las **transiciones** — cuando el tráfico sube
rápido, cuando cae y los pools se encogen, cuando vuelve a subir. Los valles son
parte de la prueba, no tiempo perdido.

## Tareas

### O-00 · Generación de payloads  ⚠ NUEVO

El orquestador construye los documentos, sortea su tamaño dentro del rango
configurado y decide `rpf_id` y `sequence` — es decir, decide cómo se agrupan
los eventos en `MessageGroupId` y por lo tanto si la prueba llega al techo de
300 msg/s por grupo (D-06).

Las plantillas se **pre-generan al arrancar** (1.000 por defecto, desde una
semilla) porque generar en caliente a 2.000/s haría del orquestador el cuello
de botella. Pero **cada envío refresca `event_id`, `rpf_id`, `sequence` y
`occurred_at`**: reusar una plantilla tal cual produciría el mismo
`MessageDeduplicationId` y SQS FIFO descartaría el duplicado en silencio.

### O-01 · Perfil como archivo, no como código

Fases con duración y ritmo objetivo en YAML, leído al arrancar. Cambiar la forma
de la prueba no debe requerir compilar ni desplegar.

```yaml
fases:
  - { nombre: warmup,   duracion: 15m, ritmo:  1200 }
  - { nombre: base,     duracion: 60m, ritmo:  1200 }
  - { nombre: objetivo, duracion: 45m, ritmo:  2000 }
  - { nombre: pico,     duracion: 15m, ritmo:  2300 }
  - { nombre: descenso, duracion: 25m, ritmo:  1500 }
  - { nombre: valle,    duracion: 20m, ritmo:   900 }
  - { nombre: pico2,    duracion: 18m, ritmo:  2300 }
  - { nombre: cierre,   duracion: 30m, ritmo:  1200 }
```

### O-02 · Lazo abierto, no lazo cerrado  ⚠ CRÍTICO

Dispara **según el reloj**, no según las respuestas.

> Si esperara a que el tenant conteste para mandar lo siguiente, un sistema
> lento recibiría menos carga — y medirías un sistema que se ve sano porque
> nadie lo está presionando. Se llama **omisión coordinada** y es la forma más
> común de que una prueba de carga mienta.

Si el objetivo son 40 eventos/s para el tenant 07, se mandan los 40 aunque el
anterior siga pendiente.

### O-03 · Reparto Zipf entre tenants

Repartir 2.000 entre 50 a 40 cada uno es lo que **nunca** pasa en producción. El
tráfico multi-tenant real sigue una ley de potencias: unos pocos clientes
generan la mayoría del volumen.

Con Zipf (exponente 1,0) y 50 tenants, el más grande se lleva el 22,2% del
total — a 2.000 ev/s son ~445 eventos/s — y la cola larga ~9.
Eso ejercita cosas que el reparto uniforme esconde — en particular el techo de
300 mensajes/s por `MessageGroupId`.

### O-04 · Llegadas de Poisson

40 eventos/s repartidos exactamente cada 25 ms es tráfico de laboratorio. El
real llega en ráfagas: **intervalos exponenciales** con la misma media producen
ráfagas y huecos, y son las ráfagas las que llenan el outbox y disparan el
throttling.

Misma media, distribución distinta, resultados muy distintos.

### O-05 · Cliente HTTP con pool y timeouts explícitos

50 destinos, conexiones reutilizadas, timeout corto. Sin timeout, un tenant
colgado bloquea el hilo del planificador y deforma la carga ofrecida al resto.

### O-06 · Registro de ofrecido contra aceptado  ⚠ CRÍTICO

Anotar cuántos eventos **intentó** pedir por segundo y cuántos le confirmaron.

**La diferencia entre carga ofrecida y carga aceptada es el resultado principal
de la prueba.** Sin ese registro solo sabes lo que el sistema logró, no dónde
empezó a no dar abasto.

### O-07 · Endpoint `/status`

Las dos series anteriores, expuestas en vivo. Es el 80% de la señal de
saturación sin necesidad de métricas en AWS.

## Red

VPC peering hacia C3 (ver ORQ-06 en [01-arquitectura](01-arquitectura.md)). La
zona privada de Cloud Map se asocia también a la VPC del orquestador para que
resuelva `api-NN.poc.local`.

**El orquestador no se conecta a C4 en absoluto.** Si necesita verificar lo que
llegó, que lo haga leyendo métricas, no la cola.

### O-08 · Manifiesto de expedientes  ⚠ NUEVO

Al cerrar la corrida, `logs/<prueba>__manifiesto.json`: por cada `rpf_id`, los
rangos de `sequence` que salieron, en cuatro estados (`aceptados`,
`rechazados`, `fallidos`, `no_emitidos`).

Es la mitad «salió» de P4. Sin ella, C4 no puede distinguir «el expediente
terminó ahí» de «se perdió la cola» — ver
[07-medicion](07-medicion.md#-contar-desde-c4-solo-no-basta).

**Se anota donde el evento sale por el cable**, en `EmisorService`, y no en el
planificador. Las secuencias se asignan al planificar, con segundos de
antelación: anotarlas ahí contaría como emitido lo que solo estaba previsto.

**El tope es explícito.** `ORQ_MANIFIESTO_TOPE` (200.000 expedientes por
defecto). Al alcanzarlo se dejan de admitir expedientes nuevos y el manifiesto
sale con `truncado: true`, y un manifiesto truncado nunca produce un veredicto
`ok`: conciliar contra datos a medias y declarar «cero pérdidas» es peor que no
conciliar.

**Se vuelca al cerrar el informe, no al parar el planificador**: es el único
instante en que cada evento emitido ya tiene su resolución. Antes, respuestas
que sí llegaron figurarían como `en_vuelo`.

### O-09 · Conciliación

```bash
npm run conciliar -- logs/<prueba>__manifiesto.json ../c4/logs/<prueba>__inbox.json
```

Resta rango a rango y clasifica cada ausencia por culpable: `perdida` (aceptado
y ausente en C4), `sin_confirmar` (salió y nadie contestó), `arnes` (nunca
salió). Por forma: hueco interior, cabeza, cola o expediente entero. Sale con
código 1 si hay pérdida, para poder encadenarlo en un script de corrida.

Es código puro sobre dos archivos JSON: no levanta Nest, no toca la base y
corre meses después contra los artefactos de una corrida vieja.
