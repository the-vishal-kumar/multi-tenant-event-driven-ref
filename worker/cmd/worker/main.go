// Command worker consumes order events from SQS.
//
//	worker run              consume until SIGTERM (default)
//	worker redrive [-max N] move up to N messages from the DLQ back to the queue
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"

	"github.com/the-vishal-kumar/multi-tenant-event-driven-ref/worker/internal/consumer"
	"github.com/the-vishal-kumar/multi-tenant-event-driven-ref/worker/internal/queue"
	"github.com/the-vishal-kumar/multi-tenant-event-driven-ref/worker/internal/store"
)

const usage = `Usage: worker [command]

Commands:
  run                consume order events until SIGTERM (default)
  redrive [-max N]   move up to N messages (default 100) from the DLQ back to the queue
  help               show this help

Configuration comes from the environment: QUEUE_URL, DLQ_URL,
DATABASE_URL_WORKER (run only), and optionally SQS_ENDPOINT, CONCURRENCY,
MAX_ATTEMPTS, BACKOFF_BASE, BACKOFF_MAX, OTEL_EXPORTER_OTLP_ENDPOINT.
`

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cmd := "run"
	args := os.Args[1:]
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	var err error
	switch cmd {
	case "run":
		err = run(ctx, log)
	case "redrive":
		err = redrive(ctx, log, args)
	case "help", "-h", "-help", "--help":
		fmt.Print(usage)
		return
	default:
		fmt.Fprint(os.Stderr, usage)
		err = fmt.Errorf("unknown command %q", cmd)
	}
	if errors.Is(err, flag.ErrHelp) {
		return // the flag package already printed the usage
	}
	if err != nil {
		log.Error("exit", "err", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, log *slog.Logger) error {
	shutdown, err := setupTracing(ctx)
	if err != nil {
		return err
	}
	defer shutdown()

	main, dlq, err := queues(ctx)
	if err != nil {
		return err
	}
	workers := envInt("CONCURRENCY", 4)
	st, err := store.Open(ctx, mustEnv("DATABASE_URL_WORKER"), int32(workers)+1)
	if err != nil {
		return err
	}
	defer st.Close()

	c := &consumer.Consumer{
		Queue:       main,
		DLQ:         dlq,
		Store:       st,
		MaxAttempts: envInt("MAX_ATTEMPTS", 5),
		BackoffBase: envDuration("BACKOFF_BASE", 2*time.Second),
		BackoffMax:  envDuration("BACKOFF_MAX", 5*time.Minute),
		Log:         log,
	}
	log.Info("worker started", "workers", workers, "max_attempts", c.MaxAttempts, "backoff_base", c.BackoffBase.String())
	c.Run(ctx, workers)
	log.Info("worker stopped")
	return nil
}

func redrive(ctx context.Context, log *slog.Logger, args []string) error {
	fs := flag.NewFlagSet("redrive", flag.ContinueOnError)
	limit := fs.Int("max", 100, "maximum messages to move")
	if err := fs.Parse(args); err != nil {
		return err
	}
	main, dlq, err := queues(ctx)
	if err != nil {
		return err
	}
	n, err := consumer.Redrive(ctx, dlq, main, *limit)
	log.Info("redrive finished", "moved", n)
	fmt.Printf("moved %d message(s) from the DLQ back to the queue\n", n)
	return err
}

func queues(ctx context.Context) (main, dlq *queue.SQS, err error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, nil, err
	}
	client := sqs.NewFromConfig(cfg, func(o *sqs.Options) {
		if ep := os.Getenv("SQS_ENDPOINT"); ep != "" {
			o.BaseEndpoint = aws.String(ep) // LocalStack locally; unset in AWS
		}
	})
	return queue.NewSQS(client, mustEnv("QUEUE_URL")), queue.NewSQS(client, mustEnv("DLQ_URL")), nil
}

// setupTracing exports spans over OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT
// is set. The W3C propagator is installed either way, so trace context in
// message attributes is always honoured.
func setupTracing(ctx context.Context) (func(), error) {
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") == "" {
		return func() {}, nil
	}
	exp, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}
	name := os.Getenv("OTEL_SERVICE_NAME")
	if name == "" {
		name = "orders-worker"
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(resource.NewSchemaless(semconv.ServiceName(name))),
	)
	otel.SetTracerProvider(tp)
	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tp.Shutdown(ctx)
	}, nil
}

func mustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		slog.Error("missing required environment variable", "name", k)
		os.Exit(2)
	}
	return v
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		n, err := strconv.Atoi(v)
		if err == nil && n > 0 {
			return n
		}
		slog.Error("invalid integer, using default", "name", k, "value", v)
	}
	return def
}

func envDuration(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		d, err := time.ParseDuration(v)
		if err == nil && d > 0 {
			return d
		}
		slog.Error("invalid duration, using default", "name", k, "value", v)
	}
	return def
}
