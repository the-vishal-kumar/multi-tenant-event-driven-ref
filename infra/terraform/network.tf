# Network: the account's default VPC unless subnets are passed in. The
# default VPC has only public subnets, so tasks get public IPs and are locked
# down by security groups (no inbound except ALB -> API). That avoids a NAT
# gateway (~$33/month per AZ plus data) at the cost of a public address per
# task. Production: private subnets with VPC endpoints for SQS, ECR, Logs and
# Secrets Manager, or NAT.

data "aws_vpc" "default" {
  count   = var.vpc_id == null ? 1 : 0
  default = true
}

data "aws_subnets" "default" {
  count = var.public_subnet_ids == null || var.service_subnet_ids == null ? 1 : 0
  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

locals {
  vpc_id             = var.vpc_id != null ? var.vpc_id : data.aws_vpc.default[0].id
  public_subnet_ids  = var.public_subnet_ids != null ? var.public_subnet_ids : data.aws_subnets.default[0].ids
  service_subnet_ids = var.service_subnet_ids != null ? var.service_subnet_ids : data.aws_subnets.default[0].ids
}

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Public HTTPS to the API load balancer"
  vpc_id      = local.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from anywhere"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from anywhere, redirected to HTTPS"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To API tasks"
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_security_group" "api" {
  name        = "${var.name}-api"
  description = "API tasks: inbound only from the load balancer"
  vpc_id      = local.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  description                  = "From the load balancer"
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_security_group" "worker" {
  name        = "${var.name}-worker"
  description = "Worker tasks: no inbound"
  vpc_id      = local.vpc_id
}

# Tasks need HTTPS out to AWS APIs (SQS, ECR, Logs, Secrets Manager, OTLP)
# and Postgres to the database.
resource "aws_vpc_security_group_egress_rule" "tasks_https" {
  for_each          = { api = aws_security_group.api.id, worker = aws_security_group.worker.id }
  security_group_id = each.value
  description       = "HTTPS to AWS APIs"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "tasks_db" {
  for_each                     = { api = aws_security_group.api.id, worker = aws_security_group.worker.id }
  security_group_id            = each.value
  description                  = "Postgres"
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "Postgres: inbound only from API and worker tasks"
  vpc_id      = local.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_tasks" {
  for_each                     = { api = aws_security_group.api.id, worker = aws_security_group.worker.id }
  security_group_id            = aws_security_group.db.id
  description                  = "Postgres from ${each.key}"
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
