package consumer

import "testing"

func TestParseEventAcceptsValidEnvelope(t *testing.T) {
	ev, err := ParseEvent(message(ev1, 1).Body, map[string]string{"tenant_id": tenantA})
	if err != nil {
		t.Fatal(err)
	}
	if ev.EventID != ev1 || ev.TenantID != tenantA || ev.Data.OrderID != orderA {
		t.Fatalf("parsed %+v", ev)
	}
}

func TestParseEventRejectsBadIDsAsPermanent(t *testing.T) {
	for _, body := range []string{
		`{"event_id":"x","event_type":"order.created","tenant_id":"` + tenantA + `","data":{"order_id":"` + orderA + `"}}`,
		`{"event_id":"` + ev1 + `","event_type":"order.created","tenant_id":"` + tenantA + `","data":{"order_id":"1; DROP TABLE"}}`,
		`{"event_id":"` + ev1 + `","event_type":"order.created","tenant_id":"","data":{"order_id":"` + orderA + `"}}`,
	} {
		if _, err := ParseEvent(body, map[string]string{"tenant_id": tenantA}); !IsPermanent(err) {
			t.Errorf("ParseEvent(%s) err = %v, want permanent", body, err)
		}
	}
}
