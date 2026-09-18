package service

import (
	"context"
	"testing"
	"time"
)

func TestGatewayRequestCancellerCancelsOnlyTargetUser(t *testing.T) {
	canceller := NewGatewayRequestCanceller()
	ctxA, releaseA := canceller.Register(context.Background(), 11)
	defer releaseA()
	ctxB, releaseB := canceller.Register(context.Background(), 11)
	defer releaseB()
	ctxOther, releaseOther := canceller.Register(context.Background(), 12)
	defer releaseOther()

	canceller.CancelUser(11)
	if ctxA.Err() == nil || ctxB.Err() == nil {
		t.Fatal("expected all target-user requests to be cancelled")
	}
	if !IsGatewayBalanceOverdraft(ctxA) || !IsGatewayBalanceOverdraft(ctxB) {
		t.Fatal("expected overdraft cancellation cause")
	}
	if ctxOther.Err() != nil {
		t.Fatal("cancelling one user must not cancel another user")
	}
}

func TestOverdraftCancellationKeepsUpstreamContextCancellable(t *testing.T) {
	canceller := NewGatewayRequestCanceller()
	ctx, release := canceller.Register(context.Background(), 31)
	defer release()
	upstream, cancel := detachStreamUpstreamContext(ctx, true)
	defer cancel()
	canceller.CancelUser(31)
	select {
	case <-upstream.Done():
	case <-time.After(time.Second):
		t.Fatal("overdraft cancellation must reach the upstream context")
	}
	if !IsGatewayBalanceOverdraft(upstream) {
		t.Fatal("overdraft cancellation must reach the upstream context")
	}
}

func TestGatewayRequestCancellerUnregistersRequest(t *testing.T) {
	canceller := NewGatewayRequestCanceller()
	ctx, release := canceller.Register(context.Background(), 21)
	release()
	canceller.CancelUser(21)
	select {
	case <-ctx.Done():
	case <-time.After(100 * time.Millisecond):
		t.Fatal("release must cancel the derived request context")
	}
	if len(canceller.entries) != 0 {
		t.Fatalf("released request remained registered: %#v", canceller.entries)
	}
}
