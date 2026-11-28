package git

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strings"

	"github.com/marco-souza/nixos/stow/factory/internal/proc"
)

// PRComment is one human comment on a pull request.
type PRComment struct {
	Author    string
	Body      string
	Path      string
	Line      int
	CreatedAt string
}

// GitHub runs gh commands in a repo.
//
//nolint:revive // the design names it git.GitHub
type GitHub struct {
	Exec proc.Runner
	Repo string
}

var pullNumber = regexp.MustCompile(`/pull/(\d+)`)

func (h *GitHub) gh(ctx context.Context, args ...string) (string, error) {
	r, err := proc.Run(ctx, h.Exec, append([]string{"gh"}, args...), proc.Opts{Dir: h.Repo})
	return r.Stdout, err
}

func (h *GitHub) ghTrim(ctx context.Context, args ...string) (string, error) {
	out, err := h.gh(ctx, args...)
	return strings.TrimSpace(out), err
}

// Preflight checks gh is logged in and the repo has an origin.
func (h *GitHub) Preflight(ctx context.Context) error {
	opts := proc.Opts{Dir: h.Repo}
	auth, err := h.Exec.Run(ctx, []string{"gh", "auth", "status"}, opts)
	if err != nil {
		return err
	}
	if auth.Code != 0 {
		return errors.New("gh is not logged in (run: gh auth login)")
	}
	origin, err := h.Exec.Run(ctx, []string{"git", "remote", "get-url", "origin"}, opts)
	if err != nil {
		return err
	}
	if origin.Code != 0 {
		return errors.New("no origin remote")
	}
	return nil
}

// DefaultBranch is the repo's default branch.
func (h *GitHub) DefaultBranch(ctx context.Context) (string, error) {
	return h.ghTrim(ctx, "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name")
}

// PRHead is the head branch of pr (a number or URL).
func (h *GitHub) PRHead(ctx context.Context, pr string) (string, error) {
	return h.ghTrim(ctx, "pr", "view", pr, "--json", "headRefName", "-q", ".headRefName")
}

// FindPR is the URL of the open PR for branch, or "".
func (h *GitHub) FindPR(ctx context.Context, branch string) (string, error) {
	out, err := h.gh(ctx, "pr", "list", "--head", branch, "--state", "open", "--json", "url", "--limit", "1")
	if err != nil {
		return "", err
	}
	var list []struct {
		URL string `json:"url"`
	}
	if strings.TrimSpace(out) != "" {
		if err := json.Unmarshal([]byte(out), &list); err != nil {
			return "", fmt.Errorf("parse gh pr list: %w", err)
		}
	}
	if len(list) == 0 {
		return "", nil
	}
	return list[0].URL, nil
}

// DraftPR describes a draft pull request to open.
type DraftPR struct {
	Branch, Base, Title, BodyFile string
}

// CreateDraftPR opens a draft PR and returns its URL.
func (h *GitHub) CreateDraftPR(ctx context.Context, o DraftPR) (string, error) {
	out, err := h.gh(ctx, "pr", "create", "--draft", "--assignee", "@me", "--head", o.Branch, "--base", o.Base,
		"--title", o.Title, "--body-file", o.BodyFile)
	if err != nil {
		return "", err
	}
	var last string
	for l := range strings.SplitSeq(out, "\n") {
		if strings.TrimSpace(l) != "" {
			last = strings.TrimSpace(l)
		}
	}
	return last, nil
}

// ViewBody is the body of pr.
func (h *GitHub) ViewBody(ctx context.Context, pr string) (string, error) {
	return h.gh(ctx, "pr", "view", pr, "--json", "body", "-q", ".body")
}

// EditBody sets the body of pr from a file.
func (h *GitHub) EditBody(ctx context.Context, pr, bodyFile string) error {
	_, err := h.gh(ctx, "pr", "edit", pr, "--body-file", bodyFile)
	return err
}

// EditTitle sets the title of pr.
func (h *GitHub) EditTitle(ctx context.Context, pr, title string) error {
	_, err := h.gh(ctx, "pr", "edit", pr, "--title", title)
	return err
}

// Ready marks pr ready for review.
func (h *GitHub) Ready(ctx context.Context, pr string) error {
	_, err := h.gh(ctx, "pr", "ready", pr)
	return err
}

