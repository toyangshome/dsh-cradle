# syntax=docker/dockerfile:1

# ---------- build ----------
FROM golang:1.24-alpine AS build
ARG VERSION=dev
ENV CRADLE_VERSION=${VERSION}
WORKDIR /src

# Cache dependencies first.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags "-s -w" \
    -o /out/cradle-server ./cmd/cradle-server

# ---------- runtime ----------
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/cradle-server /usr/local/bin/cradle-server
EXPOSE 8789
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/cradle-server"]
