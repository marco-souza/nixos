package harness

import (
	"fmt"
	"slices"
	"strings"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
)

// Error is a role that cannot be run: an unknown harness or tier.
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

// Resolved is how one role runs: on which harness, with which model (empty:
// the harness default) and for how long.
type Resolved struct {
	Harness    config.Harness
	Model      string
	TimeoutMin int
}

// Resolve picks the model and timeout of role on the job's harness. The
// harness comes only from the job. A role's tier override beats its own
// tier, and its timeout override beats the tier's.
func Resolve(role Role, h config.Harness, cfg config.Config) (Resolved, error) {
	if h != config.Claude && h != config.Pi {
		return Resolved{}, &Error{fmt.Sprintf("role %s: unknown harness %q (claude, pi)", role.Name, h)}
	}
	o := cfg.Roles[role.Name]
	tier := role.Tier
	if o.Tier != "" {
		tier = o.Tier
	}
	if !slices.Contains([]config.Tier{config.High, config.Medium, config.Low}, tier) {
		return Resolved{}, &Error{fmt.Sprintf("role %s: unknown tier %q (high, medium, low)", role.Name, tier)}
	}
	timeout := cfg.TimeoutsMin[tier]
	if o.TimeoutMin > 0 {
		timeout = o.TimeoutMin
	}
	return Resolved{Harness: h, Model: cfg.Models[h][tier], TimeoutMin: timeout}, nil
}

// TaskContext is what a role's task prompt names.
type TaskContext struct {
	Job        job.Job
	Paths      job.Paths
	Assignment string
	Output     string
	Inputs     []string
	// Target is the URL of the app to test; "" for roles that have none.
	Target string
}

// docKinds are the job's docs, in the order the Docs line lists them.
var docKinds = []string{"requirements", "tech-discovery", "design", "spec", "test-plan"}

// TaskPrompt is the first message an agent gets. Every path is absolute.
func TaskPrompt(c TaskContext) string {
	j := c.Job
	docs := make([]string, len(docKinds))
	for i, k := range docKinds {
		docs[i] = k + "=" + c.Paths.Doc(k)
	}
	lines := []string{
		"Job: " + j.ID,
		"Request: " + j.Feature,
		"Worktree: " + j.Worktree + " (your working directory)",
		"Job folder: " + c.Paths.JobDir,
		fmt.Sprintf("Cycle: %d  Trip: %d", j.Cycle, j.Trip),
		"Base: " + j.Base,
		"Docs: " + strings.Join(docs, ", "),
		"Assignment: " + c.Assignment,
		"Output: " + c.Output,
	}
	if len(c.Inputs) > 0 {
		lines = append(lines, "Inputs: "+strings.Join(c.Inputs, ", "))
	}
	if c.Target != "" {
		lines = append(lines, "Target: "+c.Target)
	}
	return strings.Join(lines, "\n")
}
