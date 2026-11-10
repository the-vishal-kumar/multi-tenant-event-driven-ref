// Package store applies order events to Postgres. Every write runs in a
// transaction with a transaction-local tenant setting, so the row-level
// security policies scope it to the message's tenant.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrOrderNotFound means the order is not visible in the message's tenant:
// it does not exist, or it belongs to another tenant.
var ErrOrderNotFound = errors.New("order not found in tenant")

type Store struct{ pool *pgxpool.Pool }

// Open connects as the worker role and waits up to 30s for the database.
func Open(ctx context.Context, dsn string, maxConns int32) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	cfg.MaxConns = maxConns
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	wait, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for {
		if err = pool.Ping(wait); err == nil {
			return &Store{pool: pool}, nil
		}
		select {
		case <-wait.Done():
			pool.Close()
			return nil, fmt.Errorf("database not reachable: %w", err)
		case <-time.After(time.Second):
		}
	}
}

func (s *Store) Close() { s.pool.Close() }

// ConfirmOrder records eventID in the dedupe table and confirms the order, in
// one transaction. If eventID was already recorded it only bumps the
// duplicate counter and returns duplicate=true: the side effect is applied at
// most once per event no matter how often the queue delivers it.
func (s *Store) ConfirmOrder(ctx context.Context, tenantID, eventID, orderID string) (duplicate bool, err error) {
	err = s.inTenant(ctx, tenantID, func(tx pgx.Tx) error {
		var inserted bool
		// xmax = 0 only for a freshly inserted row, not an updated one.
		if err := tx.QueryRow(ctx,
			`INSERT INTO processed_messages (event_id, tenant_id, order_id)
			 VALUES ($1, app_tenant_id(), $2)
			 ON CONFLICT (event_id) DO UPDATE
			   SET duplicate_deliveries = processed_messages.duplicate_deliveries + 1
			 RETURNING (xmax = 0)`, eventID, orderID).Scan(&inserted); err != nil {
			return err
		}
		if !inserted {
			duplicate = true
			return nil
		}
		tag, err := tx.Exec(ctx,
			`UPDATE orders SET status = 'confirmed', processed_at = coalesce(processed_at, now())
			  WHERE id = $1`, orderID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return ErrOrderNotFound // rolls back the dedupe row too
		}
		return nil
	})
	return duplicate, err
}

func (s *Store) inTenant(ctx context.Context, tenantID string, fn func(pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
