// Package queue is the narrow queue interface the worker depends on, with an
// SQS implementation. Tests use an in-memory fake; the SQS implementation is
// tested against LocalStack.
package queue

import (
	"context"
	"time"
)

// Message is one received message.
type Message struct {
	ID            string
	ReceiptHandle string
	Body          string
	Attributes    map[string]string // string message attributes (tenant_id, traceparent, ...)
	ReceiveCount  int               // ApproximateReceiveCount: 1 on first delivery
}

// Queue has SQS semantics: at-least-once delivery, a visibility timeout, and
// redelivery of anything not deleted before that timeout expires.
type Queue interface {
	Receive(ctx context.Context, limit int, wait time.Duration) ([]Message, error)
	Delete(ctx context.Context, receiptHandle string) error
	// ChangeVisibility hides a received message for d before it is redelivered.
	ChangeVisibility(ctx context.Context, receiptHandle string, d time.Duration) error
	Send(ctx context.Context, body string, attributes map[string]string) error
}
