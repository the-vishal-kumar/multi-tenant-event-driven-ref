#!/bin/sh
# LocalStack ready hook: the queue pair the services use. Mirrors
# infra/terraform/sqs.tf. The redrive policy is a backstop set above the
# worker's MAX_ATTEMPTS: the worker dead-letters with a reason attached, and
# SQS only moves a message itself if the worker keeps crashing on it.
set -eu
awslocal sqs create-queue --queue-name orders-events-dlq \
  --attributes MessageRetentionPeriod=1209600 >/dev/null
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/orders-events-dlq \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)
awslocal sqs create-queue --queue-name orders-events --attributes "{
  \"VisibilityTimeout\": \"30\",
  \"MessageRetentionPeriod\": \"345600\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"8\\\"}\"
}" >/dev/null
echo "queues ready"
