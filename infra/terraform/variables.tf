variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "orders"
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "vpc_id" {
  description = "VPC to deploy into. Null uses the account's default VPC (fine for a reference; see README)."
  type        = string
  default     = null
}

variable "public_subnet_ids" {
  description = "Subnets for the load balancer. Null uses the default VPC's subnets."
  type        = list(string)
  default     = null
}

variable "service_subnet_ids" {
  description = "Subnets for ECS tasks and the database. Null uses the default VPC's subnets."
  type        = list(string)
  default     = null
}

variable "assign_public_ip" {
  description = "Give tasks public IPs so they reach ECR, SQS and CloudWatch without a NAT gateway. Set false with private subnets plus NAT or VPC endpoints."
  type        = bool
  default     = true
}

variable "certificate_arn" {
  description = "ACM certificate for the HTTPS listener."
  type        = string
}

variable "api_image" {
  description = "API image URI (built from api/Dockerfile, target runtime)."
  type        = string
}

variable "worker_image" {
  description = "Worker image URI (built from worker/Dockerfile)."
  type        = string
}

variable "api_desired_count" {
  description = "API tasks. Two spreads across AZs."
  type        = number
  default     = 2
}

variable "worker_desired_count" {
  description = "Worker tasks."
  type        = number
  default     = 1
}

variable "worker_on_spot" {
  description = "Run workers on Fargate Spot. Safe: an interrupted worker's in-flight messages reappear after the visibility timeout and are deduped."
  type        = bool
  default     = true
}

variable "database_mode" {
  description = "aurora-serverless-v2 or rds-instance."
  type        = string
  default     = "aurora-serverless-v2"

  validation {
    condition     = contains(["aurora-serverless-v2", "rds-instance"], var.database_mode)
    error_message = "database_mode must be aurora-serverless-v2 or rds-instance."
  }
}

variable "aurora_min_acu" {
  description = "Aurora Serverless v2 minimum capacity. 0 allows auto-pause on supported engine versions; 0.5 keeps it warm."
  type        = number
  default     = 0.5
}

variable "aurora_max_acu" {
  description = "Aurora Serverless v2 maximum capacity."
  type        = number
  default     = 4
}

variable "rds_instance_class" {
  description = "Instance class when database_mode = rds-instance."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_multi_az" {
  description = "Standby in a second AZ (rds-instance) or a reader instance (aurora). Doubles database cost."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Protect the database from deletion."
  type        = bool
  default     = true
}

variable "worker_max_attempts" {
  description = "Deliveries before the worker dead-letters a retryable failure."
  type        = number
  default     = 5
}

variable "max_receive_count" {
  description = "SQS redrive backstop. Must exceed worker_max_attempts so the worker, which records the failure reason, normally dead-letters first."
  type        = number
  default     = 8
}

variable "queue_age_alarm_seconds" {
  description = "Alarm when the oldest message on the main queue is older than this (consumers stalled or behind)."
  type        = number
  default     = 300
}

variable "outbox_age_alarm_seconds" {
  description = "Alarm when the oldest unpublished outbox row is older than this (the relay can't publish or is behind)."
  type        = number
  default     = 120
}

variable "dlq_age_alarm_seconds" {
  description = "Alarm when a dead letter has sat untriaged this long. The DLQ keeps messages 14 days."
  type        = number
  default     = 86400
}

variable "alarm_email" {
  description = "Optional email subscribed to the alarm topic."
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention."
  type        = number
  default     = 30
}

variable "otel_exporter_otlp_endpoint" {
  description = "OTLP/HTTP endpoint for traces (for example an ADOT collector forwarding to X-Ray). Null disables export; context still propagates."
  type        = string
  default     = null
}
