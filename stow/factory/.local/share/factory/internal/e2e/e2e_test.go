// Package e2e runs the whole factory end to end: real git (a repo and a bare
// origin), the embedded roles, fake agents and a fake gh. Real claude, pi and
// gh never run: stubs that exit 99 come after the fakes on PATH.
package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	factory "github.com/marco-souza/nixos/stow/factory"
	"github.com/marco-souza/nixos/stow/factory/internal/app"
	"github.com/marco-souza/nixos/stow/factory/internal/config"
	"github.com/marco-souza/nixos/stow/factory/internal/deps"
	"github.com/marco-souza/nixos/stow/factory/internal/driver"
	"github.com/marco-souza/nixos/stow/factory/internal/git"
	"github.com/marco-souza/nixos/stow/factory/internal/harness"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/proc"
	"github.com/marco-souza/nixos/stow/factory/internal/testkit"
)

const pr = "https://github.com/acme/repo/pull/1"

var bins testkit.Bins

func TestMain(m *testing.M) { os.Exit(testMain(m)) }

func testMain(m *testing.M) int {
	testkit.ClearGitEnv()
	dir, err := os.MkdirTemp("", "factory-e2e-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer func() { _ = os.RemoveAll(dir) }()
	if bins, err = testkit.BuildBins(dir); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	// Real claude and pi must never run: after the fakes, first on PATH.
	stubs := filepath.Join(dir, "stubs")
	if err := os.MkdirAll(stubs, 0o750); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	for _, name := range []string{"claude", "pi"} {
		script := "#!/bin/sh\necho '" + stubMessage(name) + "' >&2\nexit 99\n"
		if err := os.WriteFile(filepath.Join(stubs, name), []byte(script), 0o700); err != nil { //nolint:gosec // a script must be executable
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
	}
	if err := os.Setenv("PATH", bins.Dir+string(os.PathListSeparator)+stubs+string(os.PathListSeparator)+os.Getenv("PATH")); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return m.Run()
}

func stubMessage(name string) string { return "e2e: real " + name + " must not run" }

// envRunner adds env to every command, so each test's gh fake has its own
// state folder.
type envRunner struct {
	proc.RealRunner
	env map[string]string
}

func (r envRunner) Run(ctx context.Context, argv []string, o proc.Opts) (proc.Result, error) {
	merged := map[string]string{}
	for k, v := range r.env {
		merged[k] = v
	}
	for k, v := range o.Env {
		merged[k] = v
	}
	o.Env = merged
	return r.RealRunner.Run(ctx, argv, o)
}

type options struct {
	// config is merged over the e2e .factory.json, key by key.
	config map[string]any
	// new is for `factory new`.
	new app.NewOptions
	// before runs before `factory new`.
	before func(t *testing.T, repo string)
	// realAgents leaves CommandFor nil.
	realAgents bool
	// heartbeat is Deps.Heartbeat.
	heartbeat int // ms
	// noGrill stops after `factory new`: the question is pending.
	noGrill bool
}

// world is one test's repo, deps and records.
type world struct {
	t       *testing.T
	repo    testkit.Repo
	root    string
	ghDir   string
	hookLog string
	deps    deps.Deps
	id      string
	paths   job.Paths
	asked   string

	mu        sync.Mutex
	notes     []string
	logs      []string
	harnesses map[string][]config.Harness
}

// setup makes a repo with a bare origin, hooks that log to a file, a
// pre-push hook that rejects factory-proof refs, and runs `factory new` and
// the grill (unless noGrill). Agents are fake-agent processes run inline,
// answering from scenario.
func setup(t *testing.T, scenario testkit.Scenario, o options) *world {
	t.Helper()
	r := testkit.TempRepo(t)
	w := &world{t: t, repo: r, root: filepath.Dir(r.Repo), harnesses: map[string][]config.Harness{}}
	w.ghDir = filepath.Join(w.root, "gh")
	w.hookLog = filepath.Join(w.root, "hooks.log")
	must(t, os.MkdirAll(w.ghDir, 0o750))

	// A proof push without --no-verify would fail the happy path.
	prePush := "#!/bin/sh\nwhile read local_ref local_sha remote_ref remote_sha; do\n" +
		"  case \"$remote_ref\" in refs/heads/factory-proof/*) echo \"pre-push: rejected $remote_ref\" >&2; exit 1;; esac\n" +
		"done\n"
	must(t, os.WriteFile(filepath.Join(r.Repo, ".git", "hooks", "pre-push"), []byte(prePush), 0o700)) //nolint:gosec // a hook must be executable

	cfg := map[string]any{"hooks": map[string]string{
		"prOpened": `echo "prOpened $PR" >> ` + proc.Shq(w.hookLog),
		"qaUrl":    `echo "https://qa.example/$JOB"`,
		"qaReady":  `echo "qaReady $SHA" >> ` + proc.Shq(w.hookLog),
	}}
	for k, v := range o.config {
		cfg[k] = v
	}
	data, err := json.Marshal(cfg)
	must(t, err)
	must(t, os.WriteFile(filepath.Join(r.Repo, ".factory.json"), data, 0o600))

	scenarioFile := filepath.Join(w.root, "scenario.json")
	must(t, scenario.Write(scenarioFile))

	exec := envRunner{env: map[string]string{"FAKE_GH_DIR": w.ghDir}}
	clock := testkit.NewFakeClock()
	w.deps = deps.Deps{
		Exec:    exec,
		Spawner: proc.InlineSpawner{Exec: exec, Self: bins.Factory},
		Git:     &git.Git{Exec: exec, Repo: r.Repo},
		GH:      &git.GitHub{Exec: exec, Repo: r.Repo},
		Roles:   factory.Roles,
		Self:    bins.Factory,
		Notify: func(_ context.Context, _, msg string) {
			w.mu.Lock()
			defer w.mu.Unlock()
			w.notes = append(w.notes, msg)
		},
		Now:   clock.Now,
		Sleep: clock.Sleep,
		Log: func(line string) {
			w.mu.Lock()
			defer w.mu.Unlock()
			w.logs = append(w.logs, line)
		},
	}
	if !o.realAgents {
		w.deps.CommandFor = func(role string, f harness.Files) string {
			w.mu.Lock()
			w.harnesses[role] = append(w.harnesses[role], f.Harness)
			w.mu.Unlock()
			return strings.Join([]string{proc.Shq(bins.FakeAgent), proc.Shq(role), proc.Shq(f.Task), proc.Shq(scenarioFile)}, " ")
		}
	}
	w.deps.Heartbeat = time.Duration(o.heartbeat) * time.Millisecond
	if o.before != nil {
		o.before(t, r.Repo)
	}

	reply, err := app.New(t.Context(), r.Repo, "Add rate limiting", o.new, w.deps, w.deps)
	if o.realAgents {
		// The grill agent is the stub: it must fail, and say so.
		if err == nil {
			t.Fatal("grill with the real command line should fail: the claude stub exits 99")
		}
		w.id = onlyJob(t, r.Repo)
		w.paths = job.NewPaths(r.Repo, w.id)
		return w
	}
	must(t, err)
	w.id, w.paths, w.asked = reply.Job.ID, job.NewPaths(r.Repo, reply.Job.ID), reply.Question
	if !o.noGrill {
		w.answer("Admins, please.")
	}
	return w
}

func onlyJob(t *testing.T, repo string) string {
	t.Helper()
	jobs := job.List(repo)
	if len(jobs) != 1 {
		t.Fatalf("want one job, have %d", len(jobs))
	}
	return jobs[0].ID
}

func (w *world) answer(text string) app.Reply {
	w.t.Helper()
	reply, err := app.Answer(w.t.Context(), w.repo.Repo, w.id, &text, w.deps, w.deps)
	must(w.t, err)
	return reply
}

func (w *world) run() driver.Result {
	w.t.Helper()
	res, err := driver.Run(w.t.Context(), w.repo.Repo, w.id, w.deps)
	must(w.t, err)
	return res
}

func (w *world) load() job.Job {
	w.t.Helper()
	j, err := job.Load(w.paths.JobFile)
	must(w.t, err)
	return j
}

func (w *world) approve() {
	w.t.Helper()
	_, err := app.Approve(w.t.Context(), w.repo.Repo, w.id, w.deps)
	must(w.t, err)
}

// task is the prompt of the agent run called name, such as planner-2.
func (w *world) task(name string) string {
	w.t.Helper()
	data, err := os.ReadFile(filepath.Join(w.paths.RunDir, name+".task.md"))
	must(w.t, err)
	return string(data)
}

// origin runs git in the bare origin.
func (w *world) origin(args ...string) string {
	w.t.Helper()
	return strings.TrimSpace(testkit.Git(w.t, w.repo.Origin, args...))
}

func (w *world) hooks() []string {
	data, err := os.ReadFile(w.hookLog)
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

// ghCalls are the calls fakegh recorded that start with prefix.
func (w *world) ghCalls(prefix ...string) [][]string {
	w.t.Helper()
	data, err := os.ReadFile(filepath.Join(w.ghDir, "calls.jsonl"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	must(w.t, err)
	var out [][]string
	for line := range strings.SplitSeq(strings.TrimSpace(string(data)), "\n") {
		var args []string
		must(w.t, json.Unmarshal([]byte(line), &args))
		if len(args) >= len(prefix) && slices.Equal(args[:len(prefix)], prefix) {
			out = append(out, args)
		}
	}
	return out
}

// body is the PR body fakegh holds.
func (w *world) body() string {
	w.t.Helper()
	data, err := os.ReadFile(filepath.Join(w.ghDir, "body"))
	must(w.t, err)
	return string(data)
}

func (w *world) trips() []string {
	w.t.Helper()
	entries, err := os.ReadDir(w.paths.JobDir)
	must(w.t, err)
	var out []string
	for _, e := range entries {
		if regexp.MustCompile(`^trip-\d+$`).MatchString(e.Name()) {
			out = append(out, e.Name())
		}
	}
	slices.Sort(out)
	return out
}

func (w *world) activity() []string {
	w.t.Helper()
	data, err := os.ReadFile(w.paths.ActivityLog)
	must(w.t, err)
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

func must(t testing.TB, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func eq[T comparable](t testing.TB, what string, got, want T) {
	t.Helper()
	if got != want {
		t.Errorf("%s = %v, want %v", what, got, want)
	}
}

func eqSlice(t testing.TB, what string, got, want []string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Errorf("%s = %q, want %q", what, got, want)
	}
}

func contains(t testing.TB, what, text, sub string) {
	t.Helper()
	if !strings.Contains(text, sub) {
		t.Errorf("%s does not contain %q:\n%s", what, sub, text)
	}
}

func lacks(t testing.TB, what, text, sub string) {
	t.Helper()
	if strings.Contains(text, sub) {
		t.Errorf("%s contains %q:\n%s", what, sub, text)
	}
}

// stateIs checks the job is waiting where want says.
func stateIs(t testing.TB, j job.Job, stage job.Stage, waiting job.WaitingFor) {
	t.Helper()
	eq(t, "stage", j.Stage, stage)
	eq(t, "waitingFor", j.WaitingFor, waiting)
}

func TestE2E(t *testing.T) {
	t.Run("happy path: new → human-review → approve → done", func(t *testing.T) {
		w := setup(t, nil, options{})
		contains(t, "first question", w.asked, "Who is it for?")
		transcript, err := os.ReadFile(filepath.Join(w.paths.GrillDir, "transcript.md"))
		must(t, err)
		contains(t, "transcript", string(transcript), "## Answer\n\nAdmins, please.")
		eq(t, "stage after the grill", w.load().Stage, job.StageTechDiscovery)

		// main moves on while the job runs, so the rebase has something to do.
		must(t, os.WriteFile(filepath.Join(w.repo.Repo, "main.txt"), []byte("main\n"), 0o600))
		testkit.Git(t, w.repo.Repo, "add", "main.txt")
		testkit.Git(t, w.repo.Repo, "commit", "-q", "-m", "main moves on")
		testkit.Git(t, w.repo.Repo, "push", "-q", "origin", "main")

		eq(t, "run", w.run(), driver.Waiting)
		j := w.load()
		stateIs(t, j, job.StageHumanReview, job.WaitHumanReview)
		eq(t, "pr", j.PR, pr)
		eq(t, "cycle", j.Cycle, 1)
		eq(t, "trip", j.Trip, 1)
		eq(t, "running", len(j.Running), 0)
		eqSlice(t, "notes", w.notes, []string{"Review the PR: " + pr})

		w.approve()
		eq(t, "run", w.run(), driver.Done)
		j = w.load()
		eq(t, "stage", j.Stage, job.StageDone)

		// Criterion 10: the docs stay in the job folder.
		for _, k := range []string{"requirements", "tech-discovery", "design", "spec", "test-plan"} {
			if _, err := os.Stat(filepath.Join(w.paths.JobDir, "docs", k+".md")); err != nil {
				t.Errorf("doc %s: %v", k, err)
			}
		}
		files := strings.Split(w.origin("ls-tree", "-r", "--name-only", j.Branch), "\n")
		for _, f := range files {
			if strings.HasPrefix(f, "docs/") {
				t.Errorf("origin's branch has %s", f)
			}
		}
		for _, f := range []string{"main.txt", "src/t1.txt", "src/t2.txt"} {
			if !slices.Contains(files, f) {
				t.Errorf("origin's branch lacks %s", f)
			}
		}
		eqSlice(t, "branch log", strings.Split(w.origin("log", "--format=%s", j.Branch), "\n"), []string{
			fmt.Sprintf("feat: t2 for %s (cycle 1 trip 1)", w.id),
			fmt.Sprintf("feat: t1 for %s (cycle 1 trip 1)", w.id),
			"main moves on",
			"init",
		})
		eq(t, "proof ref", w.origin("ls-tree", "--name-only", "factory-proof/"+w.id),
			"ac1-e2e-requests-over-the-limit-get-a-429.txt\nac2-e2e-the-limit-is-configurable.txt")

		// Criterion 12: one draft PR, opened at the first build push.
		creates := w.ghCalls("pr", "create")
		eq(t, "pr create calls", len(creates), 1)
		if !slices.Contains(creates[0], "--draft") {
			t.Errorf("pr create is not a draft: %q", creates[0])
		}
		act := w.activity()
		opened := indexOf(act, "opened draft PR")
		firstBuilder := indexOf(act, "start builder-")
		if opened < 0 || firstBuilder < 0 || opened < firstBuilder {
			t.Errorf("opened draft PR (line %d) must come after the first builder (line %d):\n%s", opened, firstBuilder, strings.Join(act, "\n"))
		}
		if len(w.ghCalls("pr", "edit", pr, "--body-file")) == 0 {
			t.Error("no pr edit --body-file call")
		}
		eq(t, "title calls", fmt.Sprint(w.ghCalls("pr", "edit", pr, "--title")), fmt.Sprint([][]string{{"pr", "edit", pr, "--title", "Add rate limiting"}}))
		eq(t, "ready calls", fmt.Sprint(w.ghCalls("pr", "ready")), fmt.Sprint([][]string{{"pr", "ready", pr}}))
		// The status block, now at Done, stays on top of the summarizer's body.
		body := w.body()
		contains(t, "PR body", body, "✅ **Done**")
		contains(t, "PR body", body, "<!-- /factory:status -->\n\nLimits requests per client.\n\n## Proof")
		// Criterion 10: repo-relative code spans, no links.
		docsLine := lineWith(body, "Docs: ")
		contains(t, "Docs line", docsLine, "`.factory/jobs/"+w.id+"/docs/requirements.md`")
		lacks(t, "Docs line", docsLine, "](")
		lacks(t, "PR body", body, "](.factory/jobs")
		// QA waited on the rebased head, the one on origin.
		eqSlice(t, "hooks", w.hooks(), []string{"prOpened " + pr, "qaReady " + w.origin("rev-parse", j.Branch)})
		contains(t, "validator task", w.task("validator-e2e-1"), "Target: https://qa.example/"+w.id)
		// Criterion 10: absolute paths in the prompts.
		contains(t, "planner task", w.task("planner-1"), "Docs: requirements="+w.paths.JobDir+"/docs/requirements.md,")
	})

	t.Run("build-judge CHANGES twice then APPROVE", func(t *testing.T) {
		w := setup(t, testkit.Scenario{"build-judge": {"CHANGES", "CHANGES", "APPROVE"}}, options{})
		eq(t, "run", w.run(), driver.Waiting)
		j := w.load()
		stateIs(t, j, job.StageHumanReview, job.WaitHumanReview)
		eq(t, "cycle", j.Cycle, 1)
		eq(t, "trip", j.Trip, 3)
		var judges []string
		for _, r := range j.Trips {
			judges = append(judges, r.BuildJudge)
		}
		eqSlice(t, "build judges", judges, []string{"CHANGES", "CHANGES", "APPROVE"})
		eqSlice(t, "trip folders", w.trips(), []string{"trip-1", "trip-2", "trip-3"})
		contains(t, "planner-2", w.task("planner-2"), "Inputs: "+filepath.Join(w.paths.TripDir(1), "build-judge.md"))
		contains(t, "planner-3", w.task("planner-3"), "Inputs: "+filepath.Join(w.paths.TripDir(2), "build-judge.md"))
		log := w.origin("log", "--format=%s", j.Branch)
		for _, trip := range []int{1, 2, 3} {
			contains(t, "log", log, fmt.Sprintf("feat: t2 for %s (cycle 1 trip %d)", w.id, trip))
		}
	})

	t.Run("validation ENV once then PASS", func(t *testing.T) {
		w := setup(t, testkit.Scenario{"validation-judge": {"ENV", "PASS"}}, options{})
		eq(t, "run", w.run(), driver.Waiting)
		j := w.load()
		stateIs(t, j, job.StageHumanReview, job.WaitHumanReview)
		eq(t, "trip", j.Trip, 1)
		eq(t, "envRetries", j.EnvRetries, 1)
		eq(t, "trips", len(j.Trips), 1)
		eq(t, "e2e validation", j.Trips[0].Validations["e2e"], "PASS")
		eq(t, "validation judge", j.Trips[0].ValidationJudge, "PASS")
		eqSlice(t, "trip folders", w.trips(), []string{"trip-1"})
		// QA was waited on again before the second validation.
		ready := 0
		for _, l := range w.hooks() {
			if strings.HasPrefix(l, "qaReady") {
				ready++
			}
		}
		eq(t, "qaReady runs", ready, 2)
		for _, f := range []string{"validation-e2e.env1.md", "validation-judge.env1.md", "validation-e2e.md", "validation-judge.md"} {
			if _, err := os.Stat(filepath.Join(w.paths.TripDir(1), f)); err != nil {
				t.Error(err)
			}
		}
	})

	t.Run("feedback on done", func(t *testing.T) {
		w := setup(t, nil, options{})
		eq(t, "run", w.run(), driver.Waiting)
		w.approve()
		eq(t, "run", w.run(), driver.Done)

		_, err := app.Feedback(t.Context(), w.repo.Repo, w.id, "Also limit by API key.", w.deps)
		must(t, err)
		j := w.load()
		eq(t, "stage", j.Stage, job.StagePlanning)
		eq(t, "cycle", j.Cycle, 2)
		eq(t, "trip", j.Trip, 1)
		eq(t, "run", w.run(), driver.Waiting)
		j = w.load()
		stateIs(t, j, job.StageHumanReview, job.WaitHumanReview)
		eq(t, "cycle", j.Cycle, 2)
		contains(t, "planner-2", w.task("planner-2"), "Inputs: "+w.paths.Feedback(1))
		w.approve()
		eq(t, "run", w.run(), driver.Done)

		eq(t, "ready calls", fmt.Sprint(w.ghCalls("pr", "ready")),
			fmt.Sprint([][]string{{"pr", "ready", pr}, {"pr", "ready", pr, "--undo"}, {"pr", "ready", pr}}))
		eqSlice(t, "trip folders", w.trips(), []string{"trip-1", "trip-2"})
		contains(t, "log", w.origin("log", "--format=%s", j.Branch), fmt.Sprintf("feat: t1 for %s (cycle 2 trip 1)", w.id))
	})

	t.Run("without commandFor a run fails fast and no real agent starts", func(t *testing.T) {
		w := setup(t, nil, options{realAgents: true})
		j := w.load()
		eq(t, "stage", j.Stage, job.StageRequirements)
		eq(t, "running", len(j.Running), 0)
		// The run script starts the real grill: the claude stub.
		script, err := os.ReadFile(filepath.Join(w.paths.RunDir, "requirements-1.sh"))
		must(t, err)
		contains(t, "run script", string(script), "\nclaude -p \"$(cat ")
		code, err := os.ReadFile(filepath.Join(w.paths.DoneDir, "requirements-1"))
		must(t, err)
		eq(t, "exit code", strings.TrimSpace(string(code)), "99")
		log, err := os.ReadFile(filepath.Join(w.paths.LogsDir, "requirements-1.log"))
		must(t, err)
		contains(t, "agent log", string(log), stubMessage("claude"))
		// Whatever gets past that finds the stubs first on PATH.
		for _, name := range []string{"claude", "pi"} {
			res, err := w.deps.Exec.Run(t.Context(), []string{"bash", "-c", name + " -p hi"}, proc.Opts{})
			must(t, err)
			eq(t, name+" exit code", res.Code, 99)
			eq(t, name+" stderr", res.Stderr, stubMessage(name)+"\n")
		}
	})

	t.Run("NoCommits: a build that leaves no commit opens no PR", func(t *testing.T) {
		w := setup(t, testkit.Scenario{"noCommit": {"1"}}, options{})
		eq(t, "run", w.run(), driver.Waiting)
		j := w.load()
		stateIs(t, j, job.StageNeedsHuman, job.WaitFailure)
		eq(t, "reason", j.Reason, "build made no commits ahead of main: nothing to open a PR for")
		eq(t, "pr create calls", len(w.ghCalls("pr", "create")), 0)
		eq(t, "pr", j.PR, "")
		eq(t, "opened lines", indexOf(w.activity(), "opened draft PR"), -1)
	})
}

func TestPerJobBaseDeliverableAccessUnblockArchive(t *testing.T) {
	t.Run("a stacked job starts from the PR head, opens its PR against it, and titles it from the template", func(t *testing.T) {
		w := setup(t, nil, options{
			config: map[string]any{"prTitle": "[{type}][{ticket}] {summary}"},
			new:    app.NewOptions{Stack: "7"},
			before: func(t *testing.T, repo string) {
				testkit.Git(t, repo, "checkout", "-q", "-b", "develop")
				testkit.Git(t, repo, "commit", "-q", "--allow-empty", "-m", "develop work")
				testkit.Git(t, repo, "push", "-q", "origin", "develop")
				testkit.Git(t, repo, "checkout", "-q", "main")
			},
		})
		j := w.load()
		eq(t, "base", j.Base, "develop")
		contains(t, "requirements-1", w.task("requirements-1"), "Base: develop")
		eq(t, "worktree head", strings.TrimSpace(testkit.Git(t, j.Worktree, "log", "--format=%s", "-1", "HEAD")), "develop work")

		eq(t, "run", w.run(), driver.Waiting)
		create := w.ghCalls("pr", "create")[0]
		eq(t, "--base", create[slices.Index(create, "--base")+1], "develop")
		// The request names no ticket: its brackets go.
		eq(t, "--title", create[slices.Index(create, "--title")+1], "[feature] Requirements for "+w.id)
		w.approve()
		eq(t, "run", w.run(), driver.Done)
		eq(t, "title calls", fmt.Sprint(w.ghCalls("pr", "edit", pr, "--title")), fmt.Sprint([][]string{{"pr", "edit", pr, "--title", "[feature] Add rate limiting"}}))
		contains(t, "summarizer-1", w.task("summarizer-1"), `the factory formats the title as "[{type}][{ticket}] {summary}"`)
	})

	t.Run("a report job: no PR or push, a blocked reporter resumes with the decision, then delivers", func(t *testing.T) {
		w := setup(t, testkit.Scenario{"deliverable": {"report"}, "reporter": {"BLOCKED", "READY"}}, options{})
		j := w.load()
		eq(t, "stage", j.Stage, job.StageReport)
		eq(t, "deliverable", j.Deliverable, job.DeliverReport)
		eq(t, "run", w.run(), driver.Waiting)
		j = w.load()
		stateIs(t, j, job.StageNeedsHuman, job.WaitFailure)
		eq(t, "reason", j.Reason, "reporter: blocked: The sheet is not shared with you.")

		_, err := app.Unblock(t.Context(), w.repo.Repo, w.id, "Use the copy in the team drive.", w.deps)
		must(t, err)
		j = w.load()
		eq(t, "stage", j.Stage, job.StageReport)
		eqSlice(t, "decisions", j.Decisions, []string{w.paths.Decision(1)})
		decision, err := os.ReadFile(w.paths.Decision(1))
		must(t, err)
		contains(t, "decision", string(decision), "Use the copy in the team drive.")
		eq(t, "run", w.run(), driver.Waiting)
		stateIs(t, w.load(), job.StageHumanReview, job.WaitHumanReview)
		contains(t, "reporter-2", w.task("reporter-2"), w.paths.Decision(1))
		eq(t, "last note", w.notes[len(w.notes)-1], "Read the report: .factory/jobs/"+w.id+"/report.md")

		w.approve()
		eq(t, "run", w.run(), driver.Done)
		eq(t, "pr calls", len(w.ghCalls("pr")), 0)
		cmd := exec.CommandContext(t.Context(), "git", "rev-parse", "--verify", w.load().Branch)
		cmd.Dir = w.repo.Origin
		if err := cmd.Run(); err == nil {
			t.Error("a report job pushed its branch")
		}
	})

	t.Run("a missing access stops the job in preflight, before any PR; a retry goes on", func(t *testing.T) {
		w := setup(t, testkit.Scenario{"access": {"gh CLI logged in"}, "access-checker": {"BLOCKED", "READY"}}, options{})
		j := w.load()
		stateIs(t, j, job.StageNeedsHuman, job.WaitFailure)
		eq(t, "resumeStage", j.ResumeStage, job.StagePreflight)
		eq(t, "reason", j.Reason, "access-checker: blocked: gh CLI logged in: not logged in. Fix: run gh auth login")
		eq(t, "pr create calls", len(w.ghCalls("pr", "create")), 0)
		_, err := app.Retry(t.Context(), w.repo.Repo, w.id, w.deps)
		must(t, err)
		eq(t, "run", w.run(), driver.Waiting)
		j = w.load()
		stateIs(t, j, job.StageHumanReview, job.WaitHumanReview)
		eq(t, "pr", j.PR, pr)
		access, err := os.ReadFile(w.paths.AccessFile)
		must(t, err)
		if !strings.HasPrefix(string(access), "STATUS: READY") {
			t.Errorf("access.md starts %q", access)
		}
	})

	t.Run("discard archives the job folder, so the next job gets the same id", func(t *testing.T) {
		w := setup(t, nil, options{})
		_, err := app.Discard(t.Context(), w.repo.Repo, w.id, w.deps)
		must(t, err)
		if _, err := os.Stat(w.paths.JobDir); err == nil {
			t.Error("the job folder is still there")
		}
		entries, err := os.ReadDir(filepath.Join(w.paths.FactoryDir, "archive"))
		must(t, err)
		if len(entries) != 1 || !regexp.MustCompile("^"+regexp.QuoteMeta(w.id)+`-\d+$`).MatchString(entries[0].Name()) {
			t.Errorf("archive = %v", entries)
		}
		again, err := app.New(t.Context(), w.repo.Repo, "Add rate limiting", app.NewOptions{}, w.deps, w.deps)
		must(t, err)
		eq(t, "new id", again.Job.ID, w.id)
	})
}

func TestTheGrill(t *testing.T) {
	t.Run("a turn asks, shows the pending question again, takes the answer, then finishes", func(t *testing.T) {
		w := setup(t, nil, options{noGrill: true})
		contains(t, "question", w.asked, "Who is it for?")
		// No answer yet: the same question, and no new agent.
		again, err := app.Answer(t.Context(), w.repo.Repo, w.id, nil, w.deps, w.deps)
		must(t, err)
		eq(t, "pending question", again.Question, w.asked)
		if _, err := os.Stat(filepath.Join(w.paths.RunDir, "requirements-2.task.md")); err == nil {
			t.Error("a second agent started")
		}
		done := w.answer("Admins.")
		eq(t, "question", done.Question, "")
		eq(t, "stage", done.Job.Stage, job.StageTechDiscovery)
		contains(t, "requirements-2", w.task("requirements-2"), filepath.Join(w.paths.GrillDir, "transcript.md"))
		eq(t, "stage", w.load().Stage, job.StageTechDiscovery)
	})

	t.Run("a long turn logs a heartbeat with its latest tool call", func(t *testing.T) {
		w := setup(t, testkit.Scenario{"sleepMs": {"600"}}, options{noGrill: true, heartbeat: 100})
		beat := regexp.MustCompile(`^… ` + regexp.QuoteMeta(w.id) + `: requirements running \d+s, last: Read {2}AGENTS\.md$`)
		w.mu.Lock()
		found := slices.ContainsFunc(w.logs, beat.MatchString)
		before := len(w.logs)
		w.mu.Unlock()
		if !found {
			t.Errorf("no heartbeat line in %q", w.logs)
		}
		time.Sleep(250 * time.Millisecond)
		// Stopped with the agent.
		w.mu.Lock()
		defer w.mu.Unlock()
		eq(t, "log lines", len(w.logs), before)
	})

	t.Run("an answer with no pending question, or outside the grill, is refused", func(t *testing.T) {
		w := setup(t, nil, options{noGrill: true})
		// The grill agent left no question behind.
		must(t, os.Remove(filepath.Join(w.paths.GrillDir, "question.md")))
		hi := "hi"
		_, err := app.Answer(t.Context(), w.repo.Repo, w.id, &hi, w.deps, w.deps)
		if err == nil || !strings.Contains(err.Error(), "no question is pending for "+w.id) {
			t.Fatalf("answer with no question: %v", err)
		}
		must(t, os.WriteFile(filepath.Join(w.paths.GrillDir, "question.md"), []byte(w.asked+"\n"), 0o600))
		w.answer("Admins.")
		more := "more"
		_, err = app.Answer(t.Context(), w.repo.Repo, w.id, &more, w.deps, w.deps)
		if err == nil || !strings.Contains(err.Error(), "is not in the grill") {
			t.Fatalf("answer outside the grill: %v", err)
		}
	})
}

func TestHarnessIsChosenPerJob(t *testing.T) {
	// seen is every harness CommandFor got, and whether a browser role was one of the agents.
	seen := func(t *testing.T, w *world) (all []config.Harness, browser bool) {
		t.Helper()
		for role, hs := range w.harnesses {
			all = append(all, hs...)
			r, err := harness.LoadRole(factory.Roles, role)
			must(t, err)
			browser = browser || r.Browser
		}
		return all, browser
	}

	t.Run("pi: job.json says pi and every agent, browser roles included, gets pi", func(t *testing.T) {
		w := setup(t, nil, options{new: app.NewOptions{Harness: config.Pi}})
		eq(t, "run", w.run(), driver.Waiting)
		data, err := os.ReadFile(w.paths.JobFile)
		must(t, err)
		contains(t, "job.json", string(data), `"harness": "pi"`)
		all, browser := seen(t, w)
		if len(all) == 0 || !browser {
			t.Fatalf("agents seen: %d, a browser role among them: %v", len(all), browser)
		}
		for _, h := range all {
			eq(t, "harness", h, config.Pi)
		}
	})

	t.Run("no flag: claude", func(t *testing.T) {
		w := setup(t, nil, options{noGrill: true})
		data, err := os.ReadFile(w.paths.JobFile)
		must(t, err)
		contains(t, "job.json", string(data), `"harness": "claude"`)
		all, _ := seen(t, w)
		for _, h := range all {
			eq(t, "harness", h, config.Claude)
		}
	})

	t.Run("an unknown harness fails before any job folder, branch or worktree", func(t *testing.T) {
		r := testkit.TempRepo(t)
		root := filepath.Dir(r.Repo)
		exec := envRunner{env: map[string]string{"FAKE_GH_DIR": root}}
		d := deps.Deps{
			Exec: exec, Git: &git.Git{Exec: exec, Repo: r.Repo}, GH: &git.GitHub{Exec: exec, Repo: r.Repo},
			Roles: factory.Roles, Self: bins.Factory, Now: testkit.NewFakeClock().Now, Log: func(string) {},
		}
		_, err := app.New(t.Context(), r.Repo, "Add rate limiting", app.NewOptions{Harness: "foo"}, d, d)
		if err == nil || !strings.Contains(err.Error(), `unknown harness "foo"`) {
			t.Fatalf("err = %v", err)
		}
		if _, err := os.Stat(filepath.Join(r.Repo, ".factory")); err == nil {
			t.Error(".factory exists")
		}
		eq(t, "branches", strings.TrimSpace(testkit.Git(t, r.Repo, "branch", "--format=%(refname:short)")), "main")
		eq(t, "worktrees", strings.Count(testkit.Git(t, r.Repo, "worktree", "list"), "\n"), 1)
	})
}

func TestFailureTail(t *testing.T) {
	w := setup(t, nil, options{config: map[string]any{
		"hooks": map[string]string{"prOpened": "seq 1 25; exit 1"},
	}})
	eq(t, "run", w.run(), driver.Waiting)
	j := w.load()
	stateIs(t, j, job.StageNeedsHuman, job.WaitFailure)

	summary := "hook prOpened failed (exit 1): 25"
	var tail []string
	for i := 6; i <= 25; i++ {
		tail = append(tail, strconv.Itoa(i))
	}
	eq(t, "reason", j.Reason, summary+"\n\n"+strings.Join(tail, "\n"))

	// factory status <id> prints all of them.
	detail, err := app.Status(w.repo.Repo, w.id, false, w.deps.Now())
	must(t, err)
	for _, l := range tail {
		contains(t, "status detail", detail, "\n  "+l+"\n")
	}
	contains(t, "status detail", detail, "Needs you: Failed: "+summary+"\n")
	// The table row, the activity line and the PR headline hold only the summary.
	table, err := app.Status(w.repo.Repo, "", false, w.deps.Now())
	must(t, err)
	headlineOnly(t, "status table", table, tail)
	activity := strings.Join(w.activity(), "\n")
	contains(t, "activity", activity, summary)
	headlineOnly(t, "activity log", activity, tail[:len(tail)-1])
	status, _, _ := strings.Cut(w.body(), "<!-- /factory:status -->")
	contains(t, "PR status block", status, summary)
	headlineOnly(t, "PR status block", status, tail[:len(tail)-1])
}

// headlineOnly fails when any of the tail lines stands alone on a line of text.
func headlineOnly(t testing.TB, what, text string, tail []string) {
	t.Helper()
	for l := range strings.SplitSeq(text, "\n") {
		if slices.Contains(tail, strings.TrimSpace(l)) {
			t.Errorf("%s has the tail line %q:\n%s", what, l, text)
		}
	}
}

func indexOf(lines []string, sub string) int {
	return slices.IndexFunc(lines, func(l string) bool { return strings.Contains(l, sub) })
}

func lineWith(text, sub string) string {
	for l := range strings.SplitSeq(text, "\n") {
		if strings.Contains(l, sub) {
			return l
		}
	}
	return ""
}
