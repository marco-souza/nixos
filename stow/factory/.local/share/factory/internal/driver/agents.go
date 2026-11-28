package driver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
	"github.com/marco-souza/nixos/stow/factory/internal/handoff"
	"github.com/marco-souza/nixos/stow/factory/internal/harness"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/proc"
	"github.com/marco-souza/nixos/stow/factory/internal/tail"
)

// pollInterval is how often an agent's done file is checked.
const pollInterval = 2 * time.Second

// reused are the outputs whose path every visit of their stage reuses: only
// a write during the current visit counts.
var reused = []handoff.Kind{
	handoff.Requirements, handoff.TechDiscovery, handoff.Design, handoff.Spec, handoff.TestPlan,
	handoff.PR, handoff.Report,
}

// agentResult is what an agent's output came to.
type agentResult struct {
	OK      bool
	Verdict string
	Text    string
	// Problem is why not OK.
	Problem string
}

// agentSpec is one agent to run.
type agentSpec struct {
	Role       string
	Kind       handoff.Kind
	Output     string
	Assignment string
	Inputs     []string
	Target     string
	// Check replaces the output's handoff check.
	Check func(text string) handoff.Check
	// NoResume spawns the agent even when a valid output is already there.
	NoResume bool
	// OnResult is called as each agent's result lands, skipped ones included.
	OnResult func(agentResult) error
}

// attempt is a started agent.
type attempt struct {
	spec       agentSpec
	window     string
	req        proc.SpawnRequest
	timeoutMin int
	stopBeat   func()
}

// out is the output file of kind. name is the lens or validator, or "".
func (r *run) out(kind handoff.Kind, name string) string {
	j := r.snapshot()
	p, err := handoff.OutputPath(kind, handoff.OutputArgs{Paths: r.paths, Trip: len(j.Trips), N: len(j.Discovery) + 1, Name: name})
	if err != nil {
		// Only a stage that asks for a kind it has no name for gets here: a bug, not a runtime condition.
		panic(err)
	}
	return p
}

// A visit is one stay in a stage. Its marker file's mtime is when the visit
// began; its content says which visit.
func (r *run) visitFile() string { return filepath.Join(r.paths.RunDir, "visit") }

func visitKey(j job.Job) string {
	return fmt.Sprintf("%s cycle %d trip %d loop %d\n", j.Stage, j.Cycle, j.Trip, j.DiscoveryLoops)
}

func (r *run) enterVisit() error {
	key := visitKey(r.snapshot())
	if data, err := os.ReadFile(r.visitFile()); err == nil && string(data) == key {
		return nil
	}
	if err := os.MkdirAll(r.paths.RunDir, 0o750); err != nil {
		return err
	}
	return os.WriteFile(r.visitFile(), []byte(key), 0o600)
}

func (r *run) writtenThisVisit(file string) bool {
	f, err := os.Stat(file)
	if err != nil {
		return false
	}
	m, err := os.Stat(r.visitFile())
	return err == nil && !f.ModTime().Before(m.ModTime())
}

// show is a path relative to the job folder or the worktree, for log lines.
func (r *run) show(file string) string {
	if rel, err := filepath.Rel(r.paths.JobDir, file); err == nil && !strings.HasPrefix(rel, "..") {
		return rel
	}
	if rel, err := filepath.Rel(r.snapshot().Worktree, file); err == nil {
		return rel
	}
	return file
}

// inspect checks the output file of s.
func (r *run) inspect(s agentSpec) agentResult {
	data, err := os.ReadFile(s.Output)
	if err != nil {
		return agentResult{Problem: "no output at " + r.show(s.Output)}
	}
	text := string(data)
	var c handoff.Check
	if s.Check != nil {
		c = s.Check(text)
	} else {
		c = handoff.CheckOutput(s.Kind, text, r.cfg)
	}
	if !c.OK {
		return agentResult{Problem: r.show(s.Output) + ": " + c.Problem}
	}
	return agentResult{OK: true, Verdict: c.Verdict, Text: text}
}

// reusable is the result of an output already there. It counts as done when
// it passes its check, is not BLOCKED and, at a reused path, is from this
// visit.
func (r *run) reusable(s agentSpec) (agentResult, bool) {
	if s.NoResume {
		return agentResult{}, false
	}
	if _, err := os.Stat(s.Output); err != nil {
		return agentResult{}, false
	}
	res := r.inspect(s)
	if !res.OK || res.Verdict == "BLOCKED" {
		return agentResult{}, false
	}
	if slices.Contains(reused, s.Kind) && !r.writtenThisVisit(s.Output) {
		return agentResult{}, false
	}
	return res, true
}

