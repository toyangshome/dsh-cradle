package api

import (
	_ "embed"
	"net/http"
	"strings"
)

//go:embed console.html
var consoleHTML []byte

// handleConsole serves the embedded single-page operator console.
func (s *Server) handleConsole(w http.ResponseWriter, r *http.Request) {
	// Unknown admin API paths must stay JSON, not fall through to the console.
	if strings.HasPrefix(r.URL.Path, "/admin/v1/") {
		s.fail(w, http.StatusNotFound, map[string]any{"error": "not-found"})
		return
	}
	w.Header().Set("content-type", "text/html; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(consoleHTML)
}
