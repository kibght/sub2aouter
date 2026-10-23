//go:build embed || unit

package web

import "strings"

const canvasAppPathPrefix = "/canvas-app"

func resolveEmbeddedSPARequest(requestPath string) (indexPath string, canvas bool) {
	trimmed := strings.TrimSpace(requestPath)
	if trimmed == canvasAppPathPrefix || strings.HasPrefix(trimmed, canvasAppPathPrefix+"/") {
		return "canvas-app/index.html", true
	}
	return "index.html", false
}
