package store

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Integration tests against the compose Postgres (migrated). Skipped unless
// DATABASE_URL_WORKER, DATABASE_URL_API and DATABASE_URL_OWNER are set; see
// scripts/test.sh.

func env(t *testing.T, k string) string {
	t.Helper()
	v := os.Getenv(k)
	if v == "" {
		t.Skipf("%s not set; integration test skipped", k)
	}
	return v
}

func uuid() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// queryOne runs sql in its own transaction (with the tenant set, if any) and
// returns the first column of the first row.
func queryOne(t *testing.T, dsn, tenant, sql string, args ...any) string {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if tenant != "" {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenant); err != nil {
			t.Fatal(err)
		}
	}
	var out string
	if err := tx.QueryRow(ctx, sql, args...).Scan(&out); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return out
}

// fixture creates a tenant (as owner) and one pending order (as the API role).
func fixture(t *testing.T) (tenant, order string) {
	tenant = queryOne(t, env(t, "DATABASE_URL_OWNER"), "",
		`INSERT INTO tenants (name) VALUES ($1) RETURNING id::text`, "go-"+uuid()[:8])
	order = queryOne(t, env(t, "DATABASE_URL_API"), tenant,
		`INSERT INTO orders (tenant_id, idempotency_key, request_hash, currency, total_cents, items)
		 VALUES (app_tenant_id(), $1, 'h', 'EUR', 100, '[]') RETURNING id::text`, "k-"+uuid())
	return tenant, order
}

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(context.Background(), env(t, "DATABASE_URL_WORKER"), 20)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func status(t *testing.T, s *Store, tenant, order string) (st string, dups int) {
	t.Helper()
	err := s.inTenant(context.Background(), tenant, func(tx pgx.Tx) error {
		if err := tx.QueryRow(context.Background(), `SELECT status FROM orders WHERE id = $1`, order).Scan(&st); err != nil {
			return err
		}
		return tx.QueryRow(context.Background(),
			`SELECT coalesce(sum(duplicate_deliveries), 0) FROM processed_messages WHERE order_id = $1`, order).Scan(&dups)
	})
	if err != nil {
		t.Fatal(err)
	}
	return st, dups
}

func TestConfirmOrderIsIdempotentPerEvent(t *testing.T) {
	s := open(t)
	tenant, order := fixture(t)
	ev := uuid()
	ctx := context.Background()

	dup, err := s.ConfirmOrder(ctx, tenant, ev, order)
	if err != nil || dup {
		t.Fatalf("first delivery: dup=%v err=%v", dup, err)
	}
	dup, err = s.ConfirmOrder(ctx, tenant, ev, order)
	if err != nil || !dup {
		t.Fatalf("second delivery: dup=%v err=%v, want duplicate", dup, err)
	}
	if st, dups := status(t, s, tenant, order); st != "confirmed" || dups != 1 {
		t.Fatalf("status=%s duplicate_deliveries=%d", st, dups)
	}
}

func TestConcurrentDeliveriesApplyExactlyOnce(t *testing.T) {
	s := open(t)
	tenant, order := fixture(t)
	ev := uuid()
	const n = 16
	var wg sync.WaitGroup
	var mu sync.Mutex
	applied, dups := 0, 0
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			dup, err := s.ConfirmOrder(context.Background(), tenant, ev, order)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err != nil:
				t.Error(err)
			case dup:
				dups++
			default:
				applied++
			}
		}()
	}
	wg.Wait()
	if applied != 1 || dups != n-1 {
		t.Fatalf("applied=%d dups=%d, want 1 and %d", applied, dups, n-1)
	}
}

func TestCrossTenantMessageIsRejectedAndLeavesNoTrace(t *testing.T) {
	s := open(t)
	tenantA, orderA := fixture(t)
	tenantB, _ := fixture(t)
	ev := uuid()

	// A message routed as tenant B that names tenant A's order.
	_, err := s.ConfirmOrder(context.Background(), tenantB, ev, orderA)
	if !errors.Is(err, ErrOrderNotFound) {
		t.Fatalf("err = %v, want ErrOrderNotFound", err)
	}
	if st, _ := status(t, s, tenantA, orderA); st != "pending" {
		t.Fatalf("tenant A's order changed to %s", st)
	}
	// The dedupe row rolled back with it, so a legitimate retry still works.
	var n int
	_ = s.inTenant(context.Background(), tenantB, func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `SELECT count(*) FROM processed_messages WHERE event_id = $1`, ev).Scan(&n)
	})
	if n != 0 {
		t.Fatalf("dedupe row survived a failed transaction")
	}
}
