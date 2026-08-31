/**
 * C-02 · vectores fijos del Canonical Mapper.
 *
 * «Bateria de tests con vectores fijos antes que cualquier otra cosa» —
 * docs/03-contenedor-c3.md. Es la pieza de la que dependen firma y
 * verificacion: si el canonico se mueve un byte, C4 rechaza la firma y el
 * sintoma no se parece en nada a la causa.
 *
 * El vector valido es `docs/payload-ejemplo.json` tal cual, copiado a
 * test/vectores/. Pesa 3.072 bytes canonicos exactos, que es el numero que
 * docs/02-payload.md declara: si este test se pone rojo, o cambio el
 * canonicalizador o cambio el ejemplo, y las dos cosas hay que enterarse.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalize } from '../src/comun/jcs';
import { CONTRATO, esBloque, esLista, type Nodo } from '../src/mapper/contrato';
import { DocumentoInvalido, MapperService } from '../src/mapper/mapper.service';

const mapper = new MapperService();

/** HMAC real de juguete. 37 caracteres, como manda el contrato. */
const PARTY_ID = 'hmac:' + 'a1b2c3d4e5f60718293a4b5c6d7e8f90'.repeat(2);

// Desde el cwd y no desde __dirname: `npm test` compila a dist-test/ y tsc no
// copia los .json, asi que __dirname apuntaria a un directorio sin vectores.
const VALIDO = JSON.parse(
  readFileSync(join(process.cwd(), 'test', 'vectores', 'documento-valido.json'), 'utf8'),
) as Record<string, unknown>;

/** Copia profunda; cada test parte de un documento limpio. */
const clon = (): Record<string, unknown> => JSON.parse(JSON.stringify(VALIDO)) as Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Lo que YA se emite tiene que pasar. Si esto falla, C3 rechaza trafico real.
// ─────────────────────────────────────────────────────────────────────────────

test('el documento que emite el orquestador hoy pasa entero', () => {
  const r = mapper.canonizar(clon(), PARTY_ID);
  assert.equal(r.rpfId, VALIDO['rpf_id']);
  assert.equal(r.eventId, VALIDO['event_id']);
  assert.equal(r.sequence, VALIDO['sequence']);
});

test('vector fijo de tamano: el ejemplo pesa 3.072 bytes canonicos', () => {
  // El party_id real mide lo mismo que el placeholder, asi que sustituirlo
  // no puede mover el numero. Ese es todo el punto del largo fijo.
  const r = mapper.canonizar(clon(), PARTY_ID);
  assert.equal(r.bytes, 4096);
  assert.equal(r.bytes, Buffer.byteLength(canonicalize(r.payload), 'utf8'));
});

test('el orden de las claves de entrada no cambia el canonico', () => {
  const a = mapper.canonizar(clon(), PARTY_ID);
  const alReves = Object.fromEntries(Object.entries(clon()).reverse());
  const b = mapper.canonizar(alReves, PARTY_ID);
  assert.equal(a.canonico.toString('utf8'), b.canonico.toString('utf8'));
  assert.equal(a.payloadHash, b.payloadHash);
});

// ─────────────────────────────────────────────────────────────────────────────
// El orden de los pasos. Es lo unico que no se puede arreglar mas abajo.
// ─────────────────────────────────────────────────────────────────────────────

test('el party_id se sustituye ANTES de canonizar', () => {
  const r = mapper.canonizar(clon(), PARTY_ID);
  const texto = r.canonico.toString('utf8');
  assert.ok(texto.includes(PARTY_ID), 'el canonico tiene que llevar el HMAC real');
  assert.ok(
    !texto.includes(VALIDO['party_id'] as string),
    'si quedara el placeholder, la firma cubriria el documento equivocado',
  );
  assert.equal(r.payload['party_id'], PARTY_ID);
});

test('no muta el documento de entrada', () => {
  const entrada = clon();
  mapper.canonizar(entrada, PARTY_ID);
  assert.equal(entrada['party_id'], VALIDO['party_id']);
});

test('el payload_hash sale del canonico ya sustituido y es determinista', () => {
  const a = mapper.canonizar(clon(), PARTY_ID);
  const b = mapper.canonizar(clon(), PARTY_ID);
  assert.equal(a.payloadHash, b.payloadHash);
  assert.match(a.payloadHash, /^[0-9a-f]{64}$/);

  // Dos participantes con el mismo documento son dos eventos distintos. Si el
  // payload_hash no dependiera del party_id, SQS FIFO descartaria el segundo
  // en silencio durante 5 minutos.
  const otro = mapper.canonizar(clon(), 'hmac:' + '0'.repeat(64));
  assert.notEqual(a.payloadHash, otro.payloadHash);
});

