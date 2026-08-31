output "vpc_ids" { value = { for k, v in aws_vpc.esta : k => v.id } }
output "vpc_cidrs" { value = { for k, v in local.vpcs : k => v.cidr } }
output "azs" { value = local.azs }

output "subnets_app" {
  description = "Subnets de aplicacion por VPC."
  value = { for vpc in keys(local.vpcs) : vpc => [
    for k, s in aws_subnet.app : s.id if split("-", k)[0] == vpc
  ] }
}

output "subnets_datos" {
  description = "Subnets de datos por VPC. Solo c3 y c4."
  value = { for vpc in ["c3", "c4"] : vpc => [
    for k, s in aws_subnet.datos : s.id if split("-", k)[0] == vpc
  ] }
}

output "namespace_c3_id" { value = aws_service_discovery_private_dns_namespace.poc.id }
output "namespace_c3_nombre" { value = aws_service_discovery_private_dns_namespace.poc.name }
output "namespace_c4_id" { value = aws_service_discovery_private_dns_namespace.c4.id }

output "db_subnet_groups" {
  description = "DB subnet groups por dominio. RDS los exige con >=2 AZ."
  value       = { for k, v in aws_db_subnet_group.esta : k => v.name }
}
