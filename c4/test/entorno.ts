/**
 * Valores por defecto para correr las pruebas en local.
 *
 * El Postgres es un contenedor cualquiera; lo unico que la prueba necesita es
 * una base donde crear su propio esquema y tirarlo al terminar. La cola y las
 * llaves, en cambio, son las REALES de la PoC: probar el descifrado contra un
 * KMS de mentira no probaria el descifrado.
 */
export const BD =
  process.env.DATABASE_URL ?? 'postgres://cw:cwlocal@127.0.0.1:5433/rpf_c4';

export const REGION = process.env.AWS_REGION ?? 'us-west-2';

export const COLA =
  process.env.SQS_QUEUE_URL ??
  'https://sqs.us-west-2.amazonaws.com/276076558677/rpf-one-eventos.fifo';

export const DLQ =
  process.env.SQS_DLQ_URL ??
  'https://sqs.us-west-2.amazonaws.com/276076558677/rpf-one-eventos-dlq.fifo';

export const LLAVE_FIRMA =
  process.env.KMS_SIGN_KEY_ID ??
  'arn:aws:kms:us-west-2:276076558677:key/9c2ba3c2-e111-463a-871f-c1ee048dbefa';

export const LLAVE_CIFRADO =
  process.env.KMS_ENCRYPT_KEY_ID ??
  'arn:aws:kms:us-west-2:276076558677:key/f8940502-057c-42b3-9a09-8d40cf673f68';
