package consumer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/the-vishal-kumar/multi-tenant-event-driven-ref/worker/internal/queue"
)

const (
	tenantA = "0b8c2d36-6a52-4a3f-9d0e-6f1b9a1c2d3e"
	tenantB = "5e7f9a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b"
	orderA  = "9f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f"
)

// fakeQueue records what the consumer did to it.
type fakeQueue struct {
	mu         sync.Mutex
	pending    []queue.Message
	sent       []queue.Message
	deleted    []string
	visibility map[string]time.Duration
	sendErr    error
}

func (q *fakeQueue) Receive(_ context.Context, limit int, _ time.Duration) ([]queue.Message, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	n := min(limit, len(q.pending))
	out := q.pending[:n]
	q.pending = q.pending[n:]
	return out, nil
}

func (q *fakeQueue) Delete(_ context.Context, rh string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.deleted = append(q.deleted, rh)
	return nil
}

func (q *fakeQueue) ChangeVisibility(_ context.Context, rh string, d time.Duration) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.visibility == nil {
		q.visibility = map[string]time.Duration{}
	}
	q.visibility[rh] = d
	return nil
}

func (q *fakeQueue) Send(_ context.Context, body string, attrs map[string]string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.sendErr != nil {
		return q.sendErr
	}
	q.sent = append(q.sent, queue.Message{Body: body, Attributes: attrs})
	return nil
}

// fakeStore is an idempotent applier that can fail the first N calls.
type fakeStore struct {
	mu       sync.Mutex
	seen     map[string]bool
	applied  int
	failNext int
	err      error
}

func (s *fakeStore) ConfirmOrder(_ context.Context, _, eventID, _ string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failNext > 0 {
		s.failNext--
		return false, s.err
	}
	if s.seen == nil {
		s.seen = map[string]bool{}
	}
	if s.seen[eventID] {
		return true, nil
	}
	s.seen[eventID] = true
	s.applied++
	return false, nil
}

func newConsumer(st Applier) (*Consumer, *fakeQueue, *fakeQueue) {
	main, dlq := &fakeQueue{}, &fakeQueue{}
	return &Consumer{
		Queue: main, DLQ: dlq, Store: st,
		MaxAttempts: 4, BackoffBase: time.Second, BackoffMax: 30 * time.Second,
		Log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		Jitter: func(d time.Duration) time.Duration { return d },
	}, main, dlq
}

func message(eventID string, attempt int) queue.Message {
	return queue.Message{
		ID:            "msg-" + eventID,
		ReceiptHandle: fmt.Sprintf("rh-%s-%d", eventID, attempt),
		Body: fmt.Sprintf(`{"event_id":%q,"event_type":"order.created","tenant_id":%q,"data":{"order_id":%q}}`,
			eventID, tenantA, orderA),
		Attributes:   map[string]string{"tenant_id": tenantA, "event_id": eventID},
		ReceiveCount: attempt,
	}
}

const ev1 = "11111111-1111-4111-8111-111111111111"

func TestProcessesAndDeletes(t *testing.T) {
	st := &fakeStore{}
	c, main, dlq := newConsumer(st)
	if got := c.Handle(context.Background(), message(ev1, 1)); got != Processed {
		t.Fatalf("outcome = %s, want processed", got)
	}
	if st.applied != 1 || len(main.deleted) != 1 || len(dlq.sent) != 0 {
		t.Fatalf("applied=%d deleted=%d dlq=%d", st.applied, len(main.deleted), len(dlq.sent))
	}
}

func TestDuplicateDeliveryAppliesOnce(t *testing.T) {
	st := &fakeStore{}
	c, main, _ := newConsumer(st)
	c.Handle(context.Background(), message(ev1, 1))
	if got := c.Handle(context.Background(), message(ev1, 1)); got != Duplicate {
		t.Fatalf("second delivery outcome = %s, want duplicate", got)
	}
	if st.applied != 1 {
		t.Fatalf("applied %d times, want 1", st.applied)
	}
	if len(main.deleted) != 2 {
		t.Fatalf("duplicate must still be deleted from the queue; deleted=%d", len(main.deleted))
	}
}

func TestTransientFailureRetriesWithBackoffThenSucceeds(t *testing.T) {
	st := &fakeStore{failNext: 2, err: errors.New("connection reset")}
	c, main, dlq := newConsumer(st)
	want := []Outcome{Retried, Retried, Processed}
	for attempt := 1; attempt <= 3; attempt++ {
		m := message(ev1, attempt)
		if got := c.Handle(context.Background(), m); got != want[attempt-1] {
			t.Fatalf("attempt %d: outcome = %s, want %s", attempt, got, want[attempt-1])
		}
	}
	// base 1s, doubling: 1s after the first failure, 2s after the second.
	if d := main.visibility["rh-"+ev1+"-1"]; d != time.Second {
		t.Errorf("backoff after attempt 1 = %s, want 1s", d)
	}
	if d := main.visibility["rh-"+ev1+"-2"]; d != 2*time.Second {
		t.Errorf("backoff after attempt 2 = %s, want 2s", d)
	}
	if st.applied != 1 || len(dlq.sent) != 0 {
		t.Fatalf("applied=%d dlq=%d", st.applied, len(dlq.sent))
	}
}

