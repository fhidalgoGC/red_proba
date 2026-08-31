# 04 — Configuración

Dos archivos y unas pocas variables de entorno. Lo que llega por `POST /batch`
**sobreescribe** el perfil para esa corrida, pero pasa por los mismos
validadores.

---

## `config/tenants.yaml` — el registro de destinos

```yaml
tenants:
  - id: tenant-01
    url: http://localhost:3001
  - id: tenant-02
    url: http://localhost:3002
```

**Lo genera Terraform** con el mismo `for_each` que crea los tenants, para que
no se desincronice del inventario real. Los dos de ahí son el ejemplo de
desarrollo local.

`peso` es opcional y es **todo o nada**: si algún tenant lo declara, todos
deben, y entonces manda el peso explícito sobre `reparto`.

Un `id` duplicado se rechaza al arrancar: partiría el reparto y la
conciliación de P4 en dos.

---

## `config/perfil.yaml` — el perfil por defecto

```yaml
modo: smoke        # smoke | carga

smoke:
  eventos_totales: 2500
  llamadas_por_tenant: [10, 15]
  duracion_objetivo: 60s

carga:
  fases:
    - { nombre: warmup,   duracion: 15m, ritmo: 1200 }
    - { nombre: objetivo, duracion: 45m, ritmo: 2000 }
    # …

reparto:
  tipo: zipf         # zipf | uniforme
  exponente: 1.0

llegadas:
  tipo: poisson      # poisson | uniforme
  tick_ms: 10

peticiones:
  client: { min: 20, max: 80 }   # PETICIONES/s por cliente; = request.client del POST

eventos:
  client: [1, 10]                # documentos dentro de cada peticion; = events.client

pool:
  plantillas: 1000
  semilla: 20260830
  tamano_bytes: [2048, 4096]
  items_por_documento: [1, 5]
  eventos_por_hilo: 1
  tasa_verificacion: 0.01

envio:
  ruta: /events
  prueba_id: corrida-local
  eventos_por_request: 1        # tamaño FIJO; el atajo de eventos.client: [N, N]
  espera_maxima_lote_ms: 200    # ⚠ OBSOLETA: ya no hay buffer que esperar
  concurrencia_por_tenant: 0     # 0 = SIN TOPE
  timeout_ms: 5000
  conexiones_por_destino: 256
  reintentos: 0
```

La validación es estricta y explota al arrancar. Un orquestador que arranca con
un perfil a medias produce una corrida cuyos números no se pueden defender, y
eso es peor que no arrancar.

### Las perillas que importan

| | Efecto |
|---|---|
| `llegadas.tick_ms` | Resolución del reloj. Más fino = más puntería, más CPU. A 10 ms el coste medido es 0,23 µs por tick |
| `pool.eventos_por_hilo` | Cuántos eventos comparten `rpf_id` = `MessageGroupId`. Con 1, paralelismo máximo; con 50, orden estricto y te acercas al techo de 300 msg/s. **Es la perilla que ejercita D-06** |
| `pool.tamano_bytes` | Rango del tamaño canónico. **Piso duro 2.032, techo 4.096** — ver [01-como-funciona](01-como-funciona.md) |
| `pool.tasa_verificacion` | Fracción de eventos a los que se comprueba el tamaño. 1.0 es correcto pero caro; 0 solo verifica al construir el pool |
| `envio.eventos_por_request` | Tamaño **fijo** del lote. Es el atajo de `eventos.client: [N, N]`; si pones `eventos.client`, este se ignora |
| `envio.conexiones_por_destino` | **Techo duro de ritmo**: `conexiones / latencia` req/s |
| `envio.concurrencia_por_tenant` | **0 = sin tope, y es lo correcto.** Ver [05-reglas](05-reglas.md) |
| `envio.reintentos` | Debe ser 0: un reintento cuenta el mismo evento dos veces como carga ofrecida |

---

## Variables de entorno

| | Por defecto | Qué hace |
|---|---|---|
| `ORQ_PORT` | 3000 | Puerto. **No es `PORT`**: C3 usa esa para levantar N instancias, y una variable compartida haría que exportarla moviera los dos |
| `ORQ_CONFIG_DIR` | `./config` | De dónde leer los YAML |
| `ORQ_LOGS_DIR` | `../logs` | Dónde escribir los informes |
| `ORQ_TENANTS_JSON` | — | La lista de destinos, con **la misma forma que `tenants.yaml`**. Reemplaza al archivo |
| `ORQ_PERFIL_JSON` | — | El perfil, con la misma forma que `perfil.yaml`. Reemplaza al archivo |

Las dos son **independientes**: se puede inyectar la lista de destinos y dejar
que el perfil siga viniendo del YAML. Es exactamente lo que hace Terraform —los
hosts de Cloud Map no se pueden hornear en la imagen, y el perfil sí debe
poderse cambiar sin un `apply`— y lo que pasa en la task definition de
`modules/orq`.

Lo inyectado pasa por **los mismos validadores** que el archivo. Un camino de
código distinto para la configuración de la corrida de verdad sería un camino
sin probar.

> ⚠ Antes las dos colgaban de `ORQ_PERFIL_JSON`: sin él, `ORQ_TENANTS_JSON` se
> **ignoraba en silencio** y el orquestador le pegaba a los `localhost:3001` del
> ejemplo de desarrollo. En la VPC eso es un `ECONNREFUSED` por evento y una
> corrida entera de ceros.

En C3:

| | Por defecto | Qué hace |
|---|---|---|
| `C3_PORT` | 3001 | Puerto (tiene prioridad sobre `PORT`) |
| `TENANT_ID` | `puerto-<PORT>` | Nombra el log y sale en `/health` |
| `C3_LOGS_DIR` | `./logs` | Dónde escribir |
| `C3_DELAY_MS` | — | Retardo simulado. Fijo (`800`) o rango (`100-1500`) |

---

## Los comandos

```bash
npm start          # compila y arranca en :3000
npm test           # JCS con vectores fijos + invariante de tamaño + reparto
npm run volcar     # vuelca las 1.000 plantillas a salida/plantillas/
npm run typecheck
```

`npm start` compila antes de arrancar (`prestart`), para que no corras código
viejo sin darte cuenta.

---

## Constantes del código

No son configurables, pero conviene conocerlas.

| Constante | Valor | Dónde | Por qué |
|---|---|---|---|
| `VENTANA_MATERIALIZACION` | 5 s | planificador | Cuerpos por delante. Colchón suficiente sin disparar la memoria |
| `HORIZONTE_PLAN` | 60 s | planificador | Plan por delante. Barato: son índices |
| `MUESTRAS_LATENCIA` | 250 | métricas | Por segundo y tenant. A 2.000 ev/s entre 50 son ~40 |
| `SEGUNDOS_MAXIMOS` | 14.400 | métricas | 4 h de detalle por segundo. Al pasarlo aparece `seconds_truncated` |
| `ASIENTO_MS` | 2.000 | registro | Espera mínima tras el fin antes de cerrar |
| `TOPE_CONEXIONES` | 2.048 | corrida | Sockets por destino, para que un `concurrency` enorme no los agote |
| `RESERVA_RELLENO` | 8 B | payload | Para que `sequence` pueda crecer a nueve dígitos |
