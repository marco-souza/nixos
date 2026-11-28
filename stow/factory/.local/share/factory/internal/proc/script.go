package proc

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// SpawnRequest is one agent run.
type SpawnRequest struct {
	JobID      string
	Window     string
	Cwd        string
	Command    string
	ScriptFile string
	LogFile    string
	DoneFile   string
	// Tail is the harness to format output for ("claude", "pi"); "" means none.
	Tail string
}

// Spawner starts agents and the driver in the background.
type Spawner interface {
	Start(ctx context.Context, req SpawnRequest) error
	IsAlive(jobID, window string) bool
	Kill(jobID, window string)
	// KillAgents stops every agent of the job, not the driver.
	KillAgents(jobID string)
	// RespawnDriver starts the job's driver in the background, replacing a
	// running one. It errors when it can't start.
	RespawnDriver(jobID, cwd, driverCmd string) error
}

// Shq single-quotes s for bash.
func Shq(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// WriteRunScript writes req.ScriptFile and returns its content. self is the
// factory binary the output pipes through.
func WriteRunScript(self string, req SpawnRequest) (string, error) {
	tail := ""
	if req.Tail != "" {
		tail = " | " + Shq(self) + " tail --format " + req.Tail
	}
	// A bad cwd must still leave an exit code, or the waiter runs to its timeout.
	cdFail := "{ echo 97 > " + Shq(req.DoneFile) + "; exit 97; }"
	lines := []string{
		"#!/usr/bin/env bash",
		"set -o pipefail",
		"cd " + Shq(req.Cwd) + " || " + cdFail,
		req.Command + " 2>&1 | tee -a " + Shq(req.LogFile) + tail,
		`echo "${PIPESTATUS[0]}" > ` + Shq(req.DoneFile),
	}
	script := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(req.ScriptFile, []byte(script), 0o600); err != nil {
		return "", err
	}
	return script, nil
}

// InlineSpawner has the Spawner contract without processes: Start runs the
// script to completion. For the grill, tests and --inline.
type InlineSpawner struct {
	Exec Runner
	Self string
}

// Start implements Spawner.
func (s InlineSpawner) Start(ctx context.Context, req SpawnRequest) error {
	if _, err := WriteRunScript(s.Self, req); err != nil {
		return err
	}
	_, err := s.Exec.Run(ctx, []string{"bash", req.ScriptFile}, Opts{})
	return err
}

// IsAlive implements Spawner.
func (InlineSpawner) IsAlive(string, string) bool { return false }

// Kill implements Spawner.
func (InlineSpawner) Kill(string, string) {}

// KillAgents implements Spawner.
func (InlineSpawner) KillAgents(string) {}

// RespawnDriver implements Spawner.
func (InlineSpawner) RespawnDriver(string, string, string) error { return nil }

// WaitOptions control WaitForFile.
type WaitOptions struct {
	Timeout time.Duration
	Poll    time.Duration
	Sleep   func(ctx context.Context, d time.Duration) error
	Now     func() time.Time
}

// WaitForFile checks pred first, then every Poll until Timeout has passed. It
// reports whether pred became true; the error is ctx's.
func WaitForFile(ctx context.Context, pred func() bool, o WaitOptions) (bool, error) {
	start := o.Now()
	for {
		if pred() {
			return true, nil
		}
		if o.Now().Sub(start) >= o.Timeout {
			return false, nil
		}
		if err := o.Sleep(ctx, o.Poll); err != nil {
			return false, err
		}
	}
}

// ReadExitCode is the exit code in a done file; ok is false when the file is
// missing or does not hold an integer.
func ReadExitCode(doneFile string) (code int, ok bool) {
	b, err := os.ReadFile(doneFile)
	if err != nil {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return 0, false
	}
	return n, true
}

// pidFile is where agent name's pid is kept.
func pidFile(runDir, name string) string { return filepath.Join(runDir, name+".pid") }
