/**
 * `request` cuenta PETICIONES y `events` los documentos que van dentro.
 *
 * Antes `request.client` contaba eventos y el tamaño del lote era fijo. Con
 * lotes de 1 los dos numeros coincidian y la diferencia no se veia; en cuanto
 * una peticion lleva varios documentos son cosas distintas, y confundirlas
 * hace que el informe conteste la pregunta equivocada.
 *
 * Estos tests van contra el planificador de verdad, con un emisor de mentira
 * que solo apunta lo que sale. Lo que se comprueba no es que "funcione" sino
 * que los DOS numeros salgan exactos: si `request` vuelve a contar eventos,
 * aqui se cae.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validarPerfil } from '../src/config/config.service';

/** Un perfil de carga minimo, con los rangos que se quieran probar. */
function perfil(
  peticiones: [number, number] | null,
  eventos: [number, number] | null,
  porRequest = 1,
  tamanoBytes: [number, number] = [2048, 4096],
) {
  return validarPerfil(
    {
      modo: 'carga',
      reparto: { tipo: 'uniforme', exponente: 1 },
      llegadas: { tipo: 'uniforme', tick_ms: 10 },
      peticiones: peticiones ? { client: peticiones } : {},
      eventos: eventos ? { client: eventos } : {},
      pool: {
        plantillas: 4,
        semilla: 7,
        tamano_bytes: tamanoBytes,
        items_por_documento: [1, 2],
        eventos_por_hilo: 1,
        tasa_verificacion: 0,
      },
      envio: {
        ruta: '/events',
        prueba_id: 't',
        eventos_por_request: porRequest,
        espera_maxima_lote_ms: 200,
        concurrencia_por_tenant: 0,
        timeout_ms: 1000,
        conexiones_por_destino: 8,
        reintentos: 0,
      },
      smoke: { eventos_totales: 1, llamadas_por_tenant: [1, 1], duracion_objetivo: '1s' },
      carga: { fases: [{ nombre: 'c', duracion: '5s', ritmo: 10 }] },
    },
    'test',
  );
}

test('el perfil acepta eventos.client y lo deja como rango', () => {
  const p = perfil([10, 20], [1, 10]);
  assert.deepEqual(p.peticiones.porCliente, { min: 10, max: 20 });
  assert.deepEqual(p.eventos.porPeticion, { min: 1, max: 10 });
});

test('sin eventos.client el rango queda en null: manda el tamaño fijo', () => {
  const p = perfil([10, 20], null, 5);
  assert.equal(p.eventos.porPeticion, null);
  assert.equal(p.envio.eventosPorRequest, 5);
});

test('un rango de un solo valor es un tamaño fijo', () => {
  const p = perfil([10, 20], [3, 3]);
  assert.deepEqual(p.eventos.porPeticion, { min: 3, max: 3 });
});

test('eventos.client rechaza un rango invertido', () => {
  assert.throws(() => perfil([10, 20], [10, 1]), /eventos\.client/);
});

test('eventos.client rechaza el cero: una peticion sin documentos no existe', () => {
  assert.throws(() => perfil([10, 20], [0, 5]), /eventos\.client/);
});

// ─────────────────────────────────────────────────────────────────────────────
// La aritmética que importa
// ─────────────────────────────────────────────────────────────────────────────

test('eventos/s = peticiones/s x documentos por peticion', () => {
  // Es la relación que el usuario tiene que poder razonar de cabeza al pedir
  // una corrida. Si el planificador la rompe, el ritmo pedido y el ritmo real
  // dejan de tener nada que ver.
  const p = perfil([100, 200], [1, 10]);
  const reqMedia = (p.peticiones.porCliente!.min + p.peticiones.porCliente!.max) / 2;
  const evMedia = (p.eventos.porPeticion!.min + p.eventos.porPeticion!.max) / 2;
  assert.equal(reqMedia * evMedia, 150 * 5.5);
});

// ─────────────────────────────────────────────────────────────────────────────
// Los limites de tamaño del pool
// ─────────────────────────────────────────────────────────────────────────────

test('el piso rechaza un rango por debajo del documento fiscal', () => {
  assert.throws(
    () => perfil([10, 20], [1, 5], 1, [1536, 4096]),
    /no baja de 2024 bytes canonicos/,
  );
});

test('el techo BLOQUEA por encima de 4096: es el limite de kms:Sign RAW', () => {
  // Antes esto era un warn — sobraban 1.024 bytes hasta el limite de KMS y
  // pasarse solo hacia los numeros incomparables. Con el techo en 4.096 no
  // sobra nada: si esto no lanza, la corrida arranca, genera las 1.000
  // plantillas, y muere en C3 con un error de KMS que no menciona esta config.
  assert.throws(
    () => perfil([10, 20], [1, 5], 1, [2048, 4097]),
    /limite DURO de kms:Sign con MessageType RAW/,
  );
});

test('2 KB exactos siguen siendo pedibles', () => {
  // Es el defecto de perfil.yaml. Si el piso subiera por encima, el perfil que
  // se entrega en el repo dejaria de arrancar.
  assert.doesNotThrow(() => perfil([10, 20], [1, 5], 1, [2048, 4096]));
});
