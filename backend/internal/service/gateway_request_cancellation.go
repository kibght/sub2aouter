package service

import (
	"context"
	"errors"
	"sync"
)

// ErrGatewayBalanceOverdraft identifies cancellation caused by a committed
// negative balance. Handlers use the cause to suppress failover and retries;
// ordinary client disconnects keep their existing behavior.
var ErrGatewayBalanceOverdraft = errors.New("gateway request cancelled after balance overdraft")

// GatewayRequestCanceller tracks authenticated gateway requests by user.
// A completed billing transaction can cancel every other in-flight request for
// the same user without affecting requests belonging to other users.
type GatewayRequestCanceller struct {
	mu      sync.Mutex
	nextID  uint64
	entries map[int64]map[uint64]context.CancelCauseFunc
}

func NewGatewayRequestCanceller() *GatewayRequestCanceller {
	return &GatewayRequestCanceller{entries: make(map[int64]map[uint64]context.CancelCauseFunc)}
}

// Register derives a request context and returns an idempotent unregister
// function. The derived context is cancelled when CancelUser is called.
func (c *GatewayRequestCanceller) Register(parent context.Context, userID int64) (context.Context, func()) {
	if c == nil {
		return parent, func() {}
	}
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancelCause(parent)
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	if c.entries[userID] == nil {
		c.entries[userID] = make(map[uint64]context.CancelCauseFunc)
	}
	c.entries[userID][id] = cancel
	c.mu.Unlock()

	var once sync.Once
	return ctx, func() {
		once.Do(func() {
			cancel(nil)
			c.mu.Lock()
			if requests := c.entries[userID]; requests != nil {
				delete(requests, id)
				if len(requests) == 0 {
					delete(c.entries, userID)
				}
			}
			c.mu.Unlock()
		})
	}
}

// CancelUser cancels all currently registered requests for userID. It copies
// the cancel functions before invoking them so cancellation callbacks cannot
// deadlock with request cleanup.
func (c *GatewayRequestCanceller) CancelUser(userID int64) {
	if c == nil {
		return
	}
	c.mu.Lock()
	requests := c.entries[userID]
	cancels := make([]context.CancelCauseFunc, 0, len(requests))
	for _, cancel := range requests {
		cancels = append(cancels, cancel)
	}
	c.mu.Unlock()
	for _, cancel := range cancels {
		cancel(ErrGatewayBalanceOverdraft)
	}
}

func IsGatewayBalanceOverdraft(ctx context.Context) bool {
	return ctx != nil && errors.Is(context.Cause(ctx), ErrGatewayBalanceOverdraft)
}

var defaultGatewayRequestCanceller = NewGatewayRequestCanceller()

// RegisterGatewayRequest registers a request in the process-wide gateway
// cancellation registry used by authentication and billing hot paths.
func RegisterGatewayRequest(parent context.Context, userID int64) (context.Context, func()) {
	return defaultGatewayRequestCanceller.Register(parent, userID)
}

// CancelGatewayRequestsForUser cancels all in-flight gateway requests for a
// user after an overdraft is committed.
func CancelGatewayRequestsForUser(userID int64) {
	defaultGatewayRequestCanceller.CancelUser(userID)
}
