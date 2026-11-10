// Package consumer turns queue messages into idempotent order updates, with
// retry, backoff and dead-lettering.
package consumer

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"strconv"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/the-vishal-kumar/multi-tenant-event-driven-ref/worker/internal/queue"
)

// Applier applies one event's side effect at most once per event id.
type Applier interface {
	ConfirmOrder(ctx context.Context, tenantID, eventID, orderID string) (duplicate bool, err error)
}

// Outcome is what happened to one message. Tests assert on it.
type Outcome string

const (
	Processed    Outcome = "processed"
	Duplicate    Outcome = "duplicate"
	Retried      Outcome = "retried"       // left on the queue with a backoff delay
	DeadLettered Outcome = "dead_lettered" // copied to the DLQ and removed from the queue
	Failed       Outcome = "failed"        // could not even ack or dead-letter; SQS will redeliver
)

// Attributes the worker adds when it dead-letters a message.
const (
	AttrFailureReason   = "failure_reason"
	AttrFailedAttempts  = "failed_attempts"
	AttrSourceMessageID = "source_message_id"
)

type Consumer struct {
	Queue       queue.Queue
	DLQ         queue.Queue
	Store       Applier
	MaxAttempts int           // deliveries before a retryable failure is dead-lettered
	BackoffBase time.Duration // delay after the first failure
	BackoffMax  time.Duration
	Log         *slog.Logger
	Jitter      func(time.Duration) time.Duration // nil: equal jitter; tests pass identity
}

var tracer = otel.Tracer("orders-worker")

// Backoff is the visibility delay after the nth failed delivery (n >= 1):
// base * 2^(n-1), capped, with jitter so a burst of failures doesn't retry in
// lockstep.
func (c *Consumer) Backoff(n int) time.Duration {
	d := c.BackoffBase << min(n-1, 20)
	if d <= 0 || d > c.BackoffMax {
		d = c.BackoffMax
	}
	if c.Jitter != nil {
		return c.Jitter(d)
	}
	half := d / 2
	return half + rand.N(half+1) //nolint:gosec // jitter, not security
}

// Handle processes one message and always settles it one way or another.
func (c *Consumer) Handle(ctx context.Context, m queue.Message) Outcome {
	ctx = otel.GetTextMapPropagator().Extract(ctx, propagation.MapCarrier(m.Attributes))
	ctx, span := tracer.Start(ctx, EventOrderCreated+" process",
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("messaging.system", "aws_sqs"),
			attribute.String("messaging.operation.type", "process"),
			attribute.String("messaging.message.id", m.ID),
			attribute.Int("messaging.sqs.receive_count", m.ReceiveCount),
			attribute.String("app.tenant_id", m.Attributes["tenant_id"]),
		))
	defer span.End()
	log := c.Log.With("message_id", m.ID, "attempt", m.ReceiveCount, "tenant_id", m.Attributes["tenant_id"])

	dup, err := c.apply(ctx, m, log)
	if err == nil {
		if derr := c.Queue.Delete(ctx, m.ReceiptHandle); derr != nil {
			// The update is committed; a redelivery will be deduped.
			log.Warn("delete after success failed", "err", derr)
		}
		span.SetAttributes(attribute.Bool("app.duplicate", dup))
		if dup {
			return Duplicate
		}
		return Processed
	}

	span.RecordError(err)
	span.SetStatus(codes.Error, err.Error())
	if IsPermanent(err) || m.ReceiveCount >= c.MaxAttempts {
		return c.deadLetter(ctx, m, err, log)
	}
	delay := c.Backoff(m.ReceiveCount)
	log.Warn("processing failed, will retry", "err", err, "delay", delay.String())
	if verr := c.Queue.ChangeVisibility(ctx, m.ReceiptHandle, delay); verr != nil {
		log.Error("change visibility failed", "err", verr)
	}
	return Retried
}

