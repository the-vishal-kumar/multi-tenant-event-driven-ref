package queue

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// Runs against LocalStack when SQS_ENDPOINT is set; skipped otherwise.
func newTestQueue(t *testing.T) *SQS {
	t.Helper()
	ep := os.Getenv("SQS_ENDPOINT")
	if ep == "" {
		t.Skip("SQS_ENDPOINT not set; LocalStack test skipped")
	}
	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		t.Fatal(err)
	}
	client := sqs.NewFromConfig(cfg, func(o *sqs.Options) { o.BaseEndpoint = aws.String(ep) })
	out, err := client.CreateQueue(ctx, &sqs.CreateQueueInput{
		QueueName:  aws.String(fmt.Sprintf("go-test-%d", time.Now().UnixNano())),
		Attributes: map[string]string{"VisibilityTimeout": "30"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = client.DeleteQueue(context.Background(), &sqs.DeleteQueueInput{QueueUrl: out.QueueUrl}) })
	return NewSQS(client, *out.QueueUrl)
}

func TestSQSRoundTripWithAttributesAndReceiveCount(t *testing.T) {
	q := newTestQueue(t)
	ctx := context.Background()
	if err := q.Send(ctx, `{"hello":1}`, map[string]string{"tenant_id": "t1", "traceparent": "00-abc"}); err != nil {
		t.Fatal(err)
	}
	msgs, err := q.Receive(ctx, 10, 2*time.Second)
	if err != nil || len(msgs) != 1 {
		t.Fatalf("receive: %v, %d msgs", err, len(msgs))
	}
	m := msgs[0]
	if m.Body != `{"hello":1}` || m.Attributes["tenant_id"] != "t1" || m.Attributes["traceparent"] != "00-abc" || m.ReceiveCount != 1 {
		t.Fatalf("got %+v", m)
	}

	// Make it visible again at once: the next receive is delivery #2.
	if err := q.ChangeVisibility(ctx, m.ReceiptHandle, 0); err != nil {
		t.Fatal(err)
	}
	msgs, err = q.Receive(ctx, 10, 2*time.Second)
	if err != nil || len(msgs) != 1 || msgs[0].ReceiveCount != 2 {
		t.Fatalf("redelivery: %v, %+v", err, msgs)
	}
	if err := q.Delete(ctx, msgs[0].ReceiptHandle); err != nil {
		t.Fatal(err)
	}
	msgs, _ = q.Receive(ctx, 10, time.Second)
	if len(msgs) != 0 {
		t.Fatalf("deleted message came back: %+v", msgs)
	}
}
