// Package deps holds everything the driver and the operations touch outside
// the job folder. Tests swap these for fakes. It is a leaf package so that
// both driver and app can import it.
package deps

import (
	"context"
	"io/fs"
	"time"

	"github.com/marco-souza/nixos/stow/factory/internal/git"
	"github.com/marco-souza/nixos/stow/factory/internal/harness"
	"github.com/marco-souza/nixos/stow/factory/internal/proc"
)

// Deps is the set of outside things. Fields are read-only once a run starts.
type Deps struct {
	// Exec runs every git, gh, hook, setup and notify command.
	Exec    proc.Runner
	Spawner proc.Spawner
	// Git and GH are built on Exec.
	Git *git.Git
	GH  *git.GitHub
	// Roles is the role prompts, rooted at the module folder.
	Roles fs.FS
	// Self is the factory binary: os.Executable() in production, a built
	// binary in tests. Run scripts pipe through it.
	Self string
	// CommandFor replaces the harness command line of an agent. The
	// end-to-end tests use it to run fake agents. Nil: the real command.
	CommandFor func(role string, f harness.Files) string
	Notify     func(ctx context.Context, title, msg string)
	Now        func() time.Time
	Sleep      func(ctx context.Context, d time.Duration) error
	// Log writes one line. It must be safe to call from several goroutines.
	Log func(line string)
	// Heartbeat is how often a running agent logs a heartbeat line; 0 means
	// never.
	Heartbeat time.Duration
}