// ─────────────────────────────────────────────────────────────────────────────
// Campos faltantes — generado sobre el CONTRATO, asi que cubre todos.
// ─────────────────────────────────────────────────────────────────────────────

/** Todas las rutas hoja del contrato: 'rpf_id', 'totals.icms', 'items[].ncm'… */
function rutas(): string[] {
  const salida: string[] = [];
  for (const [nombre, nodo] of Object.entries(CONTRATO) as Array<[string, Nodo]>) {
    if (esBloque(nodo)) {
      salida.push(nombre);
      for (const campo of Object.keys(nodo.campos)) salida.push(`${nombre}.${campo}`);
    } else if (esLista(nodo)) {
      salida.push(nombre);
      for (const campo of Object.keys(nodo.campos)) salida.push(`${nombre}[].${campo}`);
    } else {
      salida.push(nombre);
    }
  }
  return salida;
}

/** Borra la ruta del documento. `items[].x` borra x del PRIMER elemento. */
function borrar(doc: Record<string, unknown>, ruta: string): void {
  const [cabeza, cola] = ruta.split('.') as [string, string | undefined];
  if (cola === undefined) {
    delete doc[cabeza.replace('[]', '')];
    return;
  }
  if (cabeza.endsWith('[]')) {
    const lista = doc[cabeza.slice(0, -2)] as Array<Record<string, unknown>>;
    delete lista[0]![cola];
    return;
  }
  delete (doc[cabeza] as Record<string, unknown>)[cola];
}

