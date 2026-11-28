// Package driver runs a job: it steps through the stages, starts the agents,
// routes each outcome through the state machine and keeps the PR in sync.
package driver

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
	"github.com/marco-souza/nixos/stow/factory/internal/deps"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/machine"
	"github.com/marco-souza/nixos/stow/factory/internal/ui"
)

// Result is where Run left the job.
type Result string

// The results of Run.
const (
	Waiting   Result = "waiting"
	Done      Result = "done"
	Discarded Result = "discarded"
)

// run is the driver's state for one job. The job is guarded by mu; the rest
// is read-only. Agents wait in their own goroutines, so every change to the
// job goes through update.
type run struct {
	repo  string
	paths job.Paths
	cfg   config.Config
	deps  deps.Deps

	mu  sync.Mutex
	job job.Job
}

// newRun loads the job and the repo's config.
func newRun(repo, id string, d deps.Deps) (*run, error) {
	paths := job.NewPaths(repo, id)
	if _, err := os.Stat(paths.JobFile); err != nil {
		return nil, fmt.Errorf("no job %s in %s", id, paths.JobsDir)
	}
	cfg, err := config.Load(repo)
	if err != nil {
		return nil, err
	}
	j, err := job.Load(paths.JobFile)
	if err != nil {
		return nil, err
	}
	return &run{repo: repo, paths: paths, cfg: cfg, deps: d, job: j}, nil
}

// update changes the job under the lock and saves it.
func (r *run) update(fn func(j *job.Job)) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	fn(&r.job)
	return job.Save(r.paths.JobFile, &r.job, r.deps.Now())
}

// snapshot is a copy of the job that no other goroutine changes.
func (r *run) snapshot() job.Job {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.job.Clone()
}

// note writes one line to activity.log and to the driver's output.
func (r *run) note(line string) {
	_ = job.AppendActivity(r.paths.ActivityLog, line, r.deps.Now())
	r.deps.Log(r.job.ID + ": " + line)
}

func (r *run) limits() machine.Limits {
	return machine.Limits{MaxTrips: r.cfg.MaxTrips, MaxDiscoveryLoops: r.cfg.MaxDiscoveryLoops}
}

// Run runs the job until it waits on the human, is done or is discarded.
func Run(ctx context.Context, repo, id string, d deps.Deps) (Result, error) {
	r, err := newRun(repo, id, d)
	if err != nil {
		return "", err
	}
	release, err := job.Acquire(r.paths.JobDir, os.Getpid())
	if err != nil {
		return "", err
	}
	defer release()
	if err := r.stopLeftovers(); err != nil {
		return "", err
	}
	moved := false
	for !machine.IsWaiting(r.snapshot()) {
		if err := r.step(ctx); err != nil {
			return "", err
		}
		moved = true
	}
	return r.stop(ctx, moved), nil
}

// step runs the current stage, routes its outcome, saves, logs and updates
// the PR. A cancelled ctx aborts the step without routing or saving.
func (r *run) step(ctx context.Context) error {
	from := r.snapshot().Stage
	if err := r.enterVisit(); err != nil {
		return err
	}
	effect, ok := stages[from]
	if !ok {
		return fmt.Errorf("stage %s has no effect to run", from)
	}
	o, err := effect(ctx, r)
	if cerr := ctx.Err(); cerr != nil {
		return cerr
	}
	if err != nil {
		// A git, gh, hook or config error stops the job for the human with the exact message.
		o = machine.Outcome{Kind: machine.OutcomeFailed, Stage: from, Reason: err.Error()}
	}
	next, err := machine.Route(r.snapshot(), o, r.limits(), r.deps.Now())
	if err != nil {
		return err
	}
	if err := r.update(func(j *job.Job) { *j = next }); err != nil {
		return err
	}
	r.note(string(from) + " → " + string(next.Stage) + detail(o, next))
	r.updatePR(ctx)
	return nil
}

// stop tells the human where the job is and says what comes next.
func (r *run) stop(ctx context.Context, moved bool) Result {
	j := r.snapshot()
	switch j.Stage {
	case job.StageDiscarded:
		return Discarded
	case job.StageDone:
		line := j.ID + ": done"
		if j.PR != "" {
			line += " " + j.PR
		}
		r.deps.Log(line)
		return Done
	}
	why := ui.WhatFor(j)
	if why == "" {
		why = string(j.Stage)
	}
	if moved {
		r.deps.Notify(ctx, j.ID+" needs you", why)
	}
	r.deps.Log(j.ID + ": " + why)
	if hint := ui.NextHint(j); hint != "" {
		r.deps.Log(j.ID + ": next: " + hint)
	}
	return Waiting
}

// stopLeftovers stops agents a dead driver left running; they would race the
// ones this driver starts.
func (r *run) stopLeftovers() error {
	j := r.snapshot()
	if len(j.Running) == 0 {
		return nil
	}
	for _, w := range j.Running {
		if r.deps.Spawner.IsAlive(j.ID, w) {
			r.deps.Spawner.Kill(j.ID, w)
			r.note("stopped " + w + ", left running by an earlier driver")
		}
	}
	return r.update(func(j *job.Job) { j.Running = []string{} })
}

