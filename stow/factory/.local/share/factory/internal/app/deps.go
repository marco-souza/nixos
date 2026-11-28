// Package app holds the operations behind the CLI commands: new, answer,
// status, logs, approve, feedback, unblock, run and discard. They return
// results; the cli package prints them.
package app

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"sync"
	"time"

	factory "github.com/marco-souza/nixos/stow/factory"
	"github.com/marco-souza/nixos/stow/factory/internal/deps"
	"github.com/marco-souza/nixos/stow/factory/internal/git"
	"github.com/marco-souza/nixos/stow/factory/internal/proc"
)

// heartbeat is how often a running agent logs a heartbeat line.
const heartbeat = 30 * time.Second

// MakeDeps builds the real set of outside things. inline runs agents in this
// process, to completion, instead of in the background.
func MakeDeps(repo string, inline bool) (deps.Deps, error) {
	self, err := os.Executable()
	if err != nil {
		return deps.Deps{}, fmt.Errorf("find the factory binary: %w", err)
	}
	exec := proc.RealRunner{}
	var spawner proc.Spawner = proc.ProcessSpawner{Repo: repo, Self: self}
	if inline {
		spawner = proc.InlineSpawner{Exec: exec, Self: self}
	}
	var mu sync.Mutex
	return deps.Deps{
		Exec:    exec,
		Spawner: spawner,
		Git:     &git.Git{Exec: exec, Repo: repo},
		GH:      &git.GitHub{Exec: exec, Repo: repo},
		Roles:   factory.Roles,
		Self:    self,
		Notify: func(ctx context.Context, title, msg string) {
			proc.Notify(ctx, exec, runtime.GOOS, os.Stdout, title, msg)
		},
		Now: time.Now,
		Sleep: func(ctx context.Context, d time.Duration) error {
			t := time.NewTimer(d)
			defer t.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-t.C:
				return nil
			}
		},
		Log: func(line string) {
			mu.Lock()
			defer mu.Unlock()
			_, _ = fmt.Fprintln(os.Stdout, line)
		},
		Heartbeat: heartbeat,
	}, nil
}
