package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/marco-souza/nixos/stow/factory/internal/deps"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/machine"
	"github.com/marco-souza/nixos/stow/factory/internal/ui"
)

// Discard stops the driver and agents, removes the worktree, closes the PR,
// deletes the branch and the proof branch, marks the job discarded and moves
// its folder to .factory/archive/, so its id is free again. Each step is best
// effort: a failure is logged and the rest still runs.
func Discard(ctx context.Context, repo, id string, d deps.Deps) (job.Job, error) {
	cur, err := findJob(repo, id)
	if err != nil {
		return job.Job{}, err
	}
	// Refuses an already discarded job before touching anything.
	if _, err := machine.Apply(cur, machine.Command{Kind: machine.CmdDiscard}, d.Now()); err != nil {
		return job.Job{}, err
	}
	attempt := func(name string, fn func() error) {
		if err := fn(); err != nil {
			d.Log(Failed(name + ": " + err.Error()))
			return
		}
		d.Log(Ok(name))
	}
	// The driver first: it would otherwise save over "discarded".
	attempt("stop the driver and agents", func() error {
		d.Spawner.Kill(id, "driver")
		d.Spawner.KillAgents(id)
		return nil
	})
	// The worktree before the branch: git can't delete a branch a worktree
	// has checked out.
	if _, err := os.Stat(cur.Worktree); err == nil {
		attempt("remove worktree", func() error { return d.Git.RemoveWorktree(ctx, cur.Worktree) })
	}
	if cur.PR != "" {
		attempt("close PR "+ui.PRNumber(cur.PR), func() error { return d.GH.Close(ctx, cur.PR) })
	}
	attempt("delete branch "+cur.Branch, func() error { return d.Git.DeleteBranch(ctx, cur.Branch) })
	// The proof screenshots finalize pushed; only on the remote, so a missing
	// local one is fine.
	attempt("delete branch factory-proof/"+id, func() error { return d.Git.DeleteBranch(ctx, "factory-proof/"+id) })
	next, err := transition(repo, id, machine.Command{Kind: machine.CmdDiscard}, d, func(j *job.Job) { j.Running = []string{} })
	if err != nil {
		return job.Job{}, err
	}
	paths := job.NewPaths(repo, id)
	to := filepath.Join(paths.FactoryDir, "archive", fmt.Sprintf("%s-%d", id, d.Now().UnixMilli()))
	if err := os.MkdirAll(filepath.Dir(to), 0o750); err != nil {
		return job.Job{}, err
	}
	if err := os.Rename(paths.JobDir, to); err != nil {
		return job.Job{}, err
	}
	rel, err := filepath.Rel(repo, to)
	if err != nil {
		rel = to
	}
	d.Log(Ok(fmt.Sprintf("discarded %s; its folder is now %s", id, rel)))
	return next, nil
}
