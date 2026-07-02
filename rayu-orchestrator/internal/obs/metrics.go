package obs

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics holds the orchestrator's Prometheus collectors and the registry they
// are registered with (Req 21.2). The collectors are declared and registered
// here so /metrics exposes them immediately (initially at zero); the build
// lifecycle records into them in a later task.
type Metrics struct {
	Registry *prometheus.Registry

	// BuildsTotal counts builds by the Terminal_Status they reached.
	BuildsTotal *prometheus.CounterVec
	// Building gauges the number of currently building sandboxes.
	Building prometheus.Gauge
	// Live gauges the number of currently live App_Containers.
	Live prometheus.Gauge
	// BuildDuration observes build-generation duration in seconds.
	BuildDuration prometheus.Histogram
}

const metricNamespace = "rayu_orchestrator"

// NewMetrics declares and registers the collectors against a fresh registry.
func NewMetrics() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		Registry: reg,
		BuildsTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: metricNamespace,
			Name:      "builds_total",
			Help:      "Total builds that reached a terminal status, by terminal_status.",
		}, []string{"terminal_status"}),
		Building: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: metricNamespace,
			Name:      "building",
			Help:      "Number of sandboxes currently in the building status.",
		}),
		Live: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: metricNamespace,
			Name:      "live",
			Help:      "Number of currently live App_Containers.",
		}),
		BuildDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: metricNamespace,
			Name:      "build_duration_seconds",
			Help:      "Build-generation duration in seconds.",
			Buckets:   prometheus.DefBuckets,
		}),
	}
	reg.MustRegister(m.BuildsTotal, m.Building, m.Live, m.BuildDuration)
	return m
}

// Handler returns the HTTP handler that serves the registry in Prometheus text
// exposition format (Req 1.8, 21.2).
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.Registry, promhttp.HandlerOpts{})
}
