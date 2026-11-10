# One execution role per service (pull image, write logs, read that
# service's secrets) and one task role per service (what the code itself may
# call). Nothing gets a wildcard action or resource beyond what the AWS API
# requires.

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  services = {
    api     = ["database-url-api", "database-url-relay", "jwt-secret"]
    worker  = ["database-url-worker"]
    migrate = ["database-url-owner"]
  }
}

resource "aws_iam_role" "execution" {
  for_each           = local.services
  name               = "${var.name}-${each.key}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "execution" {
  for_each = local.services

  statement {
    sid       = "PullImages"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # GetAuthorizationToken has no resource-level permissions
  }
  statement {
    sid       = "PullLayers"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = ["arn:${data.aws_partition.current.partition}:ecr:${var.region}:${data.aws_caller_identity.current.account_id}:repository/*"]
  }
  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.service[each.key].arn}:*"]
  }
  statement {
    sid       = "ReadOwnSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for s in each.value : aws_secretsmanager_secret.app[s].arn]
  }
}

resource "aws_iam_role_policy" "execution" {
  for_each = local.services
  name     = "execution"
  role     = aws_iam_role.execution[each.key].id
  policy   = data.aws_iam_policy_document.execution[each.key].json
}

resource "aws_iam_role" "task" {
  for_each           = local.services
  name               = "${var.name}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# API (and its in-process outbox relay): publish to the events queue only.
data "aws_iam_policy_document" "api_task" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.events.arn]
  }
}

# Worker: consume the events queue; dead-letter to, and redrive from, the DLQ.
data "aws_iam_policy_document" "worker_task" {
  statement {
    sid = "Consume"
    actions = [
      "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes", "sqs:SendMessage", # SendMessage: redrive back to this queue
    ]
    resources = [aws_sqs_queue.events.arn]
  }
  statement {
    sid = "DeadLetter"
    actions = [
      "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.dlq.arn]
  }
}

resource "aws_iam_role_policy" "api_task" {
  name   = "sqs-publish"
  role   = aws_iam_role.task["api"].id
  policy = data.aws_iam_policy_document.api_task.json
}

resource "aws_iam_role_policy" "worker_task" {
  name   = "sqs-consume"
  role   = aws_iam_role.task["worker"].id
  policy = data.aws_iam_policy_document.worker_task.json
}
# The migrate task role has no policy: it only talks to Postgres.
