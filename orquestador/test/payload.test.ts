import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { bytesCanonicos } from '../src/generador/jcs';
import {
  BYTES_MAXIMO,
  BYTES_MINIMO_VIABLE,
  RESERVA_RELLENO,
  construirPlantilla,
  prng,
} from '../src/generador/payload';

const RANGO: [number, number] = [1536, 3072];
const ITEMS: [number, number] = [1, 5];

test('cada plantilla pesa EXACTAMENTE su tamaño objetivo', () => {
  const r = prng(20260830);
  for (let i = 0; i < 2000; i++) {
    const p = construirPlantilla(i, r, { tamanoBytes: RANGO, itemsPorDocumento: ITEMS });
    assert.equal(
      bytesCanonicos(p.doc), p.bytes,
      `plantilla ${i}: midio ${bytesCanonicos(p.doc)} y declara ${p.bytes}`,
    );
  }
});

test('los tamaños caen dentro del rango pedido y lo cubren', () => {
  const r = prng(1);
  const vistos: number[] = [];
  for (let i = 0; i < 2000; i++) {
    vistos.push(construirPlantilla(i, r, { tamanoBytes: RANGO, itemsPorDocumento: ITEMS }).bytes);
  }
  assert.ok(Math.min(...vistos) >= RANGO[0]);
  assert.ok(Math.max(...vistos) <= RANGO[1]);
  // Que sean variados de verdad, no todos iguales: si esto falla, el sorteo
  // esta roto y la prueba mediria un tamaño unico creyendo que mide varios.
  assert.ok(new Set(vistos).size > 500, `solo ${new Set(vistos).size} tamaños distintos`);
});

test('siempre queda relleno de reserva para que crezca sequence', () => {
  const r = prng(7);
  for (let i = 0; i < 500; i++) {
    const p = construirPlantilla(i, r, { tamanoBytes: RANGO, itemsPorDocumento: ITEMS });
    assert.ok(
      p.doc.padding.length >= RESERVA_RELLENO,
      `plantilla ${i}: relleno de ${p.doc.padding.length}, se reservan ${RESERVA_RELLENO}`,
    );
  }
});

test('un target por debajo del piso del documento falla ruidoso', () => {
  const r = prng(1);
  assert.throws(
    () => construirPlantilla(0, r, { tamanoBytes: [900, 900], itemsPorDocumento: [1, 1] }),
    /objetivo/,
  );
});

test('tamaño fijo sigue siendo expresable', () => {
  const r = prng(3);
  for (let i = 0; i < 200; i++) {
    const p = construirPlantilla(i, r, {
      tamanoBytes: [BYTES_MAXIMO, BYTES_MAXIMO],
      itemsPorDocumento: [2, 2],
    });
    assert.equal(p.bytes, BYTES_MAXIMO);
    assert.equal(bytesCanonicos(p.doc), BYTES_MAXIMO);
  }
});

test('todo importe es string y la access_key tambien', () => {
  const r = prng(11);
  const { doc } = construirPlantilla(0, r, { tamanoBytes: RANGO, itemsPorDocumento: [3, 3] });

  const totals = doc.totals as Record<string, unknown>;
  for (const [k, v] of Object.entries(totals)) {
    if (k === 'items_count') continue;   // el unico numero legitimo
    assert.equal(typeof v, 'string', `totals.${k} deberia ser string`);
  }

  const document = doc.document as Record<string, unknown>;
  assert.equal(typeof document.access_key, 'string');
  assert.equal((document.access_key as string).length, 44);
});

test('misma semilla, mismas plantillas', () => {
  const a = prng(42), b = prng(42);
  for (let i = 0; i < 100; i++) {
    const pa = construirPlantilla(i, a, { tamanoBytes: RANGO, itemsPorDocumento: ITEMS });
    const pb = construirPlantilla(i, b, { tamanoBytes: RANGO, itemsPorDocumento: ITEMS });
    assert.equal(pa.bytes, pb.bytes);
    // El relleno usa randomBytes a proposito (no se firma su contenido, solo
    // importa su largo), asi que se compara todo MENOS el relleno.
    const sinRelleno = (d: object) => {
      const copia = { ...(d as Record<string, unknown>) };
      delete copia.padding;
      return copia;
    };
    assert.deepEqual(sinRelleno(pa.doc), sinRelleno(pb.doc));
  }
});

test('el piso medido no se movio', () => {
  // Si alguien cambia la forma del documento este numero cambia — y el piso
  // documentado en perfil.yaml y en el error de config queda mintiendo.
  assert.equal(BYTES_MINIMO_VIABLE, 1433);
});