// spawn starts every agent before waiting on any; a failed one runs once
// more. Agents whose output is already done are skipped. It returns when
// every agent is done, with the errors of the failed waits joined.
func (r *run) spawn(ctx context.Context, specs []agentSpec) ([]agentResult, error) {
	skipped := make([]*agentResult, len(specs))
	for i, s := range specs {
		if res, ok := r.reusable(s); ok {
			skipped[i] = &res
		}
	}
	// A role or harness error fails the stage before any agent starts, so none is left running.
	h := r.snapshot().Harness
	for i, s := range specs {
		if skipped[i] != nil {
			continue
		}
		role, err := harness.LoadRole(r.deps.Roles, s.Role)
		if err != nil {
			return nil, err
		}
		if _, err := harness.Resolve(role, h, r.cfg); err != nil {
			return nil, err
		}
	}
	first := make([]*attempt, len(specs))
	for i, s := range specs {
		if res := skipped[i]; res != nil {
			note := "skip " + s.Role + ": " + r.show(s.Output) + " is already done"
			if res.Verdict != "" {
				note += " (" + res.Verdict + ")"
			}
			r.note(note)
			continue
		}
		a, err := r.startAgent(ctx, s)
		if err != nil {
			r.stopStarted(first)
			return nil, err
		}
		first[i] = a
	}
	results := make([]agentResult, len(specs))
	errs := make([]error, len(specs))
	var wg sync.WaitGroup
	for i, s := range specs {
		wg.Go(func() { results[i], errs[i] = r.settle(ctx, s, skipped[i], first[i]) })
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		return nil, err
	}
	return results, nil
}

// settle waits for one agent, runs it once more when it failed, and reports
// the result.
func (r *run) settle(ctx context.Context, s agentSpec, skipped *agentResult, a *attempt) (agentResult, error) {
	var res agentResult
	if skipped != nil {
		res = *skipped
	} else {
		var err error
		if res, err = r.finishAgent(ctx, a); err != nil {
			return res, err
		}
	}
	if !res.OK {
		again, err := r.startAgent(ctx, s)
		if err != nil {
			return res, err
		}
		if res, err = r.finishAgent(ctx, again); err != nil {
			return res, err
		}
		if !res.OK {
			res.Problem = s.Role + ": " + res.Problem
		}
	}
	if s.OnResult != nil {
		if err := s.OnResult(res); err != nil {
			return res, err
		}
	}
	return res, nil
}

// stopStarted never leaves half a group running: it stops the agents this
// group already started.
func (r *run) stopStarted(first []*attempt) {
	var windows []string
	for _, a := range first {
		if a != nil {
			windows = append(windows, a.window)
		}
	}
	id := r.snapshot().ID
	for _, w := range windows {
		r.deps.Spawner.Kill(id, w)
		r.note("stopped " + w + ": the rest of its group could not start")
	}
	_ = r.update(func(j *job.Job) {
		j.Running = slices.DeleteFunc(j.Running, func(w string) bool { return slices.Contains(windows, w) })
	})
}

// nextAttempt counts every spawn of a role in this job: retries, loops and trips.
func nextAttempt(runDir, role string) (int, error) {
	re := regexp.MustCompile(`^` + regexp.QuoteMeta(role) + `-(\d+)\.task\.md$`)
	entries, err := os.ReadDir(runDir)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range entries {
		if m := re.FindStringSubmatch(e.Name()); m != nil {
			k, _ := strconv.Atoi(m[1])
			n = max(n, k)
		}
	}
	return n + 1, nil
}

func (r *run) startAgent(ctx context.Context, s agentSpec) (*attempt, error) {
	role, err := harness.LoadRole(r.deps.Roles, s.Role)
	if err != nil {
		return nil, err
	}
	j := r.snapshot()
	h, err := harness.Resolve(role, j.Harness, r.cfg)
	if err != nil {
		return nil, err
	}
	paths := r.paths
	for _, d := range []string{paths.RunDir, paths.LogsDir, paths.DoneDir, filepath.Dir(s.Output)} {
		if err := os.MkdirAll(d, 0o750); err != nil {
			return nil, err
		}
	}
	n, err := nextAttempt(paths.RunDir, s.Role)
	if err != nil {
		return nil, err
	}
	base := filepath.Join(paths.RunDir, s.Role+"-"+strconv.Itoa(n))
	files := harness.Files{System: base + ".system.md", Task: base + ".task.md", Harness: h.Harness}
	if err := os.WriteFile(files.System, []byte(role.Body+"\n"), 0o600); err != nil {
		return nil, err
	}
	inputs := uniq(append(slices.Clone(s.Inputs), j.Decisions...))
	prompt := harness.TaskPrompt(harness.TaskContext{
		Job: j, Paths: paths, Assignment: s.Assignment, Output: s.Output, Inputs: inputs, Target: s.Target,
	})
	if err := os.WriteFile(files.Task, []byte(prompt+"\n"), 0o600); err != nil {
		return nil, err
	}
	// ASCII only: safe in file names everywhere. The dashboard maps logs to windows the same way.
	window := s.Role
	if n > 1 {
		window = s.Role + "-" + strconv.Itoa(n)
	}
	var command string
	if r.deps.CommandFor != nil {
		command = r.deps.CommandFor(s.Role, files)
	} else if command, err = harness.Command(role, h, files, paths.JobDir); err != nil {
		return nil, err
	}
	req := proc.SpawnRequest{
		JobID:      j.ID,
		Window:     window,
		Cwd:        j.Worktree,
		Command:    command,
		ScriptFile: base + ".sh",
		LogFile:    filepath.Join(paths.LogsDir, s.Role+"-"+strconv.Itoa(n)+".log"),
		DoneFile:   filepath.Join(paths.DoneDir, s.Role+"-"+strconv.Itoa(n)),
		Tail:       string(h.Harness),
	}
	if err := r.update(func(j *job.Job) { j.Running = append(j.Running, window) }); err != nil {
		return nil, err
	}
	model := ""
	if h.Model != "" {
		model = " " + h.Model
	}
	r.note(fmt.Sprintf("start %s (%s%s)", window, h.Harness, model))
	// Before start: an inline spawner returns only when the agent is done.
	stopBeat := r.heartbeat(window, req.LogFile, h.Harness)
	if err := r.deps.Spawner.Start(ctx, req); err != nil {
		stopBeat()
		_ = r.update(func(j *job.Job) { j.Running = slices.DeleteFunc(j.Running, func(w string) bool { return w == window }) })
		return nil, err
	}
	return &attempt{spec: s, window: window, req: req, timeoutMin: h.TimeoutMin, stopBeat: stopBeat}, nil
}