// detail is ` (verdicts or reason)` for a transition line.
func detail(o machine.Outcome, next job.Job) string {
	var parts []string
	switch {
	case o.Kind == machine.OutcomeFailed:
		parts = append(parts, ui.Headline(o.Reason))
	case o.Stage == job.StageReview || o.Stage == job.StageValidation:
		if n := len(next.Trips); n > 0 {
			rec := next.Trips[n-1].Reviews
			if o.Stage == job.StageValidation {
				rec = next.Trips[n-1].Validations
			}
			parts = append(parts, verdicts(rec))
		}
	case o.Verdict != "":
		if o.ReworkStep != "" {
			parts = append(parts, o.Verdict+" "+string(o.ReworkStep))
		} else {
			parts = append(parts, o.Verdict)
		}
	case o.HumanQuestions:
		parts = append(parts, "questions for the human")
	}
	if o.Kind == machine.OutcomeDone && next.Stage == job.StageNeedsHuman && next.Reason != "" {
		parts = append(parts, ui.Headline(next.Reason))
	}
	parts = slices.DeleteFunc(parts, func(s string) bool { return s == "" })
	if len(parts) == 0 {
		return ""
	}
	return " (" + strings.Join(parts, "; ") + ")"
}

// verdicts sums up a trip's reviews or validations, odd ones first.
func verdicts(rec map[string]string) string {
	if len(rec) == 0 {
		return ""
	}
	keys := make([]string, 0, len(rec))
	for k := range rec {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var odd []string
	for _, k := range keys {
		if rec[k] != "PASS" {
			odd = append(odd, k+" "+rec[k])
		}
	}
	switch {
	case len(odd) == 0:
		return "all PASS"
	case len(odd) < len(keys):
		return strings.Join(odd, ", ") + ", others PASS"
	}
	return strings.Join(odd, ", ")
}

// docKinds are the job's docs, in the order the PR's Docs line lists them.
var docKinds = []string{"requirements", "tech-discovery", "design", "spec", "test-plan"}

// existingDocs is the repo-relative path of every job doc that exists.
func (r *run) existingDocs() []string {
	var docs []string
	for _, k := range docKinds {
		p := r.paths.Doc(k)
		if _, err := os.Stat(p); err != nil {
			continue
		}
		rel, err := filepath.Rel(r.repo, p)
		if err != nil {
			continue
		}
		docs = append(docs, filepath.ToSlash(rel))
	}
	return docs
}

// updatePR refreshes the PR's status block and an escalation's decision
// section on every transition. It is cosmetic: a failure is noted, never
// fatal.
func (r *run) updatePR(ctx context.Context) {
	j := r.snapshot()
	if j.PR == "" {
		return
	}
	if err := r.writePRBody(ctx, j); err != nil {
		r.note("PR status update failed: " + ui.Headline(err.Error()))
	}
}

func (r *run) writePRBody(ctx context.Context, j job.Job) error {
	body, err := r.deps.GH.ViewBody(ctx, j.PR)
	if err != nil {
		return err
	}
	body = ui.MergeStatus(strings.TrimRight(body, " \t\r\n"), ui.RenderStatus(j, r.cfg, r.existingDocs()))
	file := filepath.Join(r.paths.JobDir, "pr-body.md")
	text := strings.TrimRight(ui.MergeDecision(body, r.decision(j)), " \t\r\n") + "\n"
	if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
		return err
	}
	return r.deps.GH.EditBody(ctx, j.PR, file)
}

// decision is what a pause asks the human, for the top of the PR body; ""
// when the job is not paused. A failure shows its full reason, fenced.
func (r *run) decision(j job.Job) string {
	if j.Stage != job.StageNeedsHuman {
		return ""
	}
	const head = "## ⏸ Needs your decision"
	switch j.WaitingFor {
	case job.WaitFailure:
		if j.Reason == "" {
			return ""
		}
		return head + "\n\n" + fence(j.Reason)
	case job.WaitEscalation:
	default:
		return ""
	}
	where := func(file string) string {
		if file == "" {
			return "the trip folder"
		}
		if rel, err := filepath.Rel(r.repo, file); err == nil {
			return rel
		}
		return file
	}
	if j.CapHit == job.CapEnv {
		return head + "\n\nQA environment failed twice; validators' evidence: " + where(j.ReasonFile)
	}
	file := j.QuestionsFile
	if file == "" {
		file = j.ReasonFile
	}
	var questions string
	if file != "" {
		if data, err := os.ReadFile(file); err == nil {
			questions = questionsOf(string(data))
		}
	}
	if questions == "" {
		questions = "See " + where(file) + "."
	}
	return head + "\n\n" + questions
}

// fence wraps text in a code fence longer than any run of backticks in it.
func fence(text string) string {
	n, run := 3, 0
	for _, c := range text {
		if c == '`' {
			run++
			n = max(n, run+1)
		} else {
			run = 0
		}
	}
	f := strings.Repeat("`", n)
	return f + "text\n" + text + "\n" + f
}

// questionsOf is the body of a judge file's `## Questions` section.
func questionsOf(text string) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	at := slices.IndexFunc(lines, func(l string) bool {
		return strings.TrimRight(strings.TrimSuffix(strings.TrimRight(l, " \t"), ":"), " \t") == "## Questions"
	})
	if at < 0 {
		return ""
	}
	rest := lines[at+1:]
	if end := slices.IndexFunc(rest, func(l string) bool { return strings.HasPrefix(l, "## ") }); end >= 0 {
		rest = rest[:end]
	}
	return strings.TrimSpace(strings.Join(rest, "\n"))
}
