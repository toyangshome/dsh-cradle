// Package cache wraps Redis: presence, rate limiting, idempotency and hot-card
// caching. Every method is best-effort — PostgreSQL stays authoritative, so a
// Redis outage degrades latency, never correctness.
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Cache is a thin, typed Redis facade.
type Cache struct {
	rdb    *redis.Client
	prefix string
}

// Open connects to Redis and verifies the credentials.
func Open(ctx context.Context, url string) (*Cache, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}
	opts.DialTimeout = 3 * time.Second
	opts.ReadTimeout = 2 * time.Second
	opts.WriteTimeout = 2 * time.Second
	opts.MaxRetries = 2
	rdb := redis.NewClient(opts)
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		rdb.Close()
		return nil, fmt.Errorf("ping redis: %w", err)
	}
	return &Cache{rdb: rdb, prefix: "cradle"}, nil
}

// Close releases the client.
func (c *Cache) Close() error {
	if c == nil {
		return nil
	}
	return c.rdb.Close()
}

// Ping reports Redis health.
func (c *Cache) Ping(ctx context.Context) error {
	return c.rdb.Ping(ctx).Err()
}

func (c *Cache) key(parts ...string) string {
	out := c.prefix
	for _, p := range parts {
		out += ":" + p
	}
	return out
}

// TouchPresence records a heartbeat in Redis with a TTL, so presence expires
// even if the process dies.
func (c *Cache) TouchPresence(ctx context.Context, did string, ttl time.Duration) error {
	now := time.Now()
	pipe := c.rdb.Pipeline()
	pipe.Set(ctx, c.key("presence", did), now.UnixMilli(), ttl)
	pipe.ZAdd(ctx, c.key("online"), redis.Z{Score: float64(now.UnixMilli()), Member: did})
	pipe.ZRemRangeByScore(ctx, c.key("online"), "-inf", fmt.Sprintf("%d", now.Add(-ttl).UnixMilli()))
	_, err := pipe.Exec(ctx)
	return err
}

// DropPresence removes a DID from the online index.
func (c *Cache) DropPresence(ctx context.Context, did string) error {
	pipe := c.rdb.Pipeline()
	pipe.Del(ctx, c.key("presence", did))
	pipe.ZRem(ctx, c.key("online"), did)
	_, err := pipe.Exec(ctx)
	return err
}

// OnlineCount returns the number of DIDs that heartbeated within the TTL.
func (c *Cache) OnlineCount(ctx context.Context, ttl time.Duration) (int64, error) {
	cutoff := time.Now().Add(-ttl).UnixMilli()
	return c.rdb.ZCount(ctx, c.key("online"), fmt.Sprintf("%d", cutoff), "+inf").Result()
}

// rateLimitScript is a fixed-window counter: INCR + expire on first hit.
var rateLimitScript = redis.NewScript(`
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`)

// Allow consumes one token from a fixed window. It returns whether the call is
// allowed and how long the caller should wait when it is not.
func (c *Cache) Allow(ctx context.Context, scope, id string, limit int, window time.Duration) (bool, time.Duration, error) {
	if limit <= 0 {
		return true, 0, nil
	}
	key := c.key("rl", scope, id, fmt.Sprintf("%d", time.Now().Unix()/int64(window.Seconds())))
	res, err := rateLimitScript.Run(ctx, c.rdb, []string{key}, window.Milliseconds()).Int64Slice()
	if err != nil {
		return true, 0, err
	}
	if len(res) < 2 {
		return true, 0, nil
	}
	allowed := res[0] <= int64(limit)
	return allowed, time.Duration(res[1]) * time.Millisecond, nil
}

// MarkOnce returns true the first time a key is seen inside the window. It is
// the idempotency gate for replayed envelopes.
func (c *Cache) MarkOnce(ctx context.Context, key string, ttl time.Duration) (bool, error) {
	return c.rdb.SetNX(ctx, c.key("once", key), 1, ttl).Result()
}

// GetCard reads a cached public card.
func (c *Cache) GetCard(ctx context.Context, did string) (json.RawMessage, bool) {
	raw, err := c.rdb.Get(ctx, c.key("card", did)).Bytes()
	if err != nil {
		return nil, false
	}
	return raw, true
}

// PutCard caches a public card for a short time.
func (c *Cache) PutCard(ctx context.Context, did string, card any, ttl time.Duration) error {
	body, err := json.Marshal(card)
	if err != nil {
		return err
	}
	return c.rdb.Set(ctx, c.key("card", did), body, ttl).Err()
}

// InvalidateCard drops a cached card after a profile update.
func (c *Cache) InvalidateCard(ctx context.Context, did string) error {
	return c.rdb.Del(ctx, c.key("card", did)).Err()
}

// Incr bumps a counter used by the console and /metrics.
func (c *Cache) Incr(ctx context.Context, name string) {
	_ = c.rdb.Incr(ctx, c.key("counter", name)).Err()
}

// GetCounter reads a counter.
func (c *Cache) GetCounter(ctx context.Context, name string) (int64, error) {
	return c.rdb.Get(ctx, c.key("counter", name)).Int64()
}

// TryLock acquires a short-lived mutex (used to serialise the drip sweep).
func (c *Cache) TryLock(ctx context.Context, name string, ttl time.Duration) (bool, error) {
	return c.rdb.SetNX(ctx, c.key("lock", name), 1, ttl).Result()
}

// Flush drops every key in the selected database. Tests and `make reset` only.
func (c *Cache) Flush(ctx context.Context) error {
	return c.rdb.FlushDB(ctx).Err()
}