// uniq drops repeated paths, keeping the first.
func uniq(paths []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

// heartbeat logs, every Deps.Heartbeat, that the agent still runs, for how
// long, and its latest tool call. It returns the stop.
func (r *run) heartbeat(window, logFile string, h config.Harness) func() {
	every := r.deps.Heartbeat
	if every <= 0 {
		return func() {}
	}
	// Wall time, not deps.Now: this is about the human waiting.
	started := time.Now()
	done := make(chan struct{})
	var wg sync.WaitGroup
	id := r.snapshot().ID
	wg.Go(func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				line := fmt.Sprintf("… %s: %s running %s", id, window, tail.FormatDuration(float64(time.Since(started).Milliseconds())))
				if data, err := os.ReadFile(logFile); err == nil {
					if tool := tail.LastTool(string(data), h, tail.Width()); tool != "" {
						line += ", last: " + tool
					}
				}
				r.deps.Log(line)
			}
		}
	})
	return sync.OnceFunc(func() {
		close(done)
		wg.Wait()
	})
}

// finishAgent waits for the attempt's done file, then checks its output. The
// error is only a cancelled ctx or a job file that can't be saved.
func (r *run) finishAgent(ctx context.Context, a *attempt) (agentResult, error) {
	id := r.snapshot().ID
	gone := false
	ok, err := proc.WaitForFile(ctx, func() bool {
		if gone {
			return true
		}
		_, err := os.Stat(a.req.DoneFile)
		return err == nil
	}, proc.WaitOptions{
		Timeout: time.Duration(a.timeoutMin) * time.Minute,
		Poll:    pollInterval,
		Now:     r.deps.Now,
		// A window that vanished without its done file will never write one.
		Sleep: func(ctx context.Context, d time.Duration) error {
			if r.deps.Spawner.IsAlive(id, a.window) {
				return r.deps.Sleep(ctx, d)
			}
			gone = true
			return nil
		},
	})
	a.stopBeat()
	if err != nil {
		return agentResult{}, err
	}
	if uerr := r.update(func(j *job.Job) {
		j.Running = slices.DeleteFunc(j.Running, func(w string) bool { return w == a.window })
	}); uerr != nil {
		return agentResult{}, uerr
	}
	var res agentResult
	if ok {
		res = r.result(a)
	} else {
		res = agentResult{Problem: fmt.Sprintf("timed out after %d min", a.timeoutMin)}
	}
	// A failed window stays open for inspection.
	if !ok || res.OK {
		r.deps.Spawner.Kill(id, a.window)
	}
	if res.OK {
		verdict := res.Verdict
		if verdict == "" {
			verdict = "ok"
		}
		r.note(a.window + ": " + verdict)
	} else {
		r.note(a.window + ": " + res.Problem)
	}
	return res, nil
}

func (r *run) result(a *attempt) agentResult {
	res := r.inspect(a.spec)
	// At a reused path, a valid file from an earlier visit is not this agent's output.
	if res.OK && slices.Contains(reused, a.spec.Kind) && !r.writtenThisVisit(a.spec.Output) {
		res = agentResult{Problem: r.show(a.spec.Output) + " was not written"}
	}
	code, ok := proc.ReadExitCode(a.req.DoneFile)
	switch {
	case !ok:
		return agentResult{Problem: "the window closed before the agent finished"}
	case code != 0:
		return agentResult{Problem: fmt.Sprintf("exited with code %d", code)}
	}
	return res
}
