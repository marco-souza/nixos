package driver

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
	"github.com/marco-souza/nixos/stow/factory/internal/deps"
	"github.com/marco-souza/nixos/stow/factory/internal/git"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/proc"
	"github.com/marco-souza/nixos/stow/factory/internal/testkit"
)

func TestMain(m *testing.M) {
	testkit.ClearGitEnv()
	os.Exit(m.Run())
}

// fakeRunner records every command and answers from a table keyed by the
// command's first two words.
type fakeRunner struct {
	mu    sync.Mutex
	calls [][]string
	envs  []map[string]string
	out   map[string]string
}

func (f *fakeRunner) Run(_ context.Context, argv []string, o proc.Opts) (proc.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, argv)
	f.envs = append(f.envs, o.Env)
	key := strings.Join(argv[:min(2, len(argv))], " ")
	return proc.Result{Stdout: f.out[key]}, nil
}

func newTestRun(t *testing.T, f *fakeRunner) *run {
	t.Helper()
	repo := t.TempDir()
	paths := job.NewPaths(repo, "j1")
	d := deps.Deps{
		Exec: f,
		Git:  &git.Git{Exec: f, Repo: repo},
		GH:   &git.GitHub{Exec: f, Repo: repo},
		Now:  time.Now,
		Log:  func(string) {},
	}
	j := job.New(job.NewArgs{ID: "j1", Branch: "fea/j1", Base: "main", Feature: "x", Harness: config.Claude, Repo: repo, Now: time.Now()})
	return &run{repo: repo, paths: paths, cfg: config.Defaults(), deps: d, job: j}
}

func TestEnsurePRDoesNothingWhileNotAhead(t *testing.T) {
	f := &fakeRunner{out: map[string]string{"git rev-list": "0\n"}}
	r := newTestRun(t, f)
	if err := r.ensurePR(t.Context()); err != nil {
		t.Fatal(err)
	}
	for _, c := range f.calls {
		if c[0] == "gh" {
			t.Fatalf("gh was called: %v", c)
		}
	}
	if len(f.calls) != 1 || f.calls[0][1] != "rev-list" {
		t.Fatalf("calls = %v, want only the rev-list count", f.calls)
	}
	if got := r.snapshot().PR; got != "" {
		t.Fatalf("PR = %q, want none", got)
	}
}

func TestPushProofSkipsHooksAndAddsOnlyTheProofFolder(t *testing.T) {
	f := &fakeRunner{out: map[string]string{"git write-tree": "tree1\n", "git commit-tree": "sha1\n"}}
	r := newTestRun(t, f)
	proofDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(proofDir, "ac1-x.txt"), []byte("$ x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sha, err := pushProof(t.Context(), f, r.repo, proofDir, "j1", filepath.Join(t.TempDir(), "idx"))
	if err != nil {
		t.Fatal(err)
	}
	if sha != "sha1" {
		t.Fatalf("sha = %q", sha)
	}
	var adds, pushes [][]string
	for _, c := range f.calls {
		if slices.Contains(c, "add") {
			adds = append(adds, c)
		}
		if slices.Contains(c, "push") {
			pushes = append(pushes, c)
		}
	}
	wantAdd := []string{"git", "--work-tree=" + proofDir, "add", "-A", "."}
	if len(adds) != 1 || !slices.Equal(adds[0], wantAdd) {
		t.Fatalf("adds = %v, want one %v", adds, wantAdd)
	}
	wantPush := []string{"git", "push", "--no-verify", "--force", "origin", "sha1:refs/heads/factory-proof/j1"}
	if len(pushes) != 1 || !slices.Equal(pushes[0], wantPush) {
		t.Fatalf("pushes = %v, want one %v", pushes, wantPush)
	}
	for _, e := range f.envs {
		if e["GIT_INDEX_FILE"] == "" {
			t.Fatalf("a proof git call ran without its own index: %v", e)
		}
	}
}

func TestPushProofEmptyFolderPushesNothing(t *testing.T) {
	f := &fakeRunner{}
	sha, err := pushProof(t.Context(), f, t.TempDir(), t.TempDir(), "j1", filepath.Join(t.TempDir(), "idx"))
	if err != nil || sha != "" || len(f.calls) != 0 {
		t.Fatalf("sha=%q err=%v calls=%v", sha, err, f.calls)
	}
}

func TestConcurrentUpdatesDoNotRace(t *testing.T) {
	r := newTestRun(t, &fakeRunner{})
	const n = 40
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() {
			if err := r.update(func(j *job.Job) { j.Running = append(j.Running, "w"+strconv.Itoa(i)) }); err != nil {
				t.Error(err)
			}
			_ = r.snapshot()
		})
	}
	wg.Wait()
	if got := len(r.snapshot().Running); got != n {
		t.Fatalf("running = %d, want %d", got, n)
	}
	saved, err := job.Load(r.paths.JobFile)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Running) != n {
		t.Fatalf("saved running = %d, want %d", len(saved.Running), n)
	}
}

func TestRenderTitle(t *testing.T) {
	tests := []struct {
		tmpl string
		v    map[string]string
		want string
	}{
		{"[{type}][{ticket}] {summary}", map[string]string{"type": "fix", "summary": "Raise the cache timeout"}, "[fix] Raise the cache timeout"},
		{"[{type}][{ticket}] {summary}", map[string]string{"type": "fix", "ticket": "ABC-1", "summary": "S"}, "[fix][ABC-1] S"},
		{"{summary}", map[string]string{"summary": "only"}, "only"},
	}
	for _, tt := range tests {
		if got := renderTitle(tt.tmpl, tt.v); got != tt.want {
			t.Errorf("renderTitle(%q) = %q, want %q", tt.tmpl, got, tt.want)
		}
	}
}

func TestDecisionFencesTheFullReason(t *testing.T) {
	r := newTestRun(t, &fakeRunner{})
	j := r.snapshot()
	j.Stage, j.WaitingFor, j.Reason = job.StageNeedsHuman, job.WaitFailure, "git push failed (exit 1): boom\n\nline 1\nline 2"
	got := r.decision(j)
	if !strings.Contains(got, "```text\n"+j.Reason+"\n```") {
		t.Fatalf("decision = %q", got)
	}
}
