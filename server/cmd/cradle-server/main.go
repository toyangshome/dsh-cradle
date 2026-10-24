// Command cradle-server runs the Cradle Discovery Server.
//
// It is a drop-in replacement for server/cradle-server.mjs: same /v1 wire
// protocol, same economy, but state lives in PostgreSQL and presence, rate
// limits and idempotency live in Redis.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"cradle.local/server/internal/api"
	"cradle.local/server/internal/cache"
	"cradle.local/server/internal/config"
	"cradle.local/server/internal/rtc"
	"cradle.local/server/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "cradle-server: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	var (
		addr        = flag.String("addr", cfg.Addr, "listen address, e.g. :8789")
		port        = flag.Int("port", 0, "listen port (overrides -addr)")
		databaseURL = flag.String("db", cfg.DatabaseURL, "PostgreSQL connection URL")
		redisURL    = flag.String("redis", cfg.RedisURL, "Redis connection URL")
		token       = flag.String("token", cfg.Token, "shared token required from clients (empty disables auth)")
		adminToken  = flag.String("admin-token", cfg.AdminToken, "operator token for /admin")
		migrateOnly = flag.Bool("migrate", false, "apply migrations and exit")
		showVersion = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()

	if *showVersion {
		fmt.Println(cfg.Version)
		return nil
	}
	if *port > 0 {
		*addr = fmt.Sprintf(":%d", *port)
	}
	cfg.Addr = *addr
	cfg.DatabaseURL = *databaseURL
	cfg.RedisURL = *redisURL
	cfg.Token = *token
	cfg.AdminToken = *adminToken

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: parseLevel(cfg.LogLevel)}))
	slog.SetDefault(logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, cfg.DatabaseURL, cfg.MaxConns)
	if err != nil {
		return err
	}
	defer st.Close()

	if err := st.Migrate(ctx); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	if *migrateOnly {
		logger.Info("migrations applied")
		return nil
	}

	ch, err := cache.Open(ctx, cfg.RedisURL)
	if err != nil {
		logger.Warn("redis unavailable, running in degraded mode", "error", err)
		ch = nil
	} else {
		defer ch.Close()
	}

	// The visit exchange and the STUN server are both disposable: a restart
	// ends every visit in flight, and nothing about a room is ever stored here.
	var exchange *rtc.Exchange
	if cfg.VisitsEnabled {
		exchange = rtc.NewExchange(logger)
		defer exchange.Close()
	}

	handler := api.New(cfg, st, ch, logger, exchange)
	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       cfg.ReadTimeout,
		WriteTimeout:      cfg.WriteTimeout,
		IdleTimeout:       cfg.IdleTimeout,
	}

	logger.Info("cradle discovery server listening",
		"addr", cfg.Addr,
		"version", cfg.Version,
		"auth", cfg.Token != "",
		"redis", ch != nil,
	)
	logger.Info("admin console", "url", "http://127.0.0.1"+cfg.Addr+"/admin")
	if cfg.AdminGenerated {
		logger.Info("generated admin token (set CRADLE_ADMIN_TOKEN to pin it)", "token", cfg.AdminToken)
	}

	errCh := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	// STUN is the UDP half of the same deployment. It only ever answers binding
	// requests, so it needs no auth and shares the process lifetime.
	stunCh := make(chan error, 1)
	if cfg.VisitsEnabled && cfg.StunAddr != "" {
		go func() { stunCh <- rtc.ListenAndServe(ctx, cfg.StunAddr, logger) }()
	}

	select {
	case err := <-errCh:
		return err
	case err := <-stunCh:
		return err
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	logger.Info("shutting down")
	if err := server.Shutdown(shutdownCtx); err != nil {
		return err
	}
	return nil
}

func parseLevel(raw string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
