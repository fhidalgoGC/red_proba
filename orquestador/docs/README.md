# Orquestador — documentación del track `O`

El arnés de carga de la PoC. Genera los documentos fiscales, decide a qué
tenant le pega y cuándo, y registra lo que ofreció contra lo que le aceptaron.

**Es andamio.** Existe solo para la prueba y desaparece con ella. Que no se
cite después como parte del diseño del producto.

> **[Diagramas](diagramas.html)** — el mecanismo explicado etapa por etapa, con
> siete diagramas. Es un HTML autocontenido: ábrelo desde el disco, sin servidor
> ni conexión. También publicado en
> [claude.ai](https://claude.ai/code/artifact/caafc080-acc9-4c54-8951-3902e3e1ed1d).


> **Resultados medidos** — la corrida de 39 tenants a 781 ev/s del 2026-09-01,
> con el informe navegable y los datos crudos: [docs/runs/](../../docs/runs/README.md).

---

## Los documentos

| | Qué responde |
|---|---|
| [01 · Cómo funciona](01-como-funciona.md) | Qué hace, en qué orden, y dónde se decide cada cosa |
| [02 · La API](02-api.md) | `POST /batch`, `GET /batch/{id}`, `GET /logs/{id}`, el payload y los errores |
| [03 · El informe](03-informe.md) | La forma del log y cómo leerlo sin equivocarse |
| [04 · Configuración](04-configuracion.md) | `perfil.yaml`, `tenants.yaml`, variables de entorno |
| [05 · Reglas que no se negocian](05-reglas.md) | Las decisiones que si se rompen invalidan la prueba |
| [Diagramas](diagramas.html) | El mecanismo dibujado — abrir en el navegador |

El **diseño** del track vive aparte, en
[../../docs/04-orquestador.md](../../docs/04-orquestador.md). Esto es la
implementación.

> **El orquestador no hashea ni firma nada.** Cero `createHash`, cero HMAC. Lo
> único que hace con `party_id` es mandar un placeholder de 64 ceros con el
> largo correcto, para que C3 escriba su HMAC encima sin mover el tamaño. Los
> dos artefactos del paso ② —`party_id` y `payload_hash`— los produce C3 y se
> explican en
> [../../docs/09-party-id-y-payload-hash.md](../../docs/09-party-id-y-payload-hash.md).

---

## Arranque rápido

```bash
# los dos C3 (cada uno con SU base) y el consumidor C4
cd c3 && npm start          # :3001 tenant-01 → rpf_c3_tenant01
cd c3 && npm run start:2    # :3002 tenant-02 → rpf_c3_tenant02
cd c4 && npm start          # worker · :3003 solo /health → rpf_c4

# el orquestador
cd orquestador && npm start # :3000 · Swagger en /docs
```

El contenedor arranca **vacío y esperando**. Los batches se piden por HTTP:

```bash
curl -X POST localhost:3000/batch -H 'content-type: application/json' -d '{
  "id": "xx01",
  "client": "all",
  "seconds": 20,
  "request": { "client": { "min": 20, "max": 80 } },
  "events":  { "client": { "min": 1,  "max": 10 } }
}'
```

`request` son **peticiones HTTP/s**; `events`, **cuántos documentos lleva cada
una**. `eventos/s = peticiones/s × documentos por petición`. Sin `events`, el
tamaño es fijo (1 por defecto) y las corridas viejas dan lo mismo.
```

Devuelve **202 al momento**. El resultado se consulta aparte:

```bash
curl localhost:3000/batch/xx01
```

---

## En una frase

Planifica toda la corrida por delante —cuántos eventos por segundo, en qué
instante y con qué documento—, materializa los cuerpos con cinco segundos de
ventaja, y un único reloj de 10 ms dispara lo que va venciendo **sin esperar
nunca una respuesta**.