func (c *Consumer) apply(ctx context.Context, m queue.Message, log *slog.Logger) (duplicate bool, err error) {
	ev, err := ParseEvent(m.Body, m.Attributes)
	if err != nil {
		return false, err
	}
	dup, err := c.Store.ConfirmOrder(ctx, ev.TenantID, ev.EventID, ev.Data.OrderID)
	if err != nil {
		return false, err
	}
	if dup {
		log.Info("duplicate delivery skipped", "event_id", ev.EventID)
	} else {
		log.Info("order confirmed", "event_id", ev.EventID, "order_id", ev.Data.OrderID)
	}
	return dup, nil
}

// deadLetter copies the message to the DLQ with the failure reason, then
// deletes it from the source queue. If the delete fails, the copy is already
// safe and SQS's own redrive policy (maxReceiveCount above MaxAttempts) is
// the backstop for a worker that keeps crashing.
func (c *Consumer) deadLetter(ctx context.Context, m queue.Message, cause error, log *slog.Logger) Outcome {
	attrs := make(map[string]string, len(m.Attributes)+3)
	for k, v := range m.Attributes {
		attrs[k] = v
	}
	reason := cause.Error()
	if len(reason) > 256 {
		reason = reason[:256]
	}
	attrs[AttrFailureReason] = reason
	attrs[AttrFailedAttempts] = strconv.Itoa(m.ReceiveCount)
	attrs[AttrSourceMessageID] = m.ID
	if err := c.DLQ.Send(ctx, m.Body, attrs); err != nil {
		log.Error("dead-letter send failed", "err", err)
		return Failed
	}
	if err := c.Queue.Delete(ctx, m.ReceiptHandle); err != nil {
		log.Error("delete after dead-letter failed", "err", err)
	}
	log.Error("message dead-lettered", "reason", reason)
	return DeadLettered
}

// Run polls with `workers` concurrent long-poll loops until ctx is cancelled.
func (c *Consumer) Run(ctx context.Context, workers int) {
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ctx.Err() == nil {
				msgs, err := c.Queue.Receive(ctx, 10, 20*time.Second)
				if err != nil {
					if ctx.Err() == nil {
						c.Log.Error("receive failed", "err", err)
						time.Sleep(time.Second)
					}
					continue
				}
				for _, m := range msgs {
					// Finish in-flight messages even during shutdown.
					c.Handle(context.WithoutCancel(ctx), m)
				}
			}
		}()
	}
	wg.Wait()
}

// Redrive moves up to limit messages from the DLQ back to the main queue,
// dropping the failure attributes. Each moved message starts with a fresh
// receive count. Only messages that were already in the DLQ when Redrive
// started are moved: a message that is still poison gets dead-lettered again
// while the redrive runs, and must not be picked up a second time (that loop
// would spin until the limit). Returns how many were moved.
func Redrive(ctx context.Context, dlq, main queue.Queue, limit int) (int, error) {
	started := time.Now()
	moved := 0
	for moved < limit {
		msgs, err := dlq.Receive(ctx, min(10, limit-moved), time.Second)
		if err != nil {
			return moved, err
		}
		movedNow := 0
		for _, m := range msgs {
			if m.SentAt.After(started) {
				// Arrived after we started: leave it, visible again at once.
				_ = dlq.ChangeVisibility(ctx, m.ReceiptHandle, 0)
				continue
			}
			attrs := make(map[string]string, len(m.Attributes))
			for k, v := range m.Attributes {
				switch k {
				case AttrFailureReason, AttrFailedAttempts, AttrSourceMessageID:
				default:
					attrs[k] = v
				}
			}
			if err := main.Send(ctx, m.Body, attrs); err != nil {
				return moved, err
			}
			if err := dlq.Delete(ctx, m.ReceiptHandle); err != nil {
				return moved, err
			}
			moved++
			movedNow++
		}
		if movedNow == 0 {
			return moved, nil
		}
	}
	return moved, nil
}
