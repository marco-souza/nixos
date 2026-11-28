//go:build unix

package proc

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/marco-souza/nixos/stow/factory/internal/job"
)

const driverName = "driver"

// ProcessSpawner runs background processes, one pid file each under the
// job's run folder. They outlive the command that started them.
type ProcessSpawner struct {
	Repo string
	// Self is the factory binary the run scripts pipe their output through.
	Self string
}

func (s ProcessSpawner) paths(jobID string) job.Paths { return job.NewPaths(s.Repo, jobID) }

func (s ProcessSpawner) launch(jobID, name string, argv []string, cwd, logFile string) error {
	p := s.paths(jobID)
	if err := os.MkdirAll(filepath.Dir(logFile), 0o750); err != nil {
		return err
	}
	if err := os.MkdirAll(p.RunDir, 0o750); err != nil {
		return err
	}
	f, err := os.OpenFile(logFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	cmd := exec.CommandContext(context.Background(), argv[0], argv[1:]...)
	cmd.Dir = cwd
	cmd.Stdout = f
	cmd.Stderr = f
	// Not tied to a ctx: the process must outlive the command that started it.
	// Its own session and process group, so Kill takes the whole tree and a
	// closed terminal doesn't.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", name, err)
	}
	// Reap the child as soon as it exits, so it never lingers as a zombie.
	go func() { _ = cmd.Wait() }()
	return os.WriteFile(pidFile(p.RunDir, name), []byte(strconv.Itoa(cmd.Process.Pid)), 0o600)
}

// pid is the live pid of process name, or 0.
func (s ProcessSpawner) pid(jobID, name string) int {
	b, err := os.ReadFile(pidFile(s.paths(jobID).RunDir, name))
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || n <= 0 {
		return 0
	}
	// EPERM means the process exists but belongs to someone else.
	if err := syscall.Kill(n, 0); err != nil && !errors.Is(err, syscall.EPERM) {
		return 0
	}
	return n
}

// Start implements Spawner.
func (s ProcessSpawner) Start(_ context.Context, req SpawnRequest) error {
	if _, err := WriteRunScript(s.Self, req); err != nil {
		return err
	}
	return s.launch(req.JobID, req.Window, []string{"bash", req.ScriptFile}, req.Cwd, req.ScriptFile+".out")
}

// IsAlive implements Spawner.
func (s ProcessSpawner) IsAlive(jobID, window string) bool { return s.pid(jobID, window) != 0 }

// Kill implements Spawner.
func (s ProcessSpawner) Kill(jobID, window string) {
	if pid := s.pid(jobID, window); pid != 0 {
		_ = syscall.Kill(-pid, syscall.SIGTERM) // gone already is fine
	}
}

// KillAgents implements Spawner.
func (s ProcessSpawner) KillAgents(jobID string) {
	entries, err := os.ReadDir(s.paths(jobID).RunDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), ".pid")
		if ok && name != driverName {
			s.Kill(jobID, name)
		}
	}
}

// RespawnDriver implements Spawner.
func (s ProcessSpawner) RespawnDriver(jobID, cwd, driverCmd string) error {
	// Never kill ourselves: `factory run --here` is the driver.
	if old := s.pid(jobID, driverName); old != 0 && old != os.Getpid() {
		s.Kill(jobID, driverName)
	}
	return s.launch(jobID, driverName, []string{"bash", "-c", "exec " + driverCmd}, cwd,
		filepath.Join(s.paths(jobID).LogsDir, "driver.log"))
}
