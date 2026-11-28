// Package proc runs external commands and background agent processes.
package proc

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// Opts are the options of one command.
type Opts struct {
	// Dir is the working directory; "" means the current one.
	Dir string
	// Env is added to the process environment.
	Env map[string]string
	// Stdin is the standard input; nil means none.
	Stdin *string
}

// Result is a finished command.
type Result struct {
	Code   int
	Stdout string
	Stderr string
	// Combined holds both streams in the order they were written.
	Combined string
}

// Runner runs a command to completion. The error means only that the command
// could not be started; a non-zero exit is a Result with its Code.
type Runner interface {
	Run(ctx context.Context, argv []string, o Opts) (Result, error)
}

// RealRunner runs commands with os/exec.
type RealRunner struct{}

// lockedBuffer lets stdout and stderr share one buffer.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

// teeWriter writes to its own buffer and to the shared one.
type teeWriter struct {
	own    bytes.Buffer
	shared *lockedBuffer
}

func (w *teeWriter) Write(p []byte) (int, error) {
	w.own.Write(p)
	return w.shared.Write(p)
}

// Run implements Runner.
func (RealRunner) Run(ctx context.Context, argv []string, o Opts) (Result, error) {
	if len(argv) == 0 {
		return Result{}, errors.New("empty command")
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = o.Dir
	if len(o.Env) > 0 {
		cmd.Env = os.Environ()
		for k, v := range o.Env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
	}
	if o.Stdin != nil {
		cmd.Stdin = strings.NewReader(*o.Stdin)
	}
	shared := &lockedBuffer{}
	stdout := &teeWriter{shared: shared}
	stderr := &teeWriter{shared: shared}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	err := cmd.Run()
	r := Result{Stdout: stdout.own.String(), Stderr: stderr.own.String(), Combined: shared.buf.String()}
	var exit *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &exit):
		r.Code = exit.ExitCode()
	default:
		return Result{}, fmt.Errorf("run %s: %w", argv[0], err)
	}
	return r, nil
}

// Check turns a non-zero exit into an *ExitError.
func Check(argv []string, r Result) error {
	if r.Code == 0 {
		return nil
	}
	return &ExitError{Cmd: argv, Code: r.Code, Tail: tail(r.Combined)}
}

// Run runs argv and fails on a non-zero exit.
func Run(ctx context.Context, run Runner, argv []string, o Opts) (Result, error) {
	r, err := run.Run(ctx, argv, o)
	if err != nil {
		return r, err
	}
	return r, Check(argv, r)
}
