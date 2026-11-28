package driver

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/marco-souza/nixos/stow/factory/internal/git"
	"github.com/marco-souza/nixos/stow/factory/internal/handoff"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/proc"
	"github.com/marco-souza/nixos/stow/factory/internal/ui"
)

var (
	placeholder = regexp.MustCompile(`\{(type|ticket|summary)\}`)
	emptyPair   = regexp.MustCompile(`\[\s*\]|\(\s*\)`)
	spaces      = regexp.MustCompile(`\s+`)
)

// renderTitle is template with {type}, {ticket} and {summary} filled in. A
// placeholder with no value goes, with the brackets around it:
// `[{type}][{ticket}] {summary}` and no ticket gives `[fix] Raise the cache
// timeout`.
func renderTitle(template string, v map[string]string) string {
	s := placeholder.ReplaceAllStringFunc(template, func(m string) string { return v[m[1:len(m)-1]] })
	s = emptyPair.ReplaceAllString(s, "")
	return strings.TrimSpace(spaces.ReplaceAllString(s, " "))
}

// prTitle is the PR title for summary: the configured template, or summary
// as it is.
func (r *run) prTitle(j job.Job, summary string) string {
	s := strings.TrimSpace(spaces.ReplaceAllString(summary, " "))
	if r.cfg.PRTitle == "" {
		return s
	}
	typ, _, found := strings.Cut(j.Branch, "/")
	if !found {
		typ = ""
	}
	return renderTitle(r.cfg.PRTitle, map[string]string{"type": typ, "ticket": job.TicketOf(j.Feature), "summary": s})
}

// ensurePR finds or opens the draft PR, runs prOpened if it has not passed
// yet, then asks for the QA env. While the branch has no commit ahead of its
// base and there is no PR, there is nothing to open one for: it does nothing.
func (r *run) ensurePR(ctx context.Context) error {
	j := r.snapshot()
	if j.PR == "" {
		ahead, err := r.deps.Git.Ahead(ctx, j.Worktree, j.Base)
		if err != nil {
			return err
		}
		if ahead == 0 {
			return nil
		}
		if err := r.openPR(ctx, j); err != nil {
			return err
		}
	}
	if err := r.prOpened(ctx); err != nil {
		return err
	}
	return r.qaURL(ctx)
}

func (r *run) openPR(ctx context.Context, j job.Job) error {
	found, err := r.deps.GH.FindPR(ctx, j.Branch)
	if err != nil {
		return err
	}
	if found != "" {
		if err := r.update(func(j *job.Job) { j.PR = found }); err != nil {
			return err
		}
		r.note("found the open PR " + found)
		return nil
	}
	bodyFile := filepath.Join(r.paths.JobDir, "pr-body.md")
	if err := os.WriteFile(bodyFile, []byte(ui.InitialBody(j)), 0o600); err != nil {
		return err
	}
	text, err := os.ReadFile(r.paths.Doc("requirements"))
	if err != nil {
		return err
	}
	title := r.prTitle(j, handoff.ParseRequirements(string(text)).Title)
	pr, err := r.deps.GH.CreateDraftPR(ctx, git.DraftPR{Branch: j.Branch, Base: j.Base, Title: title, BodyFile: bodyFile})
	if err != nil {
		return err
	}
	if err := r.update(func(j *job.Job) { j.PR = pr }); err != nil {
		return err
	}
	r.note("opened draft PR " + pr)
	return nil
}

// pushProof commits the proof folder to an orphan commit with a temp index
// and pushes it to factory-proof/<jobID>. It returns "" when the folder is
// empty. The push is a plain --force: an orphan proof ref only the driver
// writes, never a code branch. --no-verify keeps the repo's pre-push hook
// off it.
func pushProof(ctx context.Context, run proc.Runner, repo, proofDir, jobID, indexFile string) (string, error) {
	entries, err := os.ReadDir(proofDir)
	if err != nil || len(entries) == 0 {
		return "", nil
	}
	if err := os.Remove(indexFile); err != nil && !os.IsNotExist(err) {
		return "", err
	}
	g := func(args ...string) (string, error) {
		argv := append([]string{"git"}, args...)
		res, err := proc.Run(ctx, run, argv, proc.Opts{Dir: repo, Env: map[string]string{"GIT_INDEX_FILE": indexFile}})
		return strings.TrimSpace(res.Stdout), err
	}
	if _, err := g("--work-tree="+proofDir, "add", "-A", "."); err != nil {
		return "", err
	}
	tree, err := g("write-tree")
	if err != nil {
		return "", err
	}
	sha, err := g("commit-tree", tree, "-m", "proof: "+jobID)
	if err != nil {
		return "", err
	}
	if _, err := g("push", "--no-verify", "--force", "origin", sha+":refs/heads/factory-proof/"+jobID); err != nil {
		return "", err
	}
	return sha, nil
}

var imageFile = regexp.MustCompile(`(?i)\.(png|jpe?g|gif|webp|svg)$`)

// proofSection links every proof file at its commit on the proof ref.
func proofSection(nameWithOwner, sha string, files []string) string {
	lines := make([]string, 0, len(files)+1)
	lines = append(lines, "## Proof")
	for _, f := range files {
		link := fmt.Sprintf("https://github.com/%s/blob/%s/%s?raw=true", nameWithOwner, sha, strings.ReplaceAll(url.QueryEscape(f), "+", "%20"))
		if imageFile.MatchString(f) {
			lines = append(lines, fmt.Sprintf("![%s](%s)", f, link))
		} else {
			lines = append(lines, fmt.Sprintf("[%s](%s)", f, link))
		}
	}
	return strings.Join(lines, "\n\n")
}

// openSection lists what is not clean about a PR that stays a draft.
func openSection(j job.Job, gaps []int) string {
	var items []string
	if j.StoppedReason != "" {
		items = append(items, "- The job stopped: "+j.StoppedReason)
	}
	if len(gaps) > 0 {
		nums := make([]string, len(gaps))
		for i, g := range gaps {
			nums[i] = fmt.Sprint(g)
		}
		items = append(items, "- No proof for acceptance criteria "+strings.Join(nums, ", ")+".")
	}
	if j.Ready == nil || !*j.Ready {
		items = append(items, "- Approved without a clean pass: the job had stopped for the human.")
	}
	return "## Open\n\n" + strings.Join(items, "\n")
}
