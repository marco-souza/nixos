package testkit

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Repo is a temporary git repo and the bare origin it was pushed to.
type Repo struct {
	Repo   string
	Origin string
}

// Git runs git in dir and fails the test on error.
func Git(t testing.TB, dir string, args ...string) string {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), "git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

// TempRepo makes a repo with one commit on main and a bare origin it was
// pushed to. It fails at once while any variable in GitEnv is set.
func TempRepo(t testing.TB) Repo {
	t.Helper()
	for _, k := range GitEnv {
		if _, set := os.LookupEnv(k); set {
			t.Fatalf("%s is set: call testkit.ClearGitEnv in TestMain", k)
		}
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	r := Repo{Repo: filepath.Join(root, "repo"), Origin: filepath.Join(root, "origin.git")}
	Git(t, root, "init", "--bare", "-b", "main", r.Origin)
	Git(t, root, "init", "-b", "main", r.Repo)
	Git(t, r.Repo, "config", "user.name", "Test")
	Git(t, r.Repo, "config", "user.email", "test@example.com")
	Git(t, r.Repo, "config", "commit.gpgsign", "false")
	Git(t, r.Repo, "commit", "--allow-empty", "-m", "init")
	Git(t, r.Repo, "remote", "add", "origin", r.Origin)
	Git(t, r.Repo, "push", "-u", "origin", "main")
	return r
}
