package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/testkit"
)

func TestMain(m *testing.M) {
	testkit.ClearGitEnv()
	os.Exit(m.Run())
}

// factory runs the CLI in repo and returns its exit code and both streams.
func factory(t *testing.T, repo string, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errb bytes.Buffer
	code = Execute(context.Background(), append(args, "--repo", repo), &out, &errb)
	return code, out.String(), errb.String()
}

func seedJob(t *testing.T, repo string, mutate func(*job.Job)) job.Job {
	t.Helper()
	j := job.New(job.NewArgs{ID: "demo", Branch: "feature/demo", Base: "main", Feature: "Demo", Repo: repo, Harness: "claude", Now: time.Now()})
	mutate(&j)
	if err := job.Save(job.NewPaths(repo, j.ID).JobFile, &j, time.Now()); err != nil {
		t.Fatal(err)
	}
	return j
}

func TestStatusEmptyAndUnknownJob(t *testing.T) {
	r := testkit.TempRepo(t)
	code, out, _ := factory(t, r.Repo, "status")
	if code != 0 || !strings.Contains(out, "No factory jobs yet") {
		t.Fatalf("status: code %d, out %q", code, out)
	}
	code, _, errOut := factory(t, r.Repo, "status", "nope")
	if code != 1 || !strings.Contains(errOut, "factory: no job nope") {
		t.Fatalf("status nope: code %d, err %q", code, errOut)
	}
}

func TestStatusJSONHasHintAndWhatFor(t *testing.T) {
	r := testkit.TempRepo(t)
	seedJob(t, r.Repo, func(*job.Job) {})
	code, out, _ := factory(t, r.Repo, "status", "--json")
	if code != 0 {
		t.Fatalf("code %d", code)
	}
	var jobs []map[string]any
	if err := json.Unmarshal([]byte(out), &jobs); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if len(jobs) != 1 || jobs[0]["version"] != float64(3) || jobs[0]["hint"] != "factory answer demo" || jobs[0]["whatFor"] == "" {
		t.Fatalf("got %v", jobs)
	}
}

func TestStatusDetailShowsFullReason(t *testing.T) {
	r := testkit.TempRepo(t)
	seedJob(t, r.Repo, func(j *job.Job) {
		j.Stage, j.WaitingFor = job.StageNeedsHuman, job.WaitFailure
		j.Reason = "git push failed (exit 1): boom\n\nline one\nboom"
	})
	_, out, _ := factory(t, r.Repo, "status", "demo")
	for _, want := range []string{"Failed: git push failed (exit 1): boom", "  line one", "  boom"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestDiscardNeedsYesWithoutTerminal(t *testing.T) {
	r := testkit.TempRepo(t)
	seedJob(t, r.Repo, func(*job.Job) {})
	code, _, errOut := factory(t, r.Repo, "discard", "demo")
	if code != 1 || !strings.Contains(errOut, "refusing to discard demo without --yes") {
		t.Fatalf("code %d, err %q", code, errOut)
	}
}

func TestUnblockRefusesAJobThatIsNotStopped(t *testing.T) {
	r := testkit.TempRepo(t)
	seedJob(t, r.Repo, func(*job.Job) {})
	code, _, errOut := factory(t, r.Repo, "unblock", "demo", "--", "use staging")
	if code != 1 || !strings.HasPrefix(errOut, "factory: ") {
		t.Fatalf("code %d, err %q", code, errOut)
	}
	if _, err := os.Stat(filepath.Join(job.NewPaths(r.Repo, "demo").JobDir, "decision-1.md")); err == nil {
		t.Fatal("a refused unblock left a decision file")
	}
}

func TestRepoRefusesLinkedWorktree(t *testing.T) {
	r := testkit.TempRepo(t)
	wt := filepath.Join(t.TempDir(), "wt")
	testkit.Git(t, r.Repo, "worktree", "add", "-b", "other", wt)
	code, _, errOut := factory(t, wt, "status")
	if code != 1 || !strings.Contains(errOut, "--repo is a linked worktree") {
		t.Fatalf("code %d, err %q", code, errOut)
	}
}

func TestNewWithoutFeatureAndTailBadFormat(t *testing.T) {
	r := testkit.TempRepo(t)
	if code, _, _ := factory(t, r.Repo, "new"); code != 1 {
		t.Fatalf("new without a feature: code %d", code)
	}
	if code, _, errOut := factory(t, r.Repo, "tail", "--format", "x"); code != 1 || !strings.Contains(errOut, "usage: factory tail") {
		t.Fatalf("tail: code %d, err %q", code, errOut)
	}
}
