// OpenTelemetry SDK for Go: one OTLP/HTTP (protobuf) metrics export per repetition, each
// with its own exporter and its own host name, with the exporter's default settings.
// Usage: export '<case as JSON>'   Prints one line: RESULT <json>.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

type testCase struct {
	Hosts     []string `json:"hosts"`
	Port      int      `json:"port"`
	StaggerMs int      `json:"staggerMs"`
	OffsetsMs []int    `json:"offsetsMs"`
}

type send struct {
	T0        int64  `json:"t0"`
	Outcome   string `json:"outcome"`
	ElapsedMs int64  `json:"elapsedMs"`
	Error     string `json:"error,omitempty"`
}

type repetition struct {
	Host string `json:"host"`
	send
	Sends []send `json:"sends,omitempty"`
}

func sendOnce(
	ctx context.Context, exporter sdkmetric.Exporter, data *metricdata.ResourceMetrics,
) send {
	start := time.Now()
	result := send{T0: start.UnixMilli(), Outcome: "ok"}
	err := exporter.Export(ctx, data)
	result.ElapsedMs = time.Since(start).Milliseconds()
	if err != nil {
		result.Outcome = "error"
		result.Error = err.Error()
	}
	return result
}

func exportOnce(ctx context.Context, host string, port int, offsetsMs []int) repetition {
	rep := repetition{Host: host}
	rep.Outcome = "error"
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	counter, err := provider.Meter("check-07").Int64Counter("check07.requests")
	if err != nil {
		rep.Error = err.Error()
		return rep
	}
	counter.Add(ctx, 1)
	var collected metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &collected); err != nil {
		rep.Error = err.Error()
		return rep
	}
	url := fmt.Sprintf("http://%s:%d/v1/metrics", host, port)
	exporter, err := otlpmetrichttp.New(ctx, otlpmetrichttp.WithEndpointURL(url))
	if err != nil {
		rep.Error = err.Error()
		return rep
	}
	if len(offsetsMs) == 0 {
		rep.send = sendOnce(ctx, exporter, &collected)
		return rep
	}
	// The same exporter sends again later, on whatever connection it kept.
	start := time.Now()
	for _, offset := range offsetsMs {
		time.Sleep(time.Until(start.Add(time.Duration(offset) * time.Millisecond)))
		rep.Sends = append(rep.Sends, sendOnce(ctx, exporter, &collected))
	}
	rep.Outcome = ""
	return rep
}

func main() {
	var input testCase
	if err := json.Unmarshal([]byte(os.Args[1]), &input); err != nil {
		panic(err)
	}
	reps := make([]repetition, len(input.Hosts))
	var wait sync.WaitGroup
	for index, host := range input.Hosts {
		wait.Add(1)
		go func() {
			defer wait.Done()
			reps[index] = exportOnce(context.Background(), host, input.Port, input.OffsetsMs)
		}()
		time.Sleep(time.Duration(input.StaggerMs) * time.Millisecond)
	}
	wait.Wait()
	out, err := json.Marshal(map[string]any{"reps": reps})
	if err != nil {
		panic(err)
	}
	fmt.Println("RESULT " + string(out))
}
