package app

import (
	"context"

	"github.com/marco-souza/nixos/stow/factory/internal/deps"
	"github.com/marco-souza/nixos/stow/factory/internal/driver"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/machine"
)

// RunOptions are the flags of `factory run`.
type RunOptions struct {
	// Here drives the job in this process: the background driver's own command.
	Here bool
	// Inline drives the job in this process, agents included.
	Inline bool
}

// RunOutcome is where Run left the job.
type RunOutcome struct {
	Job job.Job
	// Retried: a failed job was retried first.
	Retried bool
	// Driven: the job was driven in this process; Result is where it stopped.
	Driven bool
	Result driver.Result
	// Started: the driver was started in the background.
	Started bool
}

// Run (re)starts the driver in the background and returns; a failed job is
// retried first. The driver never runs as a child of this command, whose
// caller (an agent's shell) may not outlive it. Inline and Here drive in this
// process; build d with inline set for Inline.
func Run(ctx context.Context, repo, id string, o RunOptions, d deps.Deps) (RunOutcome, error) {
	j, err := findJob(repo, id)
	if err != nil {
		return RunOutcome{}, err
	}
	if o.Here {
		return drive(ctx, repo, j, d, false)
	}
	retried := false
	if j.Stage == job.StageNeedsHuman {
		next, err := transition(repo, id, machine.Command{Kind: machine.CmdRetry}, d, nil)
		if err != nil {
			return RunOutcome{Job: j}, err
		}
		j, retried = next, true
	}
	if o.Inline {
		return drive(ctx, repo, j, d, retried)
	}
	if j.Stage == job.StageRequirements {
		// The grill is a conversation, not a driver step.
		return RunOutcome{Job: j, Retried: retried}, nil
	}
	if err := restartDriver(j, d, repo); err != nil {
		return RunOutcome{}, err
	}
	return RunOutcome{Job: j, Retried: retried, Started: true}, nil
}

// drive runs the job in this process until it waits on the human. The driver
// logs why it stopped and what to type next.
func drive(ctx context.Context, repo string, j job.Job, d deps.Deps, retried bool) (RunOutcome, error) {
	res, err := driver.Run(ctx, repo, j.ID, d)
	return RunOutcome{Job: j, Retried: retried, Driven: true, Result: res}, err
}
