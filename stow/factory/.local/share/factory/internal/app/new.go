package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
	"github.com/marco-souza/nixos/stow/factory/internal/deps"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/machine"
	"github.com/marco-souza/nixos/stow/factory/internal/proc"
	"github.com/marco-souza/nixos/stow/factory/internal/ui"
)

// NewOptions are the flags of `factory new`.
type NewOptions struct {
	// Base is the branch to start from, open the PR against and rebase onto.
	Base string
	// Stack is an open PR (number or URL) whose branch is the base.
	Stack string
	// Harness runs every role of the job; "" means the config's default.
	Harness config.Harness
}

const branchPrompt = `Name a git branch for the request below. Use the repo's branch naming convention if its instructions give one. ` +
	`Otherwise use <type>/<TICKET>/<brief-name>: <type> is the kind of change (feature, fix, chore, …); <TICKET> is the ticket key ` +
	`the request mentions, such as ABC-123, left out with its slash when there is none; <brief-name> is two to four lowercase words ` +
	`joined by hyphens. Reply with the branch name only.

Request: `

// branchRE has no dots: that rules out "..", ".lock" and the other names git refuses.
var branchRE = regexp.MustCompile(`^\w[\w-]*(/\w[\w-]*)*$`)

// New creates the job and its worktree, then runs the first turn of the
// grill. It logs one line per step. Nothing is created before gh and the
// harness are checked; a failure after that removes what this call made.
// inline runs the grill; bg restarts the driver when the grill ends.
func New(ctx context.Context, repo, feature string, o NewOptions, inline, bg deps.Deps) (Reply, error) {
	j, err := create(ctx, repo, feature, o, bg)
	if err != nil {
		return Reply{}, err
	}
	return relay(ctx, repo, j.ID, nil, inline, bg)
}

func create(ctx context.Context, repo, feature string, o NewOptions, d deps.Deps) (job.Job, error) {
	what := strings.TrimSpace(feature)
	if what == "" {
		return job.Job{}, &machine.CommandError{Msg: `say what to build: factory new "<feature>"`}
	}
	cfg, err := config.Load(repo)
	if err != nil {
		return job.Job{}, err
	}
	h := o.Harness
	if h == "" {
		h = cfg.DefaultHarness
	}
	if h != config.Claude && h != config.Pi {
		return job.Job{}, &machine.CommandError{Msg: fmt.Sprintf("unknown harness %q (claude, pi)", h)}
	}
	if err := d.GH.Preflight(ctx); err != nil {
		return job.Job{}, err
	}
	if err := d.Git.EnsureExcluded(ctx); err != nil {
		return job.Job{}, err
	}

	base, err := baseFor(ctx, o, cfg.Base, d)
	if err != nil {
		return job.Job{}, fmt.Errorf("base: %w", err)
	}
	d.Log(Ok("base " + base))
	named := nameBranch(ctx, d, cfg, h, repo, what)
	id, branch, err := claim(ctx, repo, named, d)
	if err != nil {
		return job.Job{}, fmt.Errorf("job: %w", err)
	}
	d.Log(Ok(fmt.Sprintf("job %s on %s", id, branch)))

	paths := job.NewPaths(repo, id)
	if err := setup(ctx, paths, branch, base, cfg.Setup, d); err != nil {
		rollback(ctx, repo, id, branch, d)
		return job.Job{}, err
	}
	j := job.New(job.NewArgs{ID: id, Branch: branch, Base: base, Feature: what, Repo: repo, Harness: h, Slot: job.NextSlot(repo), Now: d.Now()})
	if err := job.Save(paths.JobFile, &j, d.Now()); err != nil {
		return job.Job{}, err
	}
	return j, job.AppendActivity(paths.ActivityLog, "created on "+base, d.Now())
}

