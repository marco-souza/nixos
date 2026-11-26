---
name: go-service-setup
description: Use when creating, restructuring or reviewing a small Go service (HTTP server, reverse proxy, worker) - project layout, config, graceful shutdown, tests, Dockerfile, lint and git hooks. Not for CI/CD pipelines.
---

# Go service setup

Small, stdlib-first Go services. No frameworks, no deps unless forced.

## Layout

```
cmd/<name>/main.go        # thin: build deps, call run(), one os.Exit
internal/config/          # Load(getenv) (Config, error)
internal/<domain>/        # the actual handler/logic, e.g. proxy
internal/server/          # Run(ctx, addr, handler, logger) error
Dockerfile  lefthook.yml  README.md  go.mod
```

- `internal/` for everything; nothing is a public API.
- Split by responsibility. Don't make one-function packages "for later".
- Module path = repo path (`github.com/<org>/<repo>`).

## main

```go
func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return server.Run(ctx, ":"+cfg.Port, handler.New(cfg, logger), logger)
}
```

Return errors upward and exit from one place only. Use `log/slog` JSON. Never log secrets.

## Config

- `Load(getenv func(string) string)` takes `os.Getenv` in prod and a map closure in tests.
- **Make env-specific values required** (origins, tokens, DSNs). A default that points at dev will silently run prod against dev.
- Default only the safe constants (port).
- Validate at load time, e.g. a parsed URL needs a `Scheme` and a `Host`.
- Write table tests for: missing values, invalid values, and the happy path.

## Server

```go
srv := &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 10 * time.Second}
errc := make(chan error, 1)
go func() { errc <- srv.ListenAndServe() }()
select {
case err := <-errc:
	return err
case <-ctx.Done():
}
shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
defer cancel()
return srv.Shutdown(shutdownCtx)
```

- Always set `ReadHeaderTimeout` (gosec flags it if missing).
- Serve `/healthz` locally through `http.ServeMux`, before the catch-all `/`. Keep the mux in its own func so it's testable.

## Reverse proxy (httputil)

- Use `Rewrite` (not `Director`). `r.SetURL(origin)` rewrites the Host too, and `Rewrite` strips hop-by-hop and `X-Forwarded-*` headers.
- Inject auth with `r.Out.Header.Set(...)`. Set, not Add, so a client value can't win.
- Clone `http.DefaultTransport` and set `ResponseHeaderTimeout`. The default never times out.
- In `ErrorHandler`, return silently on `errors.Is(err, context.Canceled)` (the client left). Otherwise log and send 502.
- Test with two `httptest.Server`s (upstream and proxy). Assert the header, Host, path+query and body.

## Dockerfile

```dockerfile
# syntax=docker/dockerfile:1
FROM golang:<ver>-alpine AS builder
WORKDIR /src
COPY go.mod go.sum* ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /app ./cmd/<name>

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=builder /app /app
EXPOSE 4000
ENTRYPOINT ["/app"]
```

- Keep the Go version identical in `go.mod`, the builder image and any lint/test images. Bump them together.
- Prefer runtime env for secrets. If the platform bakes them in via `ARG` + `ENV`, say plainly that anyone who can pull the image can read them.

## Lint and hooks

`lefthook.yml`:

```yaml
pre-commit:
  jobs:
    - name: lint
      glob: "*.go"
      run: gofmt -w {staged_files} && golangci-lint run --fix
      stage_fixed: true
pre-push:
  jobs:
    - name: test
      run: go test ./...
```

- Run `lefthook install` once per clone.
- golangci-lint v2 already includes govet, so don't run `go vet` separately.
- It does **not** check gofmt without a config, so keep the gofmt check.
- On a repo with no commits, the pre-push hook skips ("no matching push files"). Verify it with `lefthook run pre-push --force`.

## Verify before claiming done

```sh
gofmt -l . && go vet ./... && go test ./... && golangci-lint run && go build ./cmd/<name> && docker build .
```

## Gotchas

- `go version`, not `go --version`.
- A `~` inside `KUBECONFIG`/env paths is not expanded. Use `$HOME`.
- Keep README to: what it does, an env var table (mark required), `/healthz`, a run-locally command (`go run ./cmd/<name>`) and hook setup.
