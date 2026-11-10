# Standard queue (at-least-once, best-effort order) plus a DLQ. The worker
# dead-letters after worker_max_attempts with the failure reason attached;
# the SQS redrive policy at max_receive_count is the backstop for a worker
# that crashes before it can do so.

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name}-events-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "events" {
  name                       = "${var.name}-events"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 345600 # 4 days
  receive_wait_time_seconds  = 20     # long polling: fewer empty receives, lower cost
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  lifecycle {
    precondition {
      condition     = var.max_receive_count > var.worker_max_attempts
      error_message = "max_receive_count must exceed worker_max_attempts so the worker dead-letters first."
    }
  }
}

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.events.arn]
  })
}
