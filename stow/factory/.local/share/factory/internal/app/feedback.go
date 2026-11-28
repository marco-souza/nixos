package app

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/marco-souza/nixos/stow/factory/internal/deps"
	"github.com/marco-souza/nixos/stow/factory/internal/git"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/machine"
)

// Feedback writes the new PR comments (since the last feedback file) and note
// to feedback-<k>.md; the job starts a new cycle. It stops the job's agents
// first; a done job's PR goes back to draft, and it takes a free slot if its
// own was taken.
func Feedback(ctx context.Context, repo, id, note string, d deps.Deps) (job.Job, error) {
	cur, err := findJob(repo, id)
	if err != nil {
		return job.Job{}, err
	}
	if cur.Stage == job.StageDiscarded {
		return job.Job{}, &machine.CommandError{Msg: fmt.Sprintf("cannot send feedback: %s is discarded", id)}
	}
	paths := job.NewPaths(repo, id)
	since := ""
	if cur.FeedbackCount > 0 {
		if fi, err := os.Stat(paths.Feedback(cur.FeedbackCount)); err == nil {
			since = fi.ModTime().UTC().Format(time.RFC3339)
		}
	}
	var comments []git.PRComment
	if cur.PR != "" {
		if comments, err = d.GH.CommentsSince(ctx, cur.PR, since); err != nil {
			return job.Job{}, err
		}
	}
	text := strings.TrimSpace(note)
	if len(comments) == 0 && text == "" {
		return job.Job{}, &machine.CommandError{Msg: "nothing new to send"}
	}

	k := cur.FeedbackCount + 1
	file := paths.Feedback(k)
	if err := os.WriteFile(file, []byte(renderFeedback(id, k, comments, text)), 0o600); err != nil {
		return job.Job{}, err
	}
	// The driver goes first: alive, it would save its old state over the new
	// cycle when its agents die.
	d.Spawner.Kill(id, "driver")
	d.Spawner.KillAgents(id)
	if cur.Stage == job.StageDone && cur.PR != "" {
		if err := d.GH.ToDraft(ctx, cur.PR); err != nil {
			return job.Job{}, err
		}
	}
	// A done job holds no slot, so another job may have its ports by now.
	slot := cur.Slot
	if cur.Stage == job.StageDone && job.HeldSlots(repo)[cur.Slot] {
		slot = job.NextSlot(repo)
	}
	next, err := transition(repo, id, machine.Command{Kind: machine.CmdFeedback, File: file}, d, func(j *job.Job) {
		j.Running = []string{}
		j.Slot = slot
	})
	if err != nil {
		return job.Job{}, err
	}
	return next, restartDriver(next, d, repo)
}

func renderFeedback(id string, k int, comments []git.PRComment, note string) string {
	parts := []string{fmt.Sprintf("# Feedback %d for %s", k, id)}
	if len(comments) > 0 {
		parts = append(parts, "## PR comments")
	}
	for _, c := range comments {
		where := ""
		if c.Path != "" {
			where = " on " + c.Path
			if c.Line != 0 {
				where += fmt.Sprintf(":%d", c.Line)
			}
		}
		author := c.Author
		if author == "" {
			author = "unknown"
		}
		parts = append(parts, "### @"+author+where, strings.TrimRight(c.Body, " \t\r\n"))
	}
	if note != "" {
		parts = append(parts, "## Note", note)
	}
	return strings.Join(parts, "\n\n") + "\n"
}