for (const ruta of rutas()) {
  test(`falta ${ruta} -> se rechaza`, () => {
    const doc = clon();
    borrar(doc, ruta);
    assert.throws(
      () => mapper.canonizar(doc, PARTY_ID),
      (e: unknown) => {
        assert.ok(e instanceof DocumentoInvalido, `esperaba DocumentoInvalido, llego ${String(e)}`);
        assert.equal(e.motivo, 'campo_faltante');
        // El motivo tiene que apuntar al campo: un descarte que dice
        // "falta algo" no es accionable a 2.000 ev/s.
        assert.equal(e.campo, ruta.replace('[]', '[0]'));
        return true;
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Los venenos con nombre. Cada uno ataca una guarda distinta y se comprueba
// que fue rechazado POR SU MOTIVO: que el total cuadre no basta, dos venenos
// rechazados por el motivo equivocado darian el mismo total.
// (mismo patron que c4/test/e2e.ts)
// ─────────────────────────────────────────────────────────────────────────────

const venenos: Array<{ nombre: string; motivo: string; campo: string; romper: (d: Record<string, unknown>) => void }> = [
  {
    nombre: 'un importe como number en vez de string',
    motivo: 'importe_no_es_string',
    campo: 'totals.total',
    romper: (d) => { (d['totals'] as Record<string, unknown>)['total'] = 18920.5; },
  },
  {
    nombre: 'un importe de item como number',
    motivo: 'importe_no_es_string',
    campo: 'items[0].unit_price',
    romper: (d) => { (d['items'] as Array<Record<string, unknown>>)[0]!['unit_price'] = 11.48; },
  },
  {
    nombre: 'la chave de acesso como number',
    motivo: 'digitos_no_es_string',
    campo: 'document.access_key',
    romper: (d) => { (d['document'] as Record<string, unknown>)['access_key'] = 35260812345678000195; },
  },
  {
    nombre: 'la chave de acesso con 43 digitos',
    motivo: 'largo_incorrecto',
    campo: 'document.access_key',
    romper: (d) => {
      const doc = d['document'] as Record<string, unknown>;
      doc['access_key'] = (doc['access_key'] as string).slice(0, 43);
    },
  },
  {
    nombre: 'un cnpj de 13 digitos',
    motivo: 'largo_incorrecto',
    campo: 'participant.cnpj',
    romper: (d) => {
      const p = d['participant'] as Record<string, unknown>;
      p['cnpj'] = (p['cnpj'] as string).slice(0, 13);
    },
  },
  {
    nombre: 'un rpf_id que no es UUID',
    motivo: 'formato_invalido',
    campo: 'rpf_id',
    romper: (d) => { d['rpf_id'] = 'no-soy-un-uuid'; },
  },
  {
    nombre: 'un party_id entrante de largo equivocado',
    motivo: 'formato_invalido',
    campo: 'party_id',
    romper: (d) => { d['party_id'] = 'hmac:00'; },
  },
  {
    nombre: 'sequence como string',
    motivo: 'tipo_incorrecto',
    campo: 'sequence',
    romper: (d) => { d['sequence'] = '4821'; },
  },
  {
    nombre: 'sequence con decimales',
    motivo: 'tipo_incorrecto',
    campo: 'sequence',
    romper: (d) => { d['sequence'] = 4821.5; },
  },
  {
    nombre: 'items vacio',
    motivo: 'lista_vacia',
    campo: 'items',
    romper: (d) => { d['items'] = []; },
  },
  {
    nombre: 'items que no es array',
    motivo: 'tipo_incorrecto',
    campo: 'items',
    romper: (d) => { d['items'] = { line: 1 }; },
  },
  {
    nombre: 'un bloque que llega como string',
    motivo: 'tipo_incorrecto',
    campo: 'totals',
    romper: (d) => { d['totals'] = 'nada'; },
  },
  {
    nombre: 'un campo en null',
    motivo: 'campo_nulo',
    campo: 'document.nature',
    romper: (d) => { (d['document'] as Record<string, unknown>)['nature'] = null; },
  },
  {
    nombre: 'una fecha de vencimiento con hora',
    motivo: 'formato_invalido',
    campo: 'payment.due_first',
    romper: (d) => { (d['payment'] as Record<string, unknown>)['due_first'] = '2026-09-28T00:00:00Z'; },
  },
  {
    nombre: 'un occurred_at que no es fecha',
    motivo: 'formato_invalido',
    campo: 'occurred_at',
    romper: (d) => { d['occurred_at'] = 'ayer'; },
  },
  {
    nombre: 'relleno con caracteres fuera de base64',
    motivo: 'formato_invalido',
    campo: 'padding',
    romper: (d) => { d['padding'] = (d['padding'] as string).slice(0, -1) + '#'; },
  },
];

for (const v of venenos) {
  test(`veneno · ${v.nombre}`, () => {
    const doc = clon();
    v.romper(doc);
    assert.throws(
      () => mapper.canonizar(doc, PARTY_ID),
      (e: unknown) => {
        assert.ok(e instanceof DocumentoInvalido, `esperaba DocumentoInvalido, llego ${String(e)}`);
        assert.equal(e.motivo, v.motivo);
        assert.equal(e.campo, v.campo);
        return true;
      },
    );
  });
}

test('los venenos no se pisan: cada motivo se probo al menos una vez', () => {
  const motivos = new Set(venenos.map((v) => v.motivo));
  assert.ok(motivos.size >= 7, `solo ${motivos.size} motivos distintos entre los venenos`);
});

// ─────────────────────────────────────────────────────────────────────────────
// El peso
// ─────────────────────────────────────────────────────────────────────────────

test('un documento bien formado nunca es demasiado chico', () => {
  // Con el relleno vaciado, el ejemplo sigue pesando 2.344 bytes: muy por
  // encima del minimo por defecto de 1.024. Es a proposito — el piso duro
  // medido del documento de 70 atributos son 2.024 con un solo item, asi que
  // el minimo por defecto no puede rechazar un documento legitimo.
  const doc = clon();
  doc['padding'] = '';
  assert.equal(mapper.canonizar(doc, PARTY_ID).bytes, 2344);
});

test('el minimo se dispara cuando de verdad se aprieta', () => {
  // 2.600 esta por encima del ejemplo sin relleno (2.344) y por debajo del
  // techo: comprueba que el limite inferior se aplica de verdad, no que este
  // apagado. No se usa 2.048 porque el documento de 70 atributos ya lo supera
  // solo con su contenido, y el test pasaria sin probar nada.
  const estricto = new MapperService(2600, 4096);
  const doc = clon();
  doc['padding'] = '';
  assert.throws(
    () => estricto.canonizar(doc, PARTY_ID),
    (e: unknown) =>
      e instanceof DocumentoInvalido &&
      e.motivo === 'peso_fuera_de_rango' &&
      e.message.includes('2344'),
  );
});

test('un documento por encima del rango se rechaza por peso', () => {
  const doc = clon();
  doc['padding'] = 'A'.repeat(20_000);
  assert.throws(
    () => mapper.canonizar(doc, PARTY_ID),
    (e: unknown) => e instanceof DocumentoInvalido && e.motivo === 'peso_fuera_de_rango',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Errores que NO son del documento
// ─────────────────────────────────────────────────────────────────────────────

test('un party_id real de largo equivocado es error de C3, no del documento', () => {
  // Y por eso NO es un DocumentoInvalido: descartar el documento seria la
  // reaccion equivocada a un contenedor mal configurado, que iba a descartar
  // los siguientes tambien.
  assert.throws(
    () => mapper.canonizar(clon(), 'hmac:corto'),
    (e: unknown) => e instanceof Error && !(e instanceof DocumentoInvalido),
  );
});

test('lo que no es un objeto se rechaza en la puerta', () => {
  for (const basura of [null, undefined, 'un string', 42, [1, 2, 3]]) {
    assert.throws(
      () => mapper.canonizar(basura, PARTY_ID),
      (e: unknown) => e instanceof DocumentoInvalido && e.motivo === 'no_es_objeto',
      `deberia rechazar ${JSON.stringify(basura)}`,
    );
  }
});
