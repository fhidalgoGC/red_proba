output "cola_url" { value = aws_sqs_queue.eventos.id }
output "cola_arn" { value = aws_sqs_queue.eventos.arn }
output "dlq_url" { value = aws_sqs_queue.dlq.id }
output "dlq_arn" { value = aws_sqs_queue.dlq.arn }
