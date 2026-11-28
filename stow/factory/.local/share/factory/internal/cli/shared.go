package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/marco-souza/nixos/stow/factory/internal/app"
	"github.com/marco-souza/nixos/stow/factory/internal/deps"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/machine"
	"github.com/marco-souza/nixos/stow/factory/internal/proc"
	"github.com/marco-souza/nixos/stow/factory/internal/ui"
)

// makeDeps builds the real dependencies. Tests swap it.
var makeDeps = app.MakeDeps

const example = "rate-limit-signup-form"

// repoOf is the main checkout of the repo the command acts on: --repo, else
// the current directory. Jobs live in the main checkout and read its
// .factory.json; acting on another one silently is how jobs land on the wrong
// base, so --repo refuses a linked worktree.
func repoOf(cmd *cobra.Command) (string, error) {
	flag := cmd.Flag("repo")
	dir := flag.Value.String()
	if dir == "" {
		dir = "."
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	argv := []string{"git", "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"}
	r, err := proc.RealRunner{}.Run(cmd.Context(), argv, proc.Opts{Dir: abs})
	if err != nil || r.Code != 0 {
		return "", errors.New("not inside a git repository")
	}
	paths := strings.Split(strings.TrimSpace(r.Stdout), "\n")
	if len(paths) != 2 {
		return "", errors.New("not inside a git repository")
	}
	repo := filepath.Dir(paths[1])
	if paths[0] != paths[1] && flag.Changed {
		return "", fmt.Errorf("--repo is a linked worktree: pass its main checkout, %s (and --base <branch>)", repo)
	}
	return repo, nil
}

// depsFor builds the dependencies of repo.
func depsFor(repo string, inline bool) (deps.Deps, error) { return makeDeps(repo, inline) }

// printNext prints what to type next, when there is something.
func printNext(cmd *cobra.Command, j job.Job) {
	if hint := ui.NextHint(j); hint != "" {
		cmd.Println(strings.Join(ui.NextLines(hint), "\n"))
	}
}

// printReply prints what a grill turn ended with.
func printReply(cmd *cobra.Command, id string, r app.Reply) {
	if r.Question != "" {
		cmd.Printf("QUESTION for %s:\n\n%s\n\nnext: factory answer %s -- \"<the human's answer>\"\n", id, r.Question, id)
		return
	}
	if r.Waiting {
		// `!` marks a line the relaying agent must pass on.
		cmd.Println(ui.Paint(ui.Yellow, fmt.Sprintf("! requirements written, but %s stopped: %s", id, ui.WhatFor(r.Job))))
	} else {
		cmd.Println(app.Ok(fmt.Sprintf("requirements written; the driver goes on with %s in the background", r.Job.Stage)))
	}
	printNext(cmd, r.Job)
}

// rel is file relative to repo, when it is inside it.
func rel(repo, file string) string {
	if r, err := filepath.Rel(repo, file); err == nil && !strings.HasPrefix(r, "..") {
		return r
	}
	return file
}

// isCommandError reports whether err is a refusal, not a crash.
func isCommandError(err error) bool {
	var ce *machine.CommandError
	return errors.As(err, &ce)
}

// ctxOf is the command's context.
func ctxOf(cmd *cobra.Command) context.Context { return cmd.Context() }

func stdinIsTerminal() bool {
	return isTerminal(os.Stdin) && isTerminal(os.Stdout)
}

func isTerminal(f *os.File) bool {
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}
