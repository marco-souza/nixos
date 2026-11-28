package testkit

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	ClearGitEnv()
	os.Exit(m.Run())
}

func TestTempRepo(t *testing.T) {
	r := TempRepo(t)
	if err := os.WriteFile(filepath.Join(r.Repo, "a.txt"), []byte("a\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	Git(t, r.Repo, "add", "a.txt")
	Git(t, r.Repo, "commit", "-m", "add a")
	Git(t, r.Repo, "push", "origin", "main")
	local := strings.TrimSpace(Git(t, r.Repo, "rev-parse", "HEAD"))
	remote := strings.TrimSpace(Git(t, r.Origin, "rev-parse", "main"))
	if local != remote {
		t.Errorf("origin main = %s, want %s", remote, local)
	}
}

// snapshot is what must not change in the sentinel repo.
func snapshot(t *testing.T, repo string) string {
	t.Helper()
	head, err := os.ReadFile(filepath.Join(repo, ".git", "HEAD"))
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := os.ReadFile(filepath.Join(repo, ".git", "config"))
	if err != nil {
		t.Fatal(err)
	}
	return string(head) + "\n" + Git(t, repo, "for-each-ref") + "\n" + string(cfg)
}

// TestGitEnvCleared is the hook's situation: git's variables point at another
// repo while the tests run. The rerun's TestMain must clear them.
func TestGitEnvCleared(t *testing.T) {
	sentinel := TempRepo(t).Repo
	before := snapshot(t, sentinel)

	cmd := exec.CommandContext(t.Context(), os.Args[0], "-test.run", "^TestTempRepo$") //nolint:gosec // reruns this test binary
	cmd.Env = append(os.Environ(),
		"GIT_DIR="+filepath.Join(sentinel, ".git"),
		"GIT_WORK_TREE="+sentinel,
		"GIT_INDEX_FILE="+filepath.Join(sentinel, ".git", "index"),
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("rerun: %v\n%s", err, out)
	}
	if after := snapshot(t, sentinel); after != before {
		t.Errorf("sentinel repo changed:\nbefore:\n%s\nafter:\n%s", before, after)
	}
}
