package queue

import (
	"context"
	"math"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// SQS is a Queue backed by one SQS queue URL.
type SQS struct {
	client *sqs.Client
	url    string
}

func NewSQS(client *sqs.Client, url string) *SQS { return &SQS{client: client, url: url} }

func (q *SQS) Receive(ctx context.Context, limit int, wait time.Duration) ([]Message, error) {
	out, err := q.client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
		QueueUrl:              aws.String(q.url),
		MaxNumberOfMessages:   int32(min(limit, 10)),
		WaitTimeSeconds:       int32(wait / time.Second),
		MessageAttributeNames: []string{"All"},
		MessageSystemAttributeNames: []types.MessageSystemAttributeName{
			types.MessageSystemAttributeNameApproximateReceiveCount,
			types.MessageSystemAttributeNameSentTimestamp,
		},
	})
	if err != nil {
		return nil, err
	}
	msgs := make([]Message, 0, len(out.Messages))
	for _, m := range out.Messages {
		attrs := make(map[string]string, len(m.MessageAttributes))
		for k, v := range m.MessageAttributes {
			if v.StringValue != nil {
				attrs[k] = *v.StringValue
			}
		}
		count, _ := strconv.Atoi(m.Attributes[string(types.MessageSystemAttributeNameApproximateReceiveCount)])
		sentMs, _ := strconv.ParseInt(m.Attributes[string(types.MessageSystemAttributeNameSentTimestamp)], 10, 64)
		msgs = append(msgs, Message{
			ID:            aws.ToString(m.MessageId),
			ReceiptHandle: aws.ToString(m.ReceiptHandle),
			Body:          aws.ToString(m.Body),
			Attributes:    attrs,
			ReceiveCount:  max(count, 1),
			SentAt:        time.UnixMilli(sentMs),
		})
	}
	return msgs, nil
}

func (q *SQS) Delete(ctx context.Context, receiptHandle string) error {
	_, err := q.client.DeleteMessage(ctx, &sqs.DeleteMessageInput{
		QueueUrl: aws.String(q.url), ReceiptHandle: aws.String(receiptHandle),
	})
	return err
}

func (q *SQS) ChangeVisibility(ctx context.Context, receiptHandle string, d time.Duration) error {
	// SQS takes whole seconds, 0..43200.
	secs := int32(min(math.Ceil(d.Seconds()), 43200))
	_, err := q.client.ChangeMessageVisibility(ctx, &sqs.ChangeMessageVisibilityInput{
		QueueUrl: aws.String(q.url), ReceiptHandle: aws.String(receiptHandle), VisibilityTimeout: secs,
	})
	return err
}

func (q *SQS) Send(ctx context.Context, body string, attributes map[string]string) error {
	attrs := make(map[string]types.MessageAttributeValue, len(attributes))
	for k, v := range attributes {
		attrs[k] = types.MessageAttributeValue{DataType: aws.String("String"), StringValue: aws.String(v)}
	}
	_, err := q.client.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl: aws.String(q.url), MessageBody: aws.String(body), MessageAttributes: attrs,
	})
	return err
}
