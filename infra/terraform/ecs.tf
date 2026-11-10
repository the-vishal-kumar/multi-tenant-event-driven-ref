# ECS on Fargate: the API (with the outbox relay in-process) behind an ALB,
# the worker with no inbound access, and a one-off migrate task.

resource "aws_cloudwatch_log_group" "service" {
  for_each          = local.services
  name              = "/ecs/${var.name}/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "main" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

locals {
  queue_env = [
    { name = "QUEUE_URL", value = aws_sqs_queue.events.url },
    { name = "DLQ_URL", value = aws_sqs_queue.dlq.url },
    { name = "AWS_REGION", value = var.region },
  ]
  otel_env = var.otel_exporter_otlp_endpoint == null ? [] : [
    { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = var.otel_exporter_otlp_endpoint },
  ]
  secret = { for k in local.secret_names : k => aws_secretsmanager_secret.app[k].arn }

  log_config = { for k in keys(local.services) : k => {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.service[k].name
      awslogs-region        = var.region
      awslogs-stream-prefix = k
    }
  } }

  container_defaults = {
    essential              = true
    readonlyRootFilesystem = true
    user                   = "1000"
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution["api"].arn
  task_role_arn            = aws_iam_role.task["api"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64" # Graviton: ~20% cheaper per vCPU-hour
  }

  container_definitions = jsonencode([merge(local.container_defaults, {
    name         = "api"
    image        = var.api_image
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment = concat(local.queue_env, local.otel_env, [
      { name = "PORT", value = "3000" },
      { name = "OTEL_SERVICE_NAME", value = "orders-api" },
    ])
    secrets = [
      { name = "DATABASE_URL_API", valueFrom = local.secret["database-url-api"] },
      { name = "DATABASE_URL_RELAY", valueFrom = local.secret["database-url-relay"] },
      { name = "JWT_SECRET", valueFrom = local.secret["jwt-secret"] },
    ]
    healthCheck = {
      command  = ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/healthz"]
      interval = 15
      timeout  = 5
      retries  = 3
    }
    logConfiguration = local.log_config["api"]
  })])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution["worker"].arn
  task_role_arn            = aws_iam_role.task["worker"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    # Fargate Spot does not run ARM64 tasks, so a Spot worker is x86_64.
    # Build the worker image for both architectures.
    cpu_architecture = var.worker_on_spot ? "X86_64" : "ARM64"
  }

  container_definitions = jsonencode([merge(local.container_defaults, {
    name    = "worker"
    image   = var.worker_image
    command = ["run"] # `redrive -max N` as a one-off: aws ecs run-task --overrides
    environment = concat(local.queue_env, local.otel_env, [
      { name = "MAX_ATTEMPTS", value = tostring(var.worker_max_attempts) },
      { name = "BACKOFF_BASE", value = "2s" },
      { name = "BACKOFF_MAX", value = "5m" },
      { name = "CONCURRENCY", value = "4" },
      { name = "OTEL_SERVICE_NAME", value = "orders-worker" },
    ])
    secrets = [
      { name = "DATABASE_URL_WORKER", valueFrom = local.secret["database-url-worker"] },
    ]
    stopTimeout      = 30 # finish in-flight messages on SIGTERM / Spot interruption
    logConfiguration = local.log_config["worker"]
  })])
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution["migrate"].arn
  task_role_arn            = aws_iam_role.task["migrate"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([merge(local.container_defaults, {
    name    = "migrate"
    image   = var.api_image
    command = ["node", "dist/cli.js", "migrate"]
    secrets = [
      { name = "DATABASE_URL_OWNER", valueFrom = local.secret["database-url-owner"] },
    ]
    logConfiguration = local.log_config["migrate"]
  })])
}

resource "aws_ecs_service" "api" {
  name                   = "${var.name}-api"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.api.arn
  desired_count          = var.api_desired_count
  launch_type            = "FARGATE"
  enable_execute_command = false
  propagate_tags         = "SERVICE"

  network_configuration {
    subnets          = local.service_subnet_ids
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = var.assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_service" "worker" {
  name                   = "${var.name}-worker"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.worker.arn
  desired_count          = var.worker_desired_count
  enable_execute_command = false
  propagate_tags         = "SERVICE"

  capacity_provider_strategy {
    capacity_provider = var.worker_on_spot ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
  }

  network_configuration {
    subnets          = local.service_subnet_ids
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = var.assign_public_ip
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_ecs_cluster_capacity_providers.main]
}

# ---- load balancer ----

resource "aws_lb" "api" {
  name                       = "${var.name}-api"
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = local.public_subnet_ids
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
}

resource "aws_lb_target_group" "api" {
  name                 = "${var.name}-api"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = local.vpc_id
  deregistration_delay = 15

  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
