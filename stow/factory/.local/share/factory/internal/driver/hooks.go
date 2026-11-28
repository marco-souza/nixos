package driver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/proc"
	"github.com/marco-souza/nixos/stow/factory/internal/ui"
)

type hookName string

const (
	hookPROpened hookName = "prOpened"
	hookQAURL    hookName = "qaUrl"
	hookQAReady  hookName = "qaReady"
)

// script is the hook's configured script; "" when it is not configured.
func (r *run) script(name hookName) string {
	switch name {
	case hookPROpened:
		return r.cfg.Hooks.PROpened
	case hookQAURL:
		return r.cfg.Hooks.QAURL
	case hookQAReady:
		return r.cfg.Hooks.QAReady
	}
	return ""
}

// runHook runs a configured hook with bash in the worktree, with JOB, PR,
// BRANCH and SHA in its environment. ok is false when the hook is not
// configured. A non-zero exit is the caller's call.
func (r *run) runHook(ctx context.Context, name hookName) (res proc.Result, ok bool, err error) {
	script := r.script(name)
	if script == "" {
		return proc.Result{}, false, nil
	}
	j := r.snapshot()
	sha, err := r.deps.Git.Head(ctx, j.Worktree)
	if err != nil {
		return proc.Result{}, false, err
	}
	res, err = r.deps.Exec.Run(ctx, []string{"bash", "-c", script}, proc.Opts{
		Dir: j.Worktree,
		Env: map[string]string{"JOB": j.ID, "PR": j.PR, "BRANCH": j.Branch, "SHA": sha},
	})
	return res, true, err
}

// hook runs a configured hook and turns a non-zero exit into an
// *proc.ExitError. ok is false when it is not configured.
func (r *run) hook(ctx context.Context, name hookName) (stdout string, ok bool, err error) {
	res, ok, err := r.runHook(ctx, name)
	if err != nil || !ok {
		return "", ok, err
	}
	return res.Stdout, true, proc.Check([]string{"hook", string(name)}, res)
}

// prOpened assigns the QA env, so it must have run once per PR; its marker
// lets a retry run it again until it passes.
func (r *run) prOpened(ctx context.Context) error {
	marker := filepath.Join(r.paths.JobDir, "prOpened.ok")
	if _, err := os.Stat(marker); err == nil {
		return nil
	}
	_, ok, err := r.hook(ctx, hookPROpened)
	if err != nil {
		return err
	}
	if ok {
		return os.WriteFile(marker, []byte(r.snapshot().PR+"\n"), 0o600)
	}
	return nil
}

// qaURL asks the qaUrl hook for the QA env when there is none yet. A failure
// is noted: validators then use a local port.
func (r *run) qaURL(ctx context.Context) error {
	if r.snapshot().QAURL != "" {
		return nil
	}
	out, ok, err := r.hook(ctx, hookQAURL)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		r.note(ui.Headline(err.Error()))
		return nil
	}
	if !ok {
		return nil
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	url := strings.TrimSpace(lines[len(lines)-1])
	if url == "" {
		return nil
	}
	if err := r.update(func(j *job.Job) { j.QAURL = url }); err != nil {
		return err
	}
	r.note("QA env: " + url)
	return nil
}

// waitQAReady polls the qaReady hook until it exits 0 or qaReadyTimeoutMin
// passes. ready is false on a timeout.
func (r *run) waitQAReady(ctx context.Context) (ready bool, err error) {
	if r.cfg.Hooks.QAReady == "" {
		return true, nil
	}
	start := r.deps.Now()
	limit := time.Duration(r.cfg.QAReadyTimeoutMin) * time.Minute
	for {
		res, _, err := r.runHook(ctx, hookQAReady)
		if err != nil {
			return false, err
		}
		if res.Code == 0 {
			return true, nil
		}
		if err := r.deps.Sleep(ctx, time.Duration(r.cfg.QAPollSec)*time.Second); err != nil {
			return false, err
		}
		if r.deps.Now().Sub(start) >= limit {
			return false, nil
		}
	}
}
