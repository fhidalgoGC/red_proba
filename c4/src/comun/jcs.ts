/**
 * JCS — JSON Canonicalization Scheme, RFC 8785.
 *
 * ⚠ LA IMPLEMENTACION ES LA MISMA QUE `orquestador/src/generador/jcs.ts`.
 * Hay un test que lo comprueba y falla si una de las dos deriva.
 *
 * Y esa duplicacion es un riesgo conocido, no un descuido. El orquestador
 * ajusta el tamano canonico con JCS, C3 firma sobre JCS y C4 verifica sobre
 * JCS: si una de las tres copias deriva, el sintoma no es "hay dos
 * implementaciones" sino "la firma no verifica", que es indistinguible de un
 * intento de inyeccion y va a la DLQ con alarma. Cuando C3 exista de verdad,
 * las tres tienen que colapsar en un paquete compartido.
 *
 * Por que se puede delegar tanto en JSON.stringify de V8:
 *
 *  - Numeros: JCS manda serializarlos con el algoritmo Number::toString de
 *    ECMAScript, que es exactamente lo que hace JSON.stringify.
 *  - Cadenas: JCS manda el escape minimo de JSON — \b \t \n \f \r, \" y \\,
 *    y \u00xx en hex MINUSCULA para el resto de los caracteres de control.
 *    Es literalmente lo que produce V8. Y no escapa los no-ASCII, que es lo
 *    que JCS quiere (salida UTF-8).
 *  - Sustitutos sueltos: V8 moderno los emite como \udXXX (well-formed
 *    JSON.stringify), que coincide con JCS.
 *
 * Lo unico que JSON.stringify NO hace es ordenar las claves, y ese orden es
 * por unidades de codigo UTF-16 — que es justo el orden por defecto de
 * Array.prototype.sort() sobre strings.
 */

export function canonicalize(valor: unknown): string {
  const salida: string[] = [];
  escribir(valor, salida);
  return salida.join('');
}

function escribir(valor: unknown, salida: string[]): void {
  if (valor === null) {
    salida.push('null');
    return;
  }

  switch (typeof valor) {
    case 'boolean':
      salida.push(valor ? 'true' : 'false');
      return;

    case 'number':
      // JCS prohibe NaN e Infinity: no tienen representacion en JSON y
      // dejarlos pasar produciria un canonico que no se puede reparsear.
      if (!Number.isFinite(valor)) {
        throw new Error(`JCS: numero no finito (${valor})`);
      }
      salida.push(JSON.stringify(valor));
      return;

    case 'string':
      salida.push(JSON.stringify(valor));
      return;

    case 'object':
      break;

    default:
      // undefined, function, symbol, bigint. JSON.stringify los omitiria en
      // silencio y el canonico saldria distinto en cada lado. Fallar aqui.
      throw new Error(`JCS: tipo no serializable (${typeof valor})`);
  }

  if (Array.isArray(valor)) {
    salida.push('[');
    for (let i = 0; i < valor.length; i++) {
      if (i > 0) salida.push(',');
      escribir(valor[i], salida);
    }
    salida.push(']');
    return;
  }

  const obj = valor as Record<string, unknown>;
  // Orden por unidades de codigo UTF-16 = el sort por defecto de JS.
  const claves = Object.keys(obj).sort();

  salida.push('{');
  let primera = true;
  for (const clave of claves) {
    const v = obj[clave];
    // Coherencia con JSON.stringify: una clave con valor undefined no
    // existe. Se omite en vez de reventar, porque `{...evento}` puede
    // arrastrar undefined sin que sea un error.
    if (v === undefined) continue;
    if (!primera) salida.push(',');
    primera = false;
    salida.push(JSON.stringify(clave));
    salida.push(':');
    escribir(v, salida);
  }
  salida.push('}');
}

/** Tamaño canonico en BYTES. Nunca `.length`: un acento son 2 bytes. */
export function bytesCanonicos(valor: unknown): number {
  return Buffer.byteLength(canonicalize(valor), 'utf8');
}
