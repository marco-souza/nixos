//go:build unix

package proc

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/testkit"
)

func until(pred func() bool) bool {
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if pred() {
			return true
		}
	}
	return pred()
}

func setup(t *testing.T) (ProcessSpawner, job.Paths) {
	t.Helper()
	repo := testkit.TempRepo(t).Repo
	p := job.NewPaths(repo, "j")
	for _, d := range []string{p.RunDir, p.LogsDir, p.DoneDir} {
		if err := os.MkdirAll(d, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	return ProcessSpawner{Repo: repo, Self: "factory"}, p
}

func TestAgentRunsInBackgroundAndKillTakesItsTree(t *testing.T) {
	s, p := setup(t)
	err := s.Start(context.Background(), SpawnRequest{
		JobID: "j", Window: "sleeper", Cwd: p.JobDir, Command: "sleep 30",
		ScriptFile: filepath.Join(p.RunDir, "sleeper.sh"), LogFile: filepath.Join(p.LogsDir, "sleeper.log"),
		DoneFile: filepath.Join(p.DoneDir, "sleeper"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !s.IsAlive("j", "sleeper") {
		t.Fatal("agent not alive after Start")
	}
	s.KillAgents("j")
	if !until(func() bool { return !s.IsAlive("j", "sleeper") }) {
		t.Fatal("agent still alive after KillAgents")
	}
}

func TestQuickAgentLeavesExitCode(t *testing.T) {
	s, p := setup(t)
	done := filepath.Join(p.DoneDir, "quick")
	err := s.Start(context.Background(), SpawnRequest{
		JobID: "j", Window: "quick", Cwd: p.JobDir, Command: "echo hi",
		ScriptFile: filepath.Join(p.RunDir, "quick.sh"), LogFile: filepath.Join(p.LogsDir, "quick.log"), DoneFile: done,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !until(func() bool { _, ok := ReadExitCode(done); return ok }) {
		t.Fatal("no exit code written")
	}
	if code, _ := ReadExitCode(done); code != 0 {
		t.Errorf("exit code = %d, want 0", code)
	}
	if !until(func() bool { return !s.IsAlive("j", "quick") }) {
		t.Error("quick agent still alive")
	}
	if err := os.WriteFile(filepath.Join(p.RunDir, "driver.pid"), []byte("junk"), 0o600); err != nil {
		t.Fatal(err)
	}
	if s.IsAlive("j", "driver") {
		t.Error("junk pid file must not count as alive")
	}
}

func TestWaitForFile(t *testing.T) {
	now := time.Unix(0, 0)
	o := WaitOptions{
		Timeout: 10 * time.Second, Poll: time.Second, Now: func() time.Time { return now },
		Sleep: func(_ context.Context, d time.Duration) error { now = now.Add(d); return nil },
	}
	n := 0
	if ok, _ := WaitForFile(context.Background(), func() bool { n++; return n == 3 }, o); !ok {
		t.Error("want done")
	}
	if ok, _ := WaitForFile(context.Background(), func() bool { return false }, o); ok {
		t.Error("want timeout")
	}
}
