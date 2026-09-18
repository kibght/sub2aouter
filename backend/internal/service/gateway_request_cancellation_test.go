package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
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

func TestOverdraftCancellationSurvivesClientDisconnectAndWithoutCancel(t *testing.T) {
	for _, disconnectBeforeDetach := range []bool{false, true} {
		t.Run(map[bool]string{false: "disconnect_after_detach", true: "disconnect_before_detach"}[disconnectBeforeDetach], func(t *testing.T) {
			canceller := NewGatewayRequestCanceller()
			parent, disconnect := context.WithCancel(context.Background())
			defer disconnect()
			request, unregister := canceller.Register(parent, 41)
			defer unregister()
			type requestKey struct{}
			request = context.WithValue(request, requestKey{}, "request-value")
			if disconnectBeforeDetach {
				disconnect()
			}
			upstream, release := detachUpstreamContext(context.WithoutCancel(request))
			// Existing request builders release immediately, before sending.
			release()
			disconnect()
			if upstream.Err() != nil {
				t.Fatal("client disconnect and builder release must not cancel detached work")
			}
			if upstream.Value(requestKey{}) != "request-value" {
				t.Fatal("detached work must retain request values")
			}

			canceller.CancelUser(41)
			if !errors.Is(context.Cause(upstream), ErrGatewayBalanceOverdraft) {
				t.Fatalf("detached work lost overdraft cause: %v", context.Cause(upstream))
			}
			if !IsGatewayBalanceOverdraft(request) {
				t.Fatal("ordinary request cancellation must not mask a later overdraft")
			}
			child, cancelChild := context.WithCancel(upstream)
			defer cancelChild()
			if !errors.Is(context.Cause(child), ErrGatewayBalanceOverdraft) {
				t.Fatalf("downstream contexts lost overdraft cause: %v", context.Cause(child))
			}
		})
	}
}

func TestDetachedGatewayRequestEndsAtUnregister(t *testing.T) {
	canceller := NewGatewayRequestCanceller()
	request, unregister := canceller.Register(context.Background(), 51)
	upstream, release := detachUpstreamContext(request)
	release()
	if upstream.Err() != nil {
		t.Fatal("request builder release must not terminate upstream work")
	}
	unregister()
	unregister()
	if !errors.Is(upstream.Err(), context.Canceled) {
		t.Fatal("unregister must release detached work at the real request boundary")
	}
	if IsGatewayBalanceOverdraft(upstream) {
		t.Fatal("normal completion must not be marked as an overdraft")
	}
	if len(canceller.entries) != 0 {
		t.Fatal("request lifecycle left a cancellation registration behind")
	}

	// A background caller has no request lifecycle to observe. It must not
	// allocate a cancellable context or a watcher that can never complete.
	background, releaseBackground := detachUpstreamContext(context.Background())
	releaseBackground()
	if background.Done() != nil {
		t.Fatal("unregistered background work must remain detached without a watcher")
	}
}

func TestOverdraftCancellationStopsHTTPAfterClientDisconnect(t *testing.T) {
	started := make(chan struct{})
	stopped := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(stopped)
	}))
	defer server.Close()
	canceller := NewGatewayRequestCanceller()
	parent, disconnect := context.WithCancel(context.Background())
	defer disconnect()
	request, unregister := canceller.Register(parent, 61)
	defer unregister()
	upstream, release := detachStreamUpstreamContext(request, true)
	release()
	httpRequest, err := http.NewRequestWithContext(upstream, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() {
		response, requestErr := server.Client().Do(httpRequest)
		if response != nil {
			_ = response.Body.Close()
		}
		finished <- requestErr
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream request did not start")
	}
	disconnect()
	if upstream.Err() != nil {
		t.Fatal("ordinary disconnect unexpectedly stopped upstream work")
	}
	canceller.CancelUser(61)
	select {
	case err := <-finished:
		if !errors.Is(err, ErrGatewayBalanceOverdraft) {
			t.Fatalf("HTTP request did not report overdraft cancellation: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("overdraft did not terminate the upstream HTTP request")
	}
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream server did not observe connection cancellation")
	}
}

func TestDetachedBillingContextSurvivesOverdraftAndUnregister(t *testing.T) {
	canceller := NewGatewayRequestCanceller()
	request, unregister := canceller.Register(context.Background(), 71)
	defer unregister()
	canceller.CancelUser(71)
	billing, release := detachedBillingContext(request)
	defer release()
	unregister()
	if billing.Err() != nil {
		t.Fatal("billing for already consumed usage must survive overdraft and request completion")
	}
	if _, ok := billing.Deadline(); !ok {
		t.Fatal("detached billing must retain its bounded settlement deadline")
	}
}
