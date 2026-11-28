// Package git wraps the git and gh commands the factory uses.
package git

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/marco-souza/nixos/stow/factory/internal/proc"
)

var (
	branchNotFound = regexp.MustCompile(`(?i)not found`)
	remoteGone     = regexp.MustCompile(`(?i)remote ref does not exist|not found`)
)

// Git runs git commands in a repo.
type Git struct {
	Exec proc.Runner
	Repo string
}

func (g *Git) git(ctx context.Context, dir string, args ...string) (proc.Result, error) {
	return proc.Run(ctx, g.Exec, append([]string{"git"}, args...), proc.Opts{Dir: dir})
}

// factoryOnly refuses destructive operations on branches the factory didn't
// create: the ones CreateWorktree marked, and proof.
func (g *Git) factoryOnly(ctx context.Context, op, branch string) error {
	if strings.HasPrefix(branch, "factory-proof/") {
		return nil
	}
	r, err := g.Exec.Run(ctx, []string{"git", "config", "--get", "branch." + branch + ".factory"}, proc.Opts{Dir: g.Repo})
	if err != nil {
		return err
	}
	if r.Code != 0 {
		return fmt.Errorf("refusing to %s %q: the factory did not create it", op, branch)
	}
	return nil
}

// EnsureExcluded adds /.factory/ to the repo's info/exclude.
func (g *Git) EnsureExcluded(ctx context.Context) error {
	r, err := g.git(ctx, g.Repo, "rev-parse", "--git-path", "info/exclude")
	if err != nil {
		return err
	}
	file := strings.TrimSpace(r.Stdout)
	if !filepath.IsAbs(file) {
		file = filepath.Join(g.Repo, file)
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o750); err != nil {
		return err
	}
	b, err := os.ReadFile(file)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	current := string(b)
	if slices.Contains(strings.Split(current, "\n"), "/.factory/") {
		return nil
	}
	sep := ""
	if current != "" && !strings.HasSuffix(current, "\n") {
		sep = "\n"
	}
	return os.WriteFile(file, []byte(current+sep+"/.factory/\n"), 0o600) //nolint:gosec // file comes from git rev-parse
}

// CreateWorktree fetches base and adds a worktree on a new branch from it.
func (g *Git) CreateWorktree(ctx context.Context, branch, path, base string) error {
	if _, err := g.git(ctx, g.Repo, "fetch", "origin", base); err != nil {
		return err
	}
	if _, err := g.git(ctx, g.Repo, "worktree", "add", "-b", branch, path, "origin/"+base); err != nil {
		return err
	}
	_, err := g.git(ctx, g.Repo, "config", "branch."+branch+".factory", "true")
	return err
}

// CommitPaths stages the paths that exist in cwd and commits them. It reports
// whether a commit was made.
func (g *Git) CommitPaths(ctx context.Context, cwd string, paths []string, message string) (bool, error) {
	var existing []string
	for _, p := range paths {
		if _, err := os.Stat(filepath.Join(cwd, p)); err == nil {
			existing = append(existing, p)
		}
	}
	if len(existing) == 0 {
		return false, nil
	}
	if _, err := g.git(ctx, cwd, append([]string{"add", "--"}, existing...)...); err != nil {
		return false, err
	}
	argv := []string{"git", "diff", "--cached", "--quiet"}
	staged, err := g.Exec.Run(ctx, argv, proc.Opts{Dir: cwd})
	if err != nil {
		return false, err
	}
	switch staged.Code {
	case 0:
		return false, nil
	case 1:
	default:
		return false, proc.Check(argv, staged)
	}
	if _, err := g.git(ctx, cwd, "commit", "-m", message); err != nil {
		return false, err
	}
	return true, nil
}

// Head is the commit HEAD points at in cwd.
func (g *Git) Head(ctx context.Context, cwd string) (string, error) {
	r, err := g.git(ctx, cwd, "rev-parse", "HEAD")
	return strings.TrimSpace(r.Stdout), err
}

// Ahead counts the commits of HEAD that origin/<base> does not have.
func (g *Git) Ahead(ctx context.Context, worktree, base string) (int, error) {
	r, err := g.git(ctx, worktree, "rev-list", "--count", "origin/"+base+"..HEAD")
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(r.Stdout))
	if err != nil {
		return 0, fmt.Errorf("parse commit count %q: %w", r.Stdout, err)
	}
	return n, nil
}

// Push pushes branch to origin and sets its upstream. It never skips hooks.
func (g *Git) Push(ctx context.Context, cwd, branch string, force bool) error {
	if err := g.factoryOnly(ctx, "push", branch); err != nil {
		return err
	}
	args := []string{"push"}
	if force {
		args = append(args, "--force-with-lease")
	}
	_, err := g.git(ctx, cwd, append(args, "-u", "origin", branch)...)
	return err
}

// Rebase rebases cwd onto origin/<base>. A conflict aborts the rebase and
// returns conflict true.
func (g *Git) Rebase(ctx context.Context, cwd, base string) (conflict bool, err error) {
	if _, err := g.git(ctx, cwd, "fetch", "origin", base); err != nil {
		return false, err
	}
	r, err := g.Exec.Run(ctx, []string{"git", "rebase", "origin/" + base}, proc.Opts{Dir: cwd})
	if err != nil {
		return false, err
	}
	if r.Code == 0 {
		return false, nil
	}
	if _, err := g.Exec.Run(ctx, []string{"git", "rebase", "--abort"}, proc.Opts{Dir: cwd}); err != nil {
		return false, err
	}
	return true, nil
}

// RemoveWorktree removes the worktree at path.
func (g *Git) RemoveWorktree(ctx context.Context, path string) error {
	_, err := g.git(ctx, g.Repo, "worktree", "remove", "--force", path)
	return err
}

// DeleteBranch deletes branch here and on origin. A branch that is already
// gone is fine.
func (g *Git) DeleteBranch(ctx context.Context, branch string) error {
	if err := g.factoryOnly(ctx, "delete", branch); err != nil {
		return err
	}
	opts := proc.Opts{Dir: g.Repo}
	argv := []string{"git", "branch", "-D", branch}
	local, err := g.Exec.Run(ctx, argv, opts)
	if err != nil {
		return err
	}
	if local.Code != 0 && !branchNotFound.MatchString(local.Stderr) {
		return proc.Check(argv, local)
	}
	argv = []string{"git", "push", "origin", "--delete", branch}
	remote, err := g.Exec.Run(ctx, argv, opts)
	if err != nil {
		return err
	}
	if remote.Code != 0 && !remoteGone.MatchString(remote.Stderr) {
		return proc.Check(argv, remote)
	}
	return nil
}

// BranchExists reports whether branch exists here or on origin. An
// unreachable origin counts as no.
func (g *Git) BranchExists(ctx context.Context, branch string) (bool, error) {
	opts := proc.Opts{Dir: g.Repo}
	local, err := g.Exec.Run(ctx, []string{"git", "show-ref", "--verify", "--quiet", "refs/heads/" + branch}, opts)
	if err != nil {
		return false, err
	}
	if local.Code == 0 {
		return true, nil
	}
	remote, err := g.Exec.Run(ctx, []string{"git", "ls-remote", "--exit-code", "--heads", "origin", "refs/heads/" + branch}, opts)
	if err != nil {
		return false, err
	}
	return remote.Code == 0, nil
}
