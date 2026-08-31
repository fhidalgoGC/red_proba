/**
 * El reparto de un lote: en paralelo POR GRUPO, en serie DENTRO del grupo.
 *
 * ⚠ POR QUE ESTE ARCHIVO EXISTE. `procesarLote` paso de un `for` secuencial
 * sobre todo el lote a `Promise.all` sobre los grupos. Ese cambio multiplica el
 * ritmo, y tambien es el que podria romper P4 en silencio: si dos eventos del
 * MISMO expediente se procesaran a la vez, el `sequence` 3 podria persistirse
 * antes que el 2 y la deteccion de huecos leeria un hueco transitorio como
 * definitivo.
 *
 * No hay error, ni excepcion, ni log: solo un numero de conciliacion que no
 * cuadra una vez de cada muchas. Por eso el invariante se prueba y no se
 * confia al comentario.
 *
 * Se prueba la ESTRATEGIA de reparto, no el ConsumidorService entero: montarlo
 * pediria SQS, KMS y Postgres, y lo que puede romperse aqui es el reparto.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** Igual que en `ConsumidorService.procesarLote`. */
function agrupar<T extends { Attributes?: { MessageGroupId?: string } }>(
  mensajes: T[],
): Map<string, T[]> {
  const porGrupo = new Map<string, T[]>();
  for (const mensaje of mensajes) {
    const grupo = mensaje.Attributes?.MessageGroupId ?? '';
    const lista = porGrupo.get(grupo);
    if (lista) lista.push(mensaje);
    else porGrupo.set(grupo, [mensaje]);
  }
  return porGrupo;
}

interface Msg {
  id: string;
  Attributes?: { MessageGroupId?: string };
}

const msg = (id: string, grupo?: string): Msg => ({
  id,
  Attributes: grupo === undefined ? undefined : { MessageGroupId: grupo },
});

/**
 * Corre el lote como lo hace el consumidor y devuelve el orden REAL en que
 * empezo y termino cada mensaje.
 *
 * @param demora ms que tarda cada mensaje, por id. Es lo que hace visible la
 *               concurrencia: si el lento empieza primero y el rapido termina
 *               antes, es que corrieron a la vez.
 */
async function correr(mensajes: Msg[], demora: Record<string, number> = {}) {
  const inicios: string[] = [];
  const fines: string[] = [];
  let enVuelo = 0;
  let maxEnVuelo = 0;

  await Promise.all(
    [...agrupar(mensajes).values()].map(async (delGrupo) => {
      for (const m of delGrupo) {
        inicios.push(m.id);
        enVuelo += 1;
        maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
        await new Promise((r) => setTimeout(r, demora[m.id] ?? 1));
        enVuelo -= 1;
        fines.push(m.id);
      }
    }),
  );

  return { inicios, fines, maxEnVuelo };
}

// ---------------------------------------------------------------------------

test('dentro de un grupo se respeta el orden aunque el primero sea lento', async () => {
  // Un expediente con tres eventos: sequence 1, 2 y 3. El 1 tarda 40 ms y los
  // otros 1 ms. En paralelo terminarian 2, 3, 1 — y esa es exactamente la
  // inversion que rompe la deteccion de huecos.
  const r = await correr(
    [msg('s1', 'exp-A'), msg('s2', 'exp-A'), msg('s3', 'exp-A')],
    { s1: 40 },
  );

  assert.deepEqual(r.fines, ['s1', 's2', 's3'], 'el orden dentro del grupo no se respeto');
  assert.equal(r.maxEnVuelo, 1, 'dos eventos del mismo expediente se procesaron a la vez');
});

test('grupos distintos se procesan a la vez', async () => {
  const r = await correr(
    [msg('a', 'exp-A'), msg('b', 'exp-B'), msg('c', 'exp-C')],
    { a: 40 },
  );

  assert.equal(r.maxEnVuelo, 3, 'los expedientes distintos no se solaparon: sigue siendo secuencial');
  // El lento arranco primero y termino ultimo: prueba de que los otros no
  // esperaron a que acabase.
  assert.equal(r.inicios[0], 'a');
  assert.equal(r.fines.at(-1), 'a');
});

test('con eventos_por_hilo=1 el lote entero se paraleliza', async () => {
  // El perfil por defecto: un expediente por evento. Es el caso que da el
  // ritmo maximo, y el que hace que el cambio valga la pena.
  const diez = Array.from({ length: 10 }, (_, i) => msg(`e${i}`, `exp-${i}`));
  const r = await correr(diez);
  assert.equal(r.maxEnVuelo, 10);
});

test('sin MessageGroupId todo cae en un grupo y vuelve a ser secuencial', async () => {
  // La degradacion que se quiere: si alguien quitara
  // `MessageSystemAttributeNames: ['All']` del ReceiveMessage, esto seria
  // lento pero NUNCA incorrecto. El fallo silencioso seria el contrario.
  const r = await correr([msg('a'), msg('b'), msg('c')]);
  assert.equal(r.maxEnVuelo, 1);
  assert.deepEqual(r.fines, ['a', 'b', 'c']);
});

test('un grupo lento no retrasa a los demas', async () => {
  // Dos expedientes: uno con dos eventos lentos, otro con uno rapido. El
  // rapido no tiene por que esperar 80 ms.
  const r = await correr(
    [msg('lento1', 'A'), msg('lento2', 'A'), msg('rapido', 'B')],
    { lento1: 30, lento2: 30 },
  );
  assert.equal(r.fines[0], 'rapido', 'el grupo rapido quedo detras del lento');
});
