GO ?= go
BIN := cradle-server.exe

.PHONY: build tidy fmt vet test test-unit test-integration run migrate docker-up docker-down e2e

build:
	$(GO) build -trimpath -o $(BIN) ./cmd/cradle-server

tidy:
	$(GO) mod tidy

fmt:
	$(GO) fmt ./...

vet:
	$(GO) vet ./...

test: test-unit test-integration

test-unit:
	$(GO) test ./internal/protocol/... -count=1

# Requires CRADLE_TEST_DATABASE_URL and CRADLE_TEST_REDIS_URL.
test-integration:
	$(GO) test ./internal/api/... -count=1

run:
	$(GO) run ./cmd/cradle-server

migrate:
	$(GO) run ./cmd/cradle-server --migrate

docker-up:
	docker compose up -d --build

docker-down:
	docker compose down

# Needs a running server; set CRADLE_URL first.
e2e:
	node ../test/two-agents.mjs
