// Package obs holds the observability primitives: a tiny Prometheus text
// exporter and the structured request logger's helpers.
package obs

import (
	"fmt"
	"io"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Metrics is a dependency-free Prometheus text exporter.
type Metrics struct {
	mu        sync.Mutex
	requests  map[string]int64
	durations map[string]float64
	counters  map[string]int64
	started   time.Time
}

// New creates an empty registry.
func New() *Metrics {
	return &Metrics{
		requests:  map[string]int64{},
		durations: map[string]float64{},
		counters:  map[string]int64{},
		started:   time.Now(),
	}
}

// ObserveRequest records one HTTP request.
func (m *Metrics) ObserveRequest(route, method string, status int, elapsed time.Duration) {
	key := fmt.Sprintf("%s\x00%s\x00%d", route, method, status)
	m.mu.Lock()
	m.requests[key]++
	m.durations[route] += elapsed.Seconds()
	m.mu.Unlock()
}

// Incr adds to a named counter.
func (m *Metrics) Incr(name string, delta int64) {
	m.mu.Lock()
	m.counters[name] += delta
	m.mu.Unlock()
}

// Snapshot returns the current counters (for tests and the console).
func (m *Metrics) Snapshot() map[string]int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]int64, len(m.counters))
	for k, v := range m.counters {
		out[k] = v
	}
	return out
}

// Render writes the Prometheus exposition format.
func (m *Metrics) Render(w io.Writer, gauges map[string]float64) {
	m.mu.Lock()
	requests := make([]string, 0, len(m.requests))
	for k := range m.requests {
		requests = append(requests, k)
	}
	sort.Strings(requests)
	counters := make(map[string]int64, len(m.counters))
	for k, v := range m.counters {
		counters[k] = v
	}
	durations := make(map[string]float64, len(m.durations))
	for k, v := range m.durations {
		durations[k] = v
	}
	m.mu.Unlock()

	fmt.Fprintln(w, "# HELP cradle_http_requests_total HTTP requests handled.")
	fmt.Fprintln(w, "# TYPE cradle_http_requests_total counter")
	for _, key := range requests {
		parts := strings.Split(key, "\x00")
		if len(parts) != 3 {
			continue
		}
		fmt.Fprintf(w, "cradle_http_requests_total{route=%q,method=%q,status=%q} %d\n",
			parts[0], parts[1], parts[2], m.requests[key])
	}

	fmt.Fprintln(w, "# HELP cradle_http_request_seconds_sum Cumulative request time per route.")
	fmt.Fprintln(w, "# TYPE cradle_http_request_seconds_sum counter")
	routes := make([]string, 0, len(durations))
	for route := range durations {
		routes = append(routes, route)
	}
	sort.Strings(routes)
	for _, route := range routes {
		fmt.Fprintf(w, "cradle_http_request_seconds_sum{route=%q} %f\n", route, durations[route])
	}

	names := make([]string, 0, len(counters))
	for name := range counters {
		names = append(names, name)
	}
	sort.Strings(names)
	fmt.Fprintln(w, "# HELP cradle_events_total Domain events.")
	fmt.Fprintln(w, "# TYPE cradle_events_total counter")
	for _, name := range names {
		fmt.Fprintf(w, "cradle_events_total{event=%q} %d\n", name, counters[name])
	}

	gaugeNames := make([]string, 0, len(gauges))
	for name := range gauges {
		gaugeNames = append(gaugeNames, name)
	}
	sort.Strings(gaugeNames)
	fmt.Fprintln(w, "# HELP cradle_gauge Operational gauges.")
	fmt.Fprintln(w, "# TYPE cradle_gauge gauge")
	for _, name := range gaugeNames {
		fmt.Fprintf(w, "cradle_gauge{name=%q} %f\n", name, gauges[name])
	}

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	fmt.Fprintln(w, "# HELP cradle_uptime_seconds Process uptime.")
	fmt.Fprintln(w, "# TYPE cradle_uptime_seconds gauge")
	fmt.Fprintf(w, "cradle_uptime_seconds %f\n", time.Since(m.started).Seconds())
	fmt.Fprintln(w, "# HELP cradle_goroutines Live goroutines.")
	fmt.Fprintln(w, "# TYPE cradle_goroutines gauge")
	fmt.Fprintf(w, "cradle_goroutines %d\n", runtime.NumGoroutine())
	fmt.Fprintln(w, "# HELP cradle_memory_alloc_bytes Heap allocation.")
	fmt.Fprintln(w, "# TYPE cradle_memory_alloc_bytes gauge")
	fmt.Fprintf(w, "cradle_memory_alloc_bytes %d\n", mem.Alloc)
}
