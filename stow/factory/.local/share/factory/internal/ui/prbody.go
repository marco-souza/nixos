package ui

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
)

const (
	statusStart   = "<!-- factory:status -->"
	statusEnd     = "<!-- /factory:status -->"
	decisionStart = "<!-- factory:decision -->"
	decisionEnd   = "<!-- /factory:decision -->"
)

// Groups are the pipeline's columns, in order.
var Groups = []string{"Discovery", "Building", "Validation", "Deploy"}

// Step is one stage a job passes through, with its label and group.
type Step struct {
	Stage job.Stage
	Label string
	Group string
}

var allSteps = []Step{
	{job.StageRequirements, "requirements", "Discovery"},
	{job.StagePreflight, "access check", "Discovery"},
	{job.StageReport, "report", "Building"},
	{job.StageTechDiscovery, "tech discovery", "Discovery"},
	{job.StageDesign, "design", "Discovery"},
	{job.StageDiscoveryReview, "AI review", "Discovery"},
	{job.StagePlanning, "plan", "Building"},
	{job.StageBuild, "build", "Building"},
	{job.StageReview, "review", "Building"},
	{job.StageBuildJudge, "judge", "Building"},
	{job.StageTestPlanning, "test plan", "Validation"},
	{job.StageRebase, "rebase", "Validation"},
	{job.StageQAWait, "QA ready", "Validation"},
	{job.StageValidation, "validators", "Validation"},
	{job.StageValidationJudge, "judge", "Validation"},
	{job.StageHumanReview, "your review", "Deploy"},
	{job.StageFinalize, "ready", "Deploy"},
}

var reportStages = []job.Stage{job.StageRequirements, job.StagePreflight, job.StageReport, job.StageHumanReview, job.StageFinalize}

// Steps are the steps a job goes through: a report job skips the PR's
// stages, a PR job the report.
func Steps(j job.Job) []Step {
	report := j.Deliverable == job.DeliverReport
	return slices.DeleteFunc(slices.Clone(allSteps), func(s Step) bool {
		if report {
			return !slices.Contains(reportStages, s.Stage)
		}
		return s.Stage == job.StageReport
	})
}

// groupsOf are the groups that have a step in steps, in order.
func groupsOf(steps []Step) []string {
	return slices.DeleteFunc(slices.Clone(Groups), func(g string) bool {
		return !slices.ContainsFunc(steps, func(s Step) bool { return s.Group == g })
	})
}

// stepCounter is ` (k/n)` for the current trip's review or validation
// record; "" when there is none.
func stepCounter(j job.Job, stage job.Stage) string {
	if len(j.Trips) == 0 {
		return ""
	}
	trip := j.Trips[len(j.Trips)-1]
	var rec map[string]string
	switch stage {
	case job.StageReview:
		rec = trip.Reviews
	case job.StageValidation:
		rec = trip.Validations
	}
	if len(rec) == 0 {
		return ""
	}
	return " (" + verdictCount(rec) + ")"
}

func headline(j job.Job) string {
	switch j.Stage {
	case job.StageDone:
		return "✅ **Done**"
	case job.StageDiscarded:
		return "🗑 **Discarded**"
	case job.StageHumanReview:
		return "⏸ **Waiting for your review**"
	case job.StageNeedsHuman:
		reason := Headline(j.Reason)
		if reason == "" {
			reason = "escalation"
		}
		return "⏸ **Waiting for you: " + reason + "**"
	case job.StageRequirements:
		if j.WaitingFor == job.WaitRequirements {
			return "⏸ **Waiting for you: answer the grill**"
		}
	}
	i := slices.IndexFunc(allSteps, func(s Step) bool { return s.Stage == j.Stage })
	if i < 0 {
		return fmt.Sprintf("⏳ **%s**", j.Stage)
	}
	s := allSteps[i]
	return fmt.Sprintf("⏳ **%s: %s%s**", s.Group, s.Label, stepCounter(j, j.Stage))
}

