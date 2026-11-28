package app

import (
	"context"

	"github.com/marco-souza/nixos/stow/factory/internal/deps"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/machine"
)

// Approve accepts what is there: finalizes the PR, or goes on past an
// escalation. It restarts the driver.
func Approve(_ context.Context, repo, id string, d deps.Deps) (job.Job, error) {
	j, err := transition(repo, id, machine.Command{Kind: machine.CmdApprove}, d, nil)
	if err != nil {
		return job.Job{}, err
	}
	return j, restartDriver(j, d, repo)
}

// Retry retries the step a needs-human job failed (one more trip at the trip
// cap) and restarts the driver.
func Retry(_ context.Context, repo, id string, d deps.Deps) (job.Job, error) {
	j, err := transition(repo, id, machine.Command{Kind: machine.CmdRetry}, d, nil)
	if err != nil {
		return job.Job{}, err
	}
	return j, restartDriver(j, d, repo)
}
