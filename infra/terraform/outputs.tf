output "api_url" {
  description = "Public API endpoint (point a DNS record for the certificate's name at the ALB)."
  value       = "https://${aws_lb.api.dns_name}"
}

output "queue_url" {
  value = aws_sqs_queue.events.url
}

output "dlq_url" {
  value = aws_sqs_queue.dlq.url
}

output "db_endpoint" {
  value = local.db_endpoint
}

output "secret_arns" {
  description = "Secrets to populate during bootstrap."
  value       = local.secret
}

output "migrate_task_definition" {
  value = aws_ecs_task_definition.migrate.arn
}
