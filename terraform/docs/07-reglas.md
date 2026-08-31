# 07 — Reglas que no se negocian

Cada una tiene una razón concreta y romperla invalida algo. Son las del track `T`;
las de la PoC entera están en [CLAUDE.md](../../CLAUDE.md).

---

### 1 · `for_each` sobre la lista de tenants, nunca 50 bloques copiados

Es D-07 y T-05. Si el código se duplicara, lo que validas con 1 tenant dejaría de
ser lo que corres con 50, y la prueba de humo no probaría nada.

Lo mismo vale entre `oneClient/` y `50client/`: son root modules **delgados** sobre
los mismos `modules/`. Lo único que puede diferir es `var.tenants`.

---

### 2 · Ninguna conexión entre VPC. Ninguna

Sin peering, sin Transit Gateway, sin PrivateLink — **en ningún par**, no solo
entre C3 y C4. Es lo que convierte «SQS es el único canal» de una regla que alguien
puede aflojar en una propiedad de la topología.

En cuanto exista un peering, aunque sea hacia el orquestador, la afirmación pasa a
depender de que nadie replique el patrón.

---

### 3 · `kms:Sign` no aparece en el rol de C4, y además hay un `Deny` explícito

Las dos cosas, no una. La política de identidad puede aflojarse por descuido; el
`Deny` de la key policy gana sobre cualquier `Allow`, incluso de un admin.

Si `kms:Sign` aparece en el rol de C4, el Proof Ledger perdió su valor probatorio
y la PoC dejó de demostrar lo que dice demostrar.

---

### 4 · El gateway de S3 no sigue la perilla de encendido

Porque es gratis, y porque es el que se olvida. Sin él, el pull de ECR falla con
`CannotPullContainerError` — un error que no menciona S3 por ningún lado y que
cuesta media tarde diagnosticar.

---

### 5 · Los interface endpoints sí siguen la perilla

Cobran ~$0,01/h **por ENI y por AZ**. Si no siguieran a `desired_count`, estar
«apagado» costaría ~$3,36/día con una AZ, unas 35× el baseline de la cuenta, sin
nada corriendo.

---

### 6 · La perilla se escribe en un archivo, no se pasa con `-var`

Al aplicar un plan guardado, OpenTofu relee los `tfvars` y compara: un `-var` de la
línea de comandos da `Mismatch between input and plan variable value`.

Por eso `estado.auto.tfvars` y `clientes.auto.tfvars` están **generados** y llevan
la cabecera «no editar a mano».

---

### 7 · Exportar los logs ANTES del destroy

Los log groups se van con el destroy y **no se recuperan**. Es la única
oportunidad, y por eso es el paso 2 de `destruir.sh` y no una tarea posterior.

Cuando un evento no verifique, el log es lo único que dice por qué.

---

### 8 · `skip_final_snapshot = true` y `recovery_window_in_days = 0`

Los dos existen para que el destroy sea limpio y repetible:

- sin el primero, el destroy exige un snapshot final que tarda y deja un artefacto
  **facturando que nadie recuerda borrar**;
- sin el segundo, el secreto entra en espera de 7–30 días y el siguiente `apply`
  falla con «already scheduled for deletion».

Es una PoC. Lo que importa es poder crear y destruir a voluntad.

---

### 9 · Tagear desde el primer `apply`

Cost Explorer **no etiqueta retroactivamente**. Un `apply` sin tags es un agujero
permanente en el reporte de costes: no se arregla después.

Tagear siempre; activar las cost allocation tags cuando el payer pueda. Al revés no
funciona.

---

### 10 · «Destruido» no vale sin verificar

Esta PoC factura por hora. `Destroy complete!` dice que Terraform terminó, no que
la cuenta esté en cero: quedan ENIs liberándose, llaves en periodo de espera y, si
algo falló a mitad, recursos huérfanos sin state que los gobierne.

El cierre del track es `verificar-limpio.sh` + un día de Cost Explorer que vuelve
al baseline.
