# 02 · El contrato de atributos

`src/mapper/contrato.ts` declara **todos los atributos que C3 exige**, con su
tipo y su regla. Es a la vez el validador y la documentación: no hay dos
fuentes que se puedan desincronizar.

Coincide campo por campo con lo que el generador del orquestador emite hoy, así
que **no rechaza tráfico real** — verificado con 4.269 eventos de una corrida,
cero descartes. Eso es a propósito: se quiere que el camino de fallo exista y
esté probado, no que se dispare en la primera corrida.

---

## Los 16 campos de primer nivel

```
rpf_id          uuid      identificador del expediente → MessageGroupId
event_id        uuid
event_type      texto
schema_version  texto
occurred_at     iso8601
sequence        entero    orden dentro del rpf_id → C4 detecta huecos
party_id        hmac      'hmac:' + 64 hex, 69 caracteres exactos
participant     {}        cnpj · ie · legal_name · municipality_code · uf
counterparty    {}        cnpj · ie · legal_name · uf
document        {}        model · series · number · access_key · issued_at · …
totals          {}        items_count + nueve importes
items           []        line · code · description · ncm · unit · quantity · …
transport       {}        mode · carrier_cnpj · vehicle_plate · gross_weight
payment         {}        method · installments · due_first
origin          {}        system · version · environment
padding         relleno    ajuste de tamaño; solo importa su largo
```

---

## La regla que justifica el módulo entero

> **Los importes son `string`, nunca `number`.**

JCS serializa los números con `Number::toString` de ECMAScript. Un importe que
llegue como `1234.5` en vez de `"1234.50"`:

- se canoniza como `1234.5`,
- se firma perfectamente,
- **verifica perfectamente**.

O sea que **no lo atrapa nadie más abajo**. Rompe el día que ese mismo importe
pase por un lenguaje con otro formato de doble: el canónico cambia y la firma
deja de verificar, meses después, sin nada que apunte a la causa.

Es la regla 1 de `CLAUDE.md` y es la única que puede romper la PoC en silencio.

Lo mismo con la `access_key` de 44 dígitos: como número perdería precisión
—supera los 2⁵³ de un doble— y se le comerían los ceros de la izquierda.

---

## Los tipos que sabe validar

| Tipo | Qué acepta |
|---|---|
| `uuid` | UUID en cualquier versión |
| `texto` | texto no vacío |
| `entero` | **el único sitio donde se acepta un `number`** |
| `decimal` | importe o cantidad, **siempre como string**: `"18920.50"` |
| `digitos` | solo dígitos, como string; `largo` fija cuántos |
| `iso8601` | marca de tiempo parseable |
| `fecha` | `YYYY-MM-DD`, sin hora |
| `party_id` | `hmac:` + 64 hex, largo fijo 69 |
| `relleno` | alfabeto base64; puede ser vacío |

---

## Los motivos de descarte

Cada rechazo trae **motivo, campo y detalle**. Un descarte que dice «falta
algo» no es accionable a 2.000 ev/s.

| Motivo | Cuándo |
|---|---|
| `campo_faltante` | no viene |
| `campo_nulo` | llegó `null` — se distingue de faltante porque la causa es otra: suele ser una columna vacía en la base del emisor |
| `tipo_incorrecto` | un objeto donde iba un array, un string donde iba un entero… |
| `importe_no_es_string` | ⚠ el que importa |
| `digitos_no_es_string` | la `access_key` o un CNPJ como número |
| `formato_invalido` | no es UUID, no es fecha, no es `hmac:`+64 hex |
| `largo_incorrecto` | 43 dígitos donde el contrato fija 44 |
| `campo_vacio` | texto vacío |
| `lista_vacia` | `items: []` — un documento fiscal sin líneas no existe |
| `peso_fuera_de_rango` | el canónico se sale de `[C3_BYTES_MIN, C3_BYTES_MAX]` |
| `excede_sqs` | más de 180 KB canónicos: no se podría publicar |
| `no_es_objeto` | llegó un string, un número, un array |

---

## Lo que NO valida, a propósito

**Reglas de negocio.** Que `totals.total` cuadre con la suma de los ítems es
problema del emisor, no de C3. C3 es un notario: certifica que el documento
tiene la forma acordada y lo firma tal como vino.

---

## Un error de configuración no es un descarte

Si el `party_id` que C3 tiene configurado mide un largo distinto de 69, **no se
descarta el documento**: se lanza un error que tumba el lote.

Descartar sería la reacción equivocada — el siguiente documento fallaría igual,
y el siguiente. Es un contenedor mal configurado, no un emisor que manda basura.

---

## Los tests

95 vectores fijos, y dos clases:

**Uno por cada campo del contrato**, generado recorriendo el propio contrato.
Si mañana se añade un campo, su test de «falta» aparece solo.

**16 venenos con nombre**, cada uno rechazado **por su motivo propio**. Que el
total de descartes cuadre no basta: dos venenos rechazados por el motivo
equivocado darían el mismo total. Es el patrón que ya usaba `c4/test/e2e.ts`.
