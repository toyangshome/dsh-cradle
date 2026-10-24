// Package config loads server configuration from the environment.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the complete runtime configuration.
type Config struct {
	Addr            string
	DatabaseURL     string
	RedisURL        string
	Token           string
	AdminToken      string
	AdminGenerated  bool
	MaxConns        int32
	MaxBodyBytes    int64
	ReadTimeout     time.Duration
	WriteTimeout    time.Duration
	IdleTimeout     time.Duration
	ShutdownTimeout time.Duration
	AutoMigrate     bool
	LogLevel        string
	Version         string
	// StunAddr is the UDP address the built-in STUN server binds. Empty disables
	// STUN, which leaves panels with host candidates only.
	StunAddr string
	// VisitsEnabled turns the WebRTC signalling and relay on.
	VisitsEnabled bool
}

// Load reads configuration from the environment, applying production-safe
// defaults for local development.
func Load() (Config, error) {
	cfg := Config{
		Addr:            env("CRADLE_ADDR", ":8789"),
		DatabaseURL:     env("DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/cradle?sslmode=disable"),
		RedisURL:        env("REDIS_URL", "redis://127.0.0.1:6379/0"),
		Token:           env("CRADLE_TOKEN", ""),
		AdminToken:      env("CRADLE_ADMIN_TOKEN", ""),
		MaxConns:        int32(envInt("CRADLE_DB_MAX_CONNS", 20)),
		MaxBodyBytes:    int64(envInt("CRADLE_MAX_BODY_BYTES", 256*1024)),
		ReadTimeout:     envDuration("CRADLE_READ_TIMEOUT", 15*time.Second),
		WriteTimeout:    envDuration("CRADLE_WRITE_TIMEOUT", 20*time.Second),
		IdleTimeout:     envDuration("CRADLE_IDLE_TIMEOUT", 60*time.Second),
		ShutdownTimeout: envDuration("CRADLE_SHUTDOWN_TIMEOUT", 15*time.Second),
		AutoMigrate:     envBool("CRADLE_AUTO_MIGRATE", true),
		LogLevel:        env("CRADLE_LOG_LEVEL", "info"),
		Version:         env("CRADLE_VERSION", "dev"),
		StunAddr:        env("CRADLE_STUN_ADDR", ":3478"),
		VisitsEnabled:   envBool("CRADLE_VISITS", true),
	}

	if cfg.AdminToken == "" {
		token, err := randomToken()
		if err != nil {
			return Config{}, fmt.Errorf("generate admin token: %w", err)
		}
		cfg.AdminToken = token
		cfg.AdminGenerated = true
	}
	if cfg.MaxConns < 1 {
		cfg.MaxConns = 1
	}
	return cfg, nil
}

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && strings.TrimSpace(v) != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	raw, ok := os.LookupEnv(key)
	if !ok {
		return fallback
	}
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return fallback
	}
	return n
}

func envBool(key string, fallback bool) bool {
	raw, ok := os.LookupEnv(key)
	if !ok {
		return fallback
	}
	b, err := strconv.ParseBool(strings.TrimSpace(raw))
	if err != nil {
		return fallback
	}
	return b
}

func envDuration(key string, fallback time.Duration) time.Duration {
	raw, ok := os.LookupEnv(key)
	if !ok {
		return fallback
	}
	d, err := time.ParseDuration(strings.TrimSpace(raw))
	if err != nil {
		return fallback
	}
	return d
}

func randomToken() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
