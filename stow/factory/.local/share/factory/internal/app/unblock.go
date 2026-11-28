package app

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/marco-souza/nixos/stow/factory/internal/deps"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/machine"
)

// Unblock settles what a failed or blocked step stopped on: the decision goes
// to decision-<k>.md, the step runs again with it as an input (so do all
// later agents), and the driver restarts. Cheaper than feedback, which starts
// a new cycle.
func Unblock(_ context.Context, repo, id, decision string, d deps.Deps) (job.Job, error) {
	text := strings.TrimSpace(decision)
	if text == "" {
		return job.Job{}, &machine.CommandError{Msg: fmt.Sprintf("say what you decided: factory unblock %s \"<decision>\"", id)}
	}
	cur, err := findJob(repo, id)
	if err != nil {
		return job.Job{}, err
	}
	file := job.NewPaths(repo, id).Decision(len(cur.Decisions) + 1)
	// After the transition, so a refused unblock leaves no file behind.
	next, err := transition(repo, id, machine.Command{Kind: machine.CmdUnblock, File: file}, d, nil)
	if err != nil {
		return job.Job{}, err
	}
	if err := os.WriteFile(file, []byte("# Decision for "+id+"\n\n"+text+"\n"), 0o600); err != nil {
		return job.Job{}, err
	}
	return next, restartDriver(next, d, repo)
}