func TestDeadLettersAfterMaxAttempts(t *testing.T) {
	st := &fakeStore{failNext: 100, err: errors.New("order not found in tenant")}
	c, main, dlq := newConsumer(st)
	for attempt := 1; attempt < c.MaxAttempts; attempt++ {
		if got := c.Handle(context.Background(), message(ev1, attempt)); got != Retried {
			t.Fatalf("attempt %d: outcome = %s, want retried", attempt, got)
		}
	}
	if got := c.Handle(context.Background(), message(ev1, c.MaxAttempts)); got != DeadLettered {
		t.Fatalf("final attempt outcome = %s, want dead_lettered", got)
	}
	if len(dlq.sent) != 1 {
		t.Fatalf("dlq has %d messages, want 1", len(dlq.sent))
	}
	got := dlq.sent[0].Attributes
	if got[AttrFailedAttempts] != "4" || got[AttrFailureReason] != "order not found in tenant" ||
		got["tenant_id"] != tenantA || got[AttrSourceMessageID] != "msg-"+ev1 {
		t.Fatalf("dlq attributes = %v", got)
	}
	if len(main.deleted) != 1 {
		t.Fatalf("dead-lettered message must be deleted from the source queue")
	}
}

func TestPermanentErrorsSkipRetries(t *testing.T) {
	cases := map[string]queue.Message{
		"malformed json": {ID: "m1", ReceiptHandle: "r1", Body: "{not json", ReceiveCount: 1},
		"unknown type": {ID: "m2", ReceiptHandle: "r2", ReceiveCount: 1,
			Body:       fmt.Sprintf(`{"event_id":%q,"event_type":"order.deleted","tenant_id":%q,"data":{"order_id":%q}}`, ev1, tenantA, orderA),
			Attributes: map[string]string{"tenant_id": tenantA}},
		"tenant attribute mismatch": {ID: "m3", ReceiptHandle: "r3", ReceiveCount: 1,
			Body:       message(ev1, 1).Body,
			Attributes: map[string]string{"tenant_id": tenantB}},
	}
	for name, m := range cases {
		t.Run(name, func(t *testing.T) {
			st := &fakeStore{}
			c, _, dlq := newConsumer(st)
			if got := c.Handle(context.Background(), m); got != DeadLettered {
				t.Fatalf("outcome = %s, want dead_lettered on first attempt", got)
			}
			if st.applied != 0 || len(dlq.sent) != 1 {
				t.Fatalf("applied=%d dlq=%d", st.applied, len(dlq.sent))
			}
		})
	}
}

func TestDLQSendFailureLeavesMessageOnQueue(t *testing.T) {
	c, main, dlq := newConsumer(&fakeStore{})
	dlq.sendErr = errors.New("throttled")
	if got := c.Handle(context.Background(), queue.Message{ID: "m", ReceiptHandle: "r", Body: "x", ReceiveCount: 1}); got != Failed {
		t.Fatalf("outcome = %s, want failed", got)
	}
	if len(main.deleted) != 0 {
		t.Fatal("message must not be deleted when it could not be dead-lettered")
	}
}

func TestBackoffDoublesAndCaps(t *testing.T) {
	c, _, _ := newConsumer(&fakeStore{})
	want := []time.Duration{1, 2, 4, 8, 16, 30, 30}
	for i, w := range want {
		if got := c.Backoff(i + 1); got != w*time.Second {
			t.Errorf("Backoff(%d) = %s, want %s", i+1, got, w*time.Second)
		}
	}
	c.Jitter = nil
	for range 100 {
		if d := c.Backoff(3); d < 2*time.Second || d > 4*time.Second {
			t.Fatalf("jittered Backoff(3) = %s, want within [2s, 4s]", d)
		}
	}
}

func TestRedriveMovesAndStripsFailureAttributes(t *testing.T) {
	dlq, main := &fakeQueue{}, &fakeQueue{}
	for i := range 3 {
		dlq.pending = append(dlq.pending, queue.Message{
			ID: fmt.Sprint(i), ReceiptHandle: fmt.Sprint("rh", i), Body: "b",
			Attributes: map[string]string{"tenant_id": tenantA, "traceparent": "00-x", AttrFailureReason: "boom", AttrFailedAttempts: "4", AttrSourceMessageID: "s"},
		})
	}
	n, err := Redrive(context.Background(), dlq, main, 2)
	if err != nil || n != 2 {
		t.Fatalf("Redrive = %d, %v; want 2, nil", n, err)
	}
	if len(main.sent) != 2 || len(dlq.deleted) != 2 || len(dlq.pending) != 1 {
		t.Fatalf("sent=%d deleted=%d left=%d", len(main.sent), len(dlq.deleted), len(dlq.pending))
	}
	attrs := main.sent[0].Attributes
	if _, ok := attrs[AttrFailureReason]; ok || attrs["tenant_id"] != tenantA || attrs["traceparent"] != "00-x" {
		t.Fatalf("redriven attributes = %v", attrs)
	}
}

func TestContinuesTraceFromMessageAttributes(t *testing.T) {
	prevTP, prevProp := otel.GetTracerProvider(), otel.GetTextMapPropagator()
	t.Cleanup(func() { otel.SetTracerProvider(prevTP); otel.SetTextMapPropagator(prevProp) })
	rec := tracetest.NewSpanRecorder()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec)))
	otel.SetTextMapPropagator(propagation.TraceContext{})

	c, _, _ := newConsumer(&fakeStore{})
	m := message(ev1, 1)
	m.Attributes["traceparent"] = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	c.Handle(context.Background(), m)

	spans := rec.Ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	s := spans[0]
	if s.SpanContext().TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" ||
		s.Parent().SpanID().String() != "00f067aa0ba902b7" {
		t.Fatalf("span not parented by the message's traceparent: trace=%s parent=%s",
			s.SpanContext().TraceID(), s.Parent().SpanID())
	}
}