func mark(j job.Job, steps []Step, i int) string {
	if j.Stage == job.StageDone {
		return "✅"
	}
	if j.Stage == job.StageDiscarded {
		if j.Planned && steps[i].Group == "Discovery" {
			return "✅"
		}
		return "⬜"
	}
	current := j.Stage
	if j.Stage == job.StageNeedsHuman {
		current = j.ResumeStage
	}
	at := slices.IndexFunc(steps, func(s Step) bool { return s.Stage == current })
	switch {
	case at < 0:
		return "⬜"
	case i < at:
		return "✅"
	case i > at:
		return "⬜"
	}
	switch {
	case j.Stage == job.StageNeedsHuman && j.WaitingFor == job.WaitFailure:
		return "❌"
	case j.Stage == job.StageNeedsHuman, j.Stage == job.StageHumanReview,
		j.Stage == job.StageRequirements && j.WaitingFor == job.WaitRequirements:
		return "⏸"
	}
	return "⏳"
}

// RenderStatus is the PR body's status block. docs are the repo-relative
// paths of the job's docs that exist, in doc order; they print as code
// spans, not links, because the docs are never pushed.
func RenderStatus(j job.Job, cfg config.Config, docs []string) string {
	parts := []string{"**🏭 Factory**", "`" + j.ID + "`", fmt.Sprintf("cycle %d", j.Cycle)}
	if j.Trip > 0 {
		parts = append(parts, fmt.Sprintf("trip %d/%d", j.Trip, cfg.MaxTrips+j.ExtraTrips))
	}
	parts = append(parts, headline(j))

	all := Steps(j)
	var rows []string
	for _, group := range groupsOf(all) {
		var steps []string
		for i, s := range all {
			if s.Group != group {
				continue
			}
			c := ""
			if s.Stage == j.Stage {
				c = stepCounter(j, s.Stage)
			}
			steps = append(steps, mark(j, all, i)+" "+s.Label+c)
		}
		rows = append(rows, "| "+group+" | "+strings.Join(steps, " · ")+" |")
	}

	out := []string{statusStart, strings.Join(parts, " · "), "", "| Stage | Steps |", "| --- | --- |"}
	out = append(out, rows...)
	if len(docs) > 0 {
		spans := make([]string, len(docs))
		for i, d := range docs {
			spans[i] = "`" + d + "`"
		}
		out = append(out, "", "Docs: "+strings.Join(spans, " · "))
	}
	out = append(out, statusEnd)
	return strings.Join(out, "\n")
}

// MergeStatus replaces the status block in body, or prepends it.
func MergeStatus(body, status string) string {
	a, b := strings.Index(body, statusStart), strings.Index(body, statusEnd)
	if a >= 0 && b > a {
		return body[:a] + status + body[b+len(statusEnd):]
	}
	return status + "\n\n" + body
}

// cut is body without the block between start and end, joining what was
// around it with one blank line.
func cut(body, start, end string) string {
	a, b := strings.Index(body, start), strings.Index(body, end)
	if a < 0 || b <= a {
		return body
	}
	before := strings.TrimRight(body[:a], " \t\r\n")
	after := strings.TrimLeft(body[b+len(end):], " \t\r\n")
	switch {
	case before != "" && after != "":
		return before + "\n\n" + after
	case before != "":
		return before
	}
	return after
}

// MergeDecision puts decision right below the status block (or on top),
// replacing an earlier one. An empty decision removes it.
func MergeDecision(body, decision string) string {
	rest := cut(body, decisionStart, decisionEnd)
	if decision == "" {
		return rest
	}
	block := decisionStart + "\n" + decision + "\n" + decisionEnd
	end := strings.Index(rest, statusEnd)
	if end < 0 {
		if rest == "" {
			return block
		}
		return block + "\n\n" + rest
	}
	at := end + len(statusEnd)
	after := strings.TrimLeft(rest[at:], " \t\r\n")
	if after != "" {
		after = "\n\n" + after
	}
	return rest[:at] + "\n\n" + block + after
}

// InitialBody is the PR body when the draft PR opens.
func InitialBody(j job.Job) string {
	// The trip cap only shows once a trip has started, which a fresh job has not.
	return RenderStatus(j, config.Config{}, nil) +
		"\n\n_Work in progress by the factory. Commits land here as they are pushed._\n"
}

// ProofCoverage is the criteria with no `ac<k>.*` or `ac<k>-*` proof file.
func ProofCoverage(criteria []int, proofFiles []string) []int {
	var missing []int
	for _, k := range criteria {
		re := regexp.MustCompile(fmt.Sprintf(`(?i)^ac%d(\.|-)`, k))
		if !slices.ContainsFunc(proofFiles, re.MatchString) {
			missing = append(missing, k)
		}
	}
	return missing
}