// setup adds the worktree and runs the repo's setup commands in it.
func setup(ctx context.Context, paths job.Paths, branch, base string, cmds []string, d deps.Deps) error {
	if err := d.Git.CreateWorktree(ctx, branch, paths.Worktree, base); err != nil {
		return fmt.Errorf("worktree: %w", err)
	}
	d.Log(Ok("worktree " + paths.Worktree))
	for _, cmd := range cmds {
		// exec 2>&1: one stream, in the order the command printed it.
		argv := []string{"bash", "-c", "exec 2>&1\n" + cmd}
		r, err := d.Exec.Run(ctx, argv, proc.Opts{Dir: paths.Worktree})
		if err != nil {
			return fmt.Errorf("setup: %w", err)
		}
		// One command from .factory.json (repo config, so a shell script by design).
		if err := proc.Check([]string{"setup:", cmd}, r); err != nil {
			return err
		}
	}
	if len(cmds) > 0 {
		d.Log(Ok("setup"))
	}
	return nil
}

// baseFor is --base, else the stacked PR's branch, else the repo's configured
// base, else origin's default branch.
func baseFor(ctx context.Context, o NewOptions, configured string, d deps.Deps) (string, error) {
	switch {
	case o.Base != "":
		return o.Base, nil
	case o.Stack != "":
		return d.GH.PRHead(ctx, o.Stack)
	case configured != "":
		return configured, nil
	}
	return d.GH.DefaultBranch(ctx)
}

// nameBranch asks the job's harness (low tier) for a branch name; it falls
// back to feature/<slug> when that fails or the name is no branch.
func nameBranch(ctx context.Context, d deps.Deps, cfg config.Config, h config.Harness, repo, feature string) string {
	model := cfg.Models[h][config.Low]
	prompt := branchPrompt + feature
	var argv []string
	if h == config.Pi {
		argv = []string{"pi", "-p"}
		if model != "" {
			argv = append(argv, "--model", model)
		}
		argv = append(argv, prompt)
	} else {
		argv = []string{"claude", "-p", prompt, "--strict-mcp-config"}
		if model != "" {
			argv = append(argv, "--model", model)
		}
	}
	name := ""
	if r, err := d.Exec.Run(ctx, argv, proc.Opts{Dir: repo}); err == nil && r.Code == 0 {
		lines := strings.Split(strings.TrimSpace(r.Stdout), "\n")
		name = strings.TrimSpace(strings.ReplaceAll(lines[len(lines)-1], "`", ""))
	}
	if branchRE.MatchString(name) {
		return job.CaseBranch(name)
	}
	return "feature/" + job.Slugify(feature)
}

// claim takes named, or named-2, -3… when its id or the branch is taken, by
// creating the job folder; Mkdir without -p so a folder made meanwhile is a
// clash. Never an existing branch: discard deletes the job's branch.
func claim(ctx context.Context, repo, named string, d deps.Deps) (id, branch string, err error) {
	taken := job.TakenIDs(repo)
	if err := os.MkdirAll(job.NewPaths(repo, "").JobsDir, 0o750); err != nil {
		return "", "", err
	}
	for n := 1; ; n++ {
		suffix := ""
		if n > 1 {
			suffix = fmt.Sprintf("-%d", n)
		}
		id, branch = job.IDFor(named)+suffix, named+suffix
		if taken[id] {
			continue
		}
		exists, err := d.Git.BranchExists(ctx, branch)
		if err != nil {
			return "", "", err
		}
		if exists {
			continue
		}
		switch err := os.Mkdir(job.NewPaths(repo, id).JobDir, 0o750); {
		case err == nil:
			return id, branch, nil
		case !errors.Is(err, os.ErrExist):
			return "", "", err
		}
	}
}

// rollback removes what this call made, so the id is free again. Best effort,
// and it runs even when ctx is cancelled.
func rollback(ctx context.Context, repo, id, branch string, d deps.Deps) {
	ctx = context.WithoutCancel(ctx)
	paths := job.NewPaths(repo, id)
	if _, err := os.Stat(paths.Worktree); err == nil {
		_ = d.Git.RemoveWorktree(ctx, paths.Worktree)
		_ = d.Git.DeleteBranch(ctx, branch)
	}
	_ = os.RemoveAll(paths.JobDir)
	d.Log(ui.Paint(ui.Dim, "  removed job "+id+", its worktree and branch"))
}
