output "rol_ejecucion_arn" { value = aws_iam_role.ejecucion.arn }
output "rol_ejecucion_name" { value = aws_iam_role.ejecucion.name }

output "rol_c3_arn" { value = aws_iam_role.c3_task.arn }
output "rol_c3_name" { value = aws_iam_role.c3_task.name }
output "rol_c4_arn" { value = aws_iam_role.c4_task.arn }
output "rol_c4_name" { value = aws_iam_role.c4_task.name }
output "rol_orq_arn" { value = aws_iam_role.orq_task.arn }

output "kms_firma_arn" { value = aws_kms_key.firma.arn }
output "kms_hmac_arn" { value = aws_kms_key.hmac.arn }
output "kms_mensajes_arn" { value = aws_kms_key.mensajes.arn }
output "kms_cola_arn" { value = aws_kms_key.cola.arn }

output "sg_tenant_ids" { value = { for k, v in aws_security_group.tenant : k => v.id } }
output "sg_c4_id" { value = aws_security_group.c4.id }
output "sg_orq_id" { value = aws_security_group.orq.id }

# Vacio cuando acceso_externo = false. Ver acceso-externo.tf.
output "sg_bastion_ids" {
  value = { for k, v in aws_security_group.bastion : k => v.id }
}
