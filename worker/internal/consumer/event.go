package consumer

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
)

const EventOrderCreated = "order.created"

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// PermanentError marks a message that can never succeed (malformed, unknown
// type). It goes to the DLQ on first failure instead of burning retries.
type PermanentError struct{ Err error }

func (e PermanentError) Error() string { return "permanent: " + e.Err.Error() }
func (e PermanentError) Unwrap() error { return e.Err }

func permanent(format string, a ...any) error {
	return PermanentError{Err: fmt.Errorf(format, a...)}
}

func IsPermanent(err error) bool {
	var p PermanentError
	return errors.As(err, &p)
}

// Event is the envelope the API's outbox relay publishes.
type Event struct {
	EventID   string `json:"event_id"`
	EventType string `json:"event_type"`
	TenantID  string `json:"tenant_id"`
	Data      struct {
		OrderID string `json:"order_id"`
	} `json:"data"`
}

// ParseEvent validates the body against the envelope and the tenant_id
// message attribute. The two must agree: a body claiming one tenant inside a
// message routed as another is rejected rather than trusted.
func ParseEvent(body string, attrs map[string]string) (Event, error) {
	var ev Event
	if err := json.Unmarshal([]byte(body), &ev); err != nil {
		return ev, permanent("malformed body: %v", err)
	}
	switch {
	case ev.EventType != EventOrderCreated:
		return ev, permanent("unknown event_type %q", ev.EventType)
	case !uuidRe.MatchString(ev.EventID):
		return ev, permanent("invalid event_id")
	case !uuidRe.MatchString(ev.TenantID):
		return ev, permanent("invalid tenant_id")
	case attrs["tenant_id"] != ev.TenantID:
		return ev, permanent("tenant_id attribute does not match body")
	case !uuidRe.MatchString(ev.Data.OrderID):
		return ev, permanent("invalid order_id")
	}
	return ev, nil
}
