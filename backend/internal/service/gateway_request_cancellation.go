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

type gatewayRequestCancellationKey struct{}

// gatewayUpstreamContext uses the request's independent lifecycle token for
// cancellation while retaining values added anywhere along the request chain.
// Looking up cancellation values on Context first also preserves context.Cause.
type gatewayUpstreamContext struct {
	context.Context
	values context.Context
}

func (c gatewayUpstreamContext) Value(key any) any {
	if value := c.Context.Value(key); value != nil {
		return value
	}
	return c.values.Value(key)
}

func gatewayRequestCancellationContext(ctx context.Context) context.Context {
	if ctx == nil {
		return nil
	}
	token, _ := ctx.Value(gatewayRequestCancellationKey{}).(context.Context)
	return token
}

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
	// This token must outlive an ordinary client disconnect: detached upstream
	// work is still active until authentication's unregister function runs.
	// Keeping it in a context value also survives context.WithoutCancel.
	token, cancelToken := context.WithCancelCause(context.Background())
	ctx, cancelRequest := context.WithCancelCause(context.WithValue(parent, gatewayRequestCancellationKey{}, token))
	cancel := func(cause error) {
		cancelToken(cause)
		cancelRequest(cause)
	}
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
	if ctx == nil {
		return false
	}
	if token := gatewayRequestCancellationContext(ctx); token != nil && errors.Is(context.Cause(token), ErrGatewayBalanceOverdraft) {
		return true
	}
	return errors.Is(context.Cause(ctx), ErrGatewayBalanceOverdraft)
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
