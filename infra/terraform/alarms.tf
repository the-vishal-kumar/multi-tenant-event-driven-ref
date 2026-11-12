# Alarms that page on the failure modes of this design: messages
# dead-lettered, dead letters left untriaged, the main queue backing up
# (workers down, stuck, or under-provisioned), and events stuck in the outbox
# (the relay can't publish).

resource "aws_sns_topic" "alarms" {
  name              = "${var.name}-alarms"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  alarm_name          = "${var.name}-dlq-not-empty"
  alarm_description   = "Messages were dead-lettered. Read failure_reason on the DLQ messages, fix the cause, then run the worker's redrive command."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dlq.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "dlq_age" {
  alarm_name          = "${var.name}-dlq-untriaged"
  alarm_description   = "A dead letter has waited longer than ${var.dlq_age_alarm_seconds}s. The DLQ deletes messages after 14 days."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.dlq_age_alarm_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${var.name}-events-backlog"
  alarm_description   = "Oldest message on the events queue is older than ${var.queue_age_alarm_seconds}s: workers are down, failing, or too few."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.events.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = var.queue_age_alarm_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.name}-api-5xx"
  alarm_description   = "API returning server errors."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.api.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

# The SQS metrics can't see events that never left the outbox. The relay logs
# `{"msg":"outbox backlog","outbox_oldest_age_seconds":N,...}` every 15 s from
# each API task; this filter turns that field into a metric.
resource "aws_cloudwatch_log_metric_filter" "outbox_age" {
  name           = "${var.name}-outbox-oldest-age"
  log_group_name = aws_cloudwatch_log_group.service["api"].name
  pattern        = "{ $.msg = \"outbox backlog\" }"

  metric_transformation {
    name      = "OutboxOldestUnpublishedAgeSeconds"
    namespace = "${var.name}/outbox"
    value     = "$.outbox_oldest_age_seconds"
    unit      = "Seconds"
  }
}

resource "aws_cloudwatch_metric_alarm" "outbox_age" {
  alarm_name          = "${var.name}-outbox-backlog"
  alarm_description   = "An order event has waited in the outbox longer than ${var.outbox_age_alarm_seconds}s, or no API task has reported the backlog for 3 minutes. The relay can't publish (SQS outage, IAM, wrong QUEUE_URL) or isn't running: look for 'relay batch failed' in the API log."
  namespace           = "${var.name}/outbox"
  metric_name         = "OutboxOldestUnpublishedAgeSeconds"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = var.outbox_age_alarm_seconds
  comparison_operator = "GreaterThanThreshold"
  # No reports means no relay is running, which is the same outage.
  treat_missing_data = "breaching"
  alarm_actions      = local.alarm_actions
  ok_actions         = local.alarm_actions
}
