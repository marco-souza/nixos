package app

import (
	"fmt"
	"os"
	"regexp"

	"github.com/marco-souza/nixos/stow/factory/internal/deps"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/machine"
	"github.com/marco-souza/nixos/stow/factory/internal/proc"
	"github.com/marco-souza/nixos/stow/factory/internal/ui"
)

var jobID = regexp.MustCompile(`^[A-Za-z0-9][\w.-]*$`)

// findJob loads job id. The id becomes a path, so anything but a plain name
// is no job.
func findJob(repo, id string) (job.Job, error) {
	file := job.NewPaths(repo, id).JobFile
	if _, err := os.Stat(file); !jobID.MatchString(id) || err != nil {
		return job.Job{}, &machine.CommandError{Msg: fmt.Sprintf("no job %s (see: factory status)", id)}
	}
	return job.Load(file)
}

// transition applies a human command to the saved job (read fresh), lets
// patch adjust the result, saves it and logs it to activity.log.
func transition(repo, id string, c machine.Command, d deps.Deps, patch func(*job.Job)) (job.Job, error) {
	cur, err := findJob(repo, id)
	if err != nil {
		return job.Job{}, err
	}
	next, err := machine.Apply(cur, c, d.Now())
	if err != nil {
		return job.Job{}, err
	}
	if patch != nil {
		patch(&next)
	}
	paths := job.NewPaths(repo, id)
	if err := job.Save(paths.JobFile, &next, d.Now()); err != nil {
		return job.Job{}, err
	}
	line := fmt.Sprintf("%s: %s → %s", c.Kind, cur.Stage, next.Stage)
	return next, job.AppendActivity(paths.ActivityLog, line, d.Now())
}

// driverCommand is what the background driver runs: --here drives the job in
// that process.
func driverCommand(self, repo, id string) string {
	return proc.Shq(self) + " run " + proc.Shq(id) + " --here --repo " + proc.Shq(repo)
}

// restartDriver starts, or restarts, the job's driver in the background.
func restartDriver(j job.Job, d deps.Deps, repo string) error {
	return d.Spawner.RespawnDriver(j.ID, j.Worktree, driverCommand(d.Self, repo, j.ID))
}

// Ok is a green check line, for progress output.
func Ok(s string) string { return ui.Paint(ui.Green, "✓") + " " + s }

// Failed is a red cross line, for progress output.
func Failed(s string) string { return ui.Paint(ui.Red, "✗ "+s) }

// Find is job id, or a *machine.CommandError when there is none.
func Find(repo, id string) (job.Job, error) { return findJob(repo, id) }
