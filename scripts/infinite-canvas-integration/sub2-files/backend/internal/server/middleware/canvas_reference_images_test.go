package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestCanvasReferenceImageCSP(t *testing.T) {
	policies := []string{
		config.DefaultCSPPolicy,
		"default-src 'self'; connect-src 'self' https:; img-src 'self' blob: data:",
		"default-src 'self'; connect-src 'self' blob: data:",
		"default-src 'self'",
	}
	for _, policy := range policies {
		for _, route := range []string{"/canvas-app", "/canvas-app/", "/canvas-app/image", "/workspace/canvas", "/canvas-app-other"} {
			t.Run(policy+route, func(t *testing.T) {
				w := httptest.NewRecorder()
				c, _ := gin.CreateTestContext(w)
				c.Request = httptest.NewRequest(http.MethodGet, route, nil)
				SecurityHeaders(config.CSPConfig{Enabled: true, Policy: policy}, nil)(c)
				csp := w.Header().Get("Content-Security-Policy")
				for _, scheme := range []string{"blob:", "data:"} {
					if isCanvasAppRoutePath(c) {
						assert.Equal(t, 1, countDirectiveValue(csp, "connect-src", scheme))
					} else {
						assert.Equal(t, directiveHasValue(policy, "connect-src", scheme), directiveHasValue(csp, "connect-src", scheme))
					}
				}
				assert.True(t, directiveHasValue(csp, "connect-src", "'self'"))
			})
		}
	}
}
