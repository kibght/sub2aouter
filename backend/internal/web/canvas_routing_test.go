//go:build unit

package web

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestResolveEmbeddedSPARequest(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name        string
		requestPath string
		wantIndex   string
		wantCanvas  bool
	}{
		{name: "main route", requestPath: "/dashboard", wantIndex: "index.html", wantCanvas: false},
		{name: "canvas root", requestPath: "/canvas-app/", wantIndex: "canvas-app/index.html", wantCanvas: true},
		{name: "canvas nested route", requestPath: "/canvas-app/canvas/project-1", wantIndex: "canvas-app/index.html", wantCanvas: true},
		{name: "similar prefix", requestPath: "/canvas-application", wantIndex: "index.html", wantCanvas: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			indexPath, canvas := resolveEmbeddedSPARequest(tc.requestPath)
			assert.Equal(t, tc.wantIndex, indexPath)
			assert.Equal(t, tc.wantCanvas, canvas)
		})
	}
}