// ToDraft turns pr back into a draft.
func (h *GitHub) ToDraft(ctx context.Context, pr string) error {
	_, err := h.gh(ctx, "pr", "ready", pr, "--undo")
	return err
}

// Close closes pr.
func (h *GitHub) Close(ctx context.Context, pr string) error {
	_, err := h.gh(ctx, "pr", "close", pr)
	return err
}

// NameWithOwner is the repo as owner/name.
func (h *GitHub) NameWithOwner(ctx context.Context) (string, error) {
	return h.ghTrim(ctx, "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner")
}

type ghUser struct {
	Login string `json:"login"`
	Type  string `json:"type"`
}

// isBot: CI, linters and review bots comment too; only people send feedback.
func (u *ghUser) isBot() bool {
	return u != nil && (strings.HasSuffix(u.Login, "[bot]") || u.Type == "Bot")
}

func (u *ghUser) login() string {
	if u == nil {
		return ""
	}
	return u.Login
}

// decodeArrays reads the JSON arrays `gh api --paginate` prints back to back.
func decodeArrays[T any](text string) ([]T, error) {
	var out []T
	dec := json.NewDecoder(strings.NewReader(text))
	for {
		var page []T
		if err := dec.Decode(&page); err != nil {
			if errors.Is(err, io.EOF) {
				return out, nil
			}
			return nil, err
		}
		out = append(out, page...)
	}
}

// CommentsSince lists the human comments on pr made after sinceISO ("" for
// all), oldest first: conversation comments, review bodies and inline
// comments.
func (h *GitHub) CommentsSince(ctx context.Context, pr, sinceISO string) ([]PRComment, error) {
	m := pullNumber.FindStringSubmatch(pr)
	if m == nil {
		return nil, fmt.Errorf("not a pull request URL: %s", pr)
	}
	viewOut, err := h.gh(ctx, "pr", "view", pr, "--json", "comments,reviews")
	if err != nil {
		return nil, err
	}
	var view struct {
		Comments []struct {
			Author    *ghUser `json:"author"`
			Body      string  `json:"body"`
			CreatedAt string  `json:"createdAt"`
		} `json:"comments"`
		Reviews []struct {
			Author      *ghUser `json:"author"`
			Body        string  `json:"body"`
			SubmittedAt string  `json:"submittedAt"`
		} `json:"reviews"`
	}
	if strings.TrimSpace(viewOut) != "" {
		if err := json.NewDecoder(strings.NewReader(viewOut)).Decode(&view); err != nil {
			return nil, fmt.Errorf("parse gh pr view: %w", err)
		}
	}
	inlineOut, err := h.gh(ctx, "api", "repos/{owner}/{repo}/pulls/"+m[1]+"/comments", "--paginate")
	if err != nil {
		return nil, err
	}
	inline, err := decodeArrays[struct {
		User      *ghUser `json:"user"`
		Body      string  `json:"body"`
		Path      string  `json:"path"`
		Line      *int    `json:"line"`
		CreatedAt string  `json:"created_at"`
	}](inlineOut)
	if err != nil {
		return nil, fmt.Errorf("parse gh api comments: %w", err)
	}

	var all []PRComment
	for _, c := range view.Comments {
		if !c.Author.isBot() {
			all = append(all, PRComment{Author: c.Author.login(), Body: c.Body, CreatedAt: c.CreatedAt})
		}
	}
	for _, c := range view.Reviews {
		if !c.Author.isBot() {
			all = append(all, PRComment{Author: c.Author.login(), Body: c.Body, CreatedAt: c.SubmittedAt})
		}
	}
	for _, c := range inline {
		if c.User.isBot() {
			continue
		}
		line := 0
		if c.Line != nil {
			line = *c.Line
		}
		all = append(all, PRComment{Author: c.User.login(), Body: c.Body, Path: c.Path, Line: line, CreatedAt: c.CreatedAt})
	}
	all = slices.DeleteFunc(all, func(c PRComment) bool {
		return strings.TrimSpace(c.Body) == "" || c.CreatedAt == "" || (sinceISO != "" && c.CreatedAt <= sinceISO)
	})
	slices.SortStableFunc(all, func(a, b PRComment) int { return strings.Compare(a.CreatedAt, b.CreatedAt) })
	return all, nil
}
