package app

import (
	"context"

	"github.com/marco-souza/nixos/stow/factory/internal/deps"
	"github.com/marco-souza/nixos/stow/factory/internal/driver"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/machine"
)

// Reply is what a grill turn ended with. Question is the next question for the
// human. Without one the grill is over: Waiting says preflight stopped the
// job, else the driver was started in the background.
type Reply struct {
	Job      job.Job
	Question string
	Waiting  bool
}

// Answer runs one grill turn with the human's answer (nil: show the pending
// question). inline runs the grill; bg restarts the driver when it ends.
func Answer(ctx context.Context, repo, id string, answer *string, inline, bg deps.Deps) (Reply, error) {
	if _, err := findJob(repo, id); err != nil {
		return Reply{}, err
	}
	return relay(ctx, repo, id, answer, inline, bg)
}

// relay runs one grill turn: the next question, or (grill over) the driver
// taking the job on. The orchestrator relays the question to the human and
// the answer back; nobody opens another session.
func relay(ctx context.Context, repo, id string, answer *string, inline, bg deps.Deps) (Reply, error) {
	r, err := driver.GrillTurn(ctx, repo, id, inline, answer)
	if err != nil {
		return Reply{}, err
	}
	if !r.Done {
		j, err := findJob(repo, id)
		return Reply{Job: j, Question: r.Question}, err
	}
	if machine.IsWaiting(r.Job) {
		// Preflight stopped it (a missing access).
		return Reply{Job: r.Job, Waiting: true}, nil
	}
	return Reply{Job: r.Job}, restartDriver(r.Job, bg, repo)
}
