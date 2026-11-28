// Package ui renders what people read: the CLI's status table, hints and
// pipeline line, and the pull request's status block.
package ui

import (
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/tail"
)

// Color is a named terminal color.
type Color string

// The colors Paint knows.
const (
	Dim    Color = "2"
	Bold   Color = "1"
	Green  Color = "32"
	Red    Color = "31"
	Yellow Color = "33"
	Gold   Color = "38;5;178"
	Cyan   Color = "36"
)

// Paint is s in color; plain when NO_COLOR is set or stdout is not a TTY.
func Paint(c Color, s string) string {
	if !tail.UseColor() {
		return s
	}
	return "\x1b[" + string(c) + "m" + s + "\x1b[0m"
}

// Ago is `45s`, `3m`, `2h` or `4d`; `-` for a zero time.
func Ago(t, now time.Time) string {
	if t.IsZero() {
		return "-"
	}
	s := max(0, int(now.Sub(t).Seconds()))
	switch {
	case s < 60:
		return fmt.Sprintf("%ds", s)
	case s < 3600:
		return fmt.Sprintf("%dm", s/60)
	case s < 86400:
		return fmt.Sprintf("%dh", s/3600)
	}
	return fmt.Sprintf("%dd", s/86400)
}

// Headline is a reason's first line: the one-line form of a failure.
func Headline(reason string) string {
	first, _, _ := strings.Cut(reason, "\n")
	return strings.TrimRight(first, " \t\r")
}

// show is a job file relative to the repo (the worktree is
// <repo>/.factory/<id>). A file outside the repo stays absolute.
func show(j job.Job, file string) string {
	rel, err := filepath.Rel(filepath.Dir(filepath.Dir(j.Worktree)), file)
	if err != nil || strings.HasPrefix(rel, "..") {
		return file
	}
	return rel
}

func judgeFile(j job.Job) string {
	if j.QuestionsFile != "" {
		return j.QuestionsFile
	}
	return j.ReasonFile
}

// WhatFor is what the human needs to do for a waiting job; "" when it needs
// nothing.
func WhatFor(j job.Job) string {
	switch j.Stage {
	case job.StageRequirements:
		return "Answer the grill questions"
	case job.StageHumanReview:
		if j.Deliverable == job.DeliverReport {
			return "Read the report: " + show(j, filepath.Join(filepath.Dir(j.Worktree), "jobs", j.ID, "report.md"))
		}
		if j.PR != "" {
			return "Review the PR: " + j.PR
		}
		return "Review the PR"
	case job.StageNeedsHuman:
		file := judgeFile(j)
		switch {
		case j.CapHit == job.CapEnv:
			see := "the validation files"
			if j.ReasonFile != "" {
				see = show(j, j.ReasonFile)
			}
			return "QA env failed twice; see " + see
		case j.WaitingFor == job.WaitEscalation:
			if file != "" {
				return "A judge escalated; see " + show(j, file)
			}
			return "A judge escalated"
		}
		if j.Reason == "" {
			return "Failed: unknown reason"
		}
		return "Failed: " + Headline(j.Reason)
	}
	return ""
}

// NextHint is the command(s) to type next. The CLI, the driver window and
// the dashboard share it. It is "" when nothing is next.
func NextHint(j job.Job) string {
	id := j.ID
	respond := fmt.Sprintf("factory approve %s   or   factory feedback %s \"…\"", id, id)
	switch j.Stage {
	case job.StageRequirements:
		return "factory answer " + id
	case job.StageHumanReview:
		return respond
	case job.StageNeedsHuman:
		if j.CapHit == job.CapEnv {
			return fmt.Sprintf("factory run %s once QA is back   or   factory approve %s   or   factory discard %s", id, id, id)
		}
		if j.WaitingFor == job.WaitEscalation {
			if file := judgeFile(j); file != "" {
				return respond + "   (see " + show(j, file) + ")"
			}
			return respond
		}
		return fmt.Sprintf("factory unblock %s \"<decision>\"   or   factory run %s to retry   or   factory discard %s", id, id, id)
	case job.StageDone, job.StageDiscarded:
		return ""
	}
	return fmt.Sprintf("factory logs %s -f to watch", id)
}

const (
	width = 80
	or    = "   or   "
	see   = "   (see "
)

// NextLines is `next: <hint>`; past 80 columns, one alternative per line
// with the commands aligned.
func NextLines(hint string) []string {
	label := Paint(Dim, "next:")
	if utf8.RuneCountInString("next: "+hint) <= width {
		return []string{label + " " + hint}
	}
	body, tailPart, hasSee := strings.Cut(hint, see)
	parts := strings.Split(body, or)
	out := []string{label + " " + parts[0]}
	for _, alt := range parts[1:] {
		out = append(out, Paint(Dim, "  or")+"  "+alt)
	}
	if hasSee {
		out = append(out, "      (see "+tailPart)
	}
	return out
}

// NeedsYou is true for a job that waits on the human: the grill, PR review,
// an escalation or a failure.
func NeedsYou(j job.Job) bool {
	return j.WaitingFor != "" && j.Stage != job.StageDone && j.Stage != job.StageDiscarded
}

// counter is ` 3/5`: verdicts in over lenses (or validators) of the current
// trip, in review or validation.
func counter(j job.Job) string {
	if len(j.Trips) == 0 {
		return ""
	}
	trip := j.Trips[len(j.Trips)-1]
	var rec map[string]string
	switch j.Stage {
	case job.StageReview:
		rec = trip.Reviews
	case job.StageValidation:
		rec = trip.Validations
	}
	if len(rec) == 0 {
		return ""
	}
	return " " + verdictCount(rec)
}

func verdictCount(rec map[string]string) string {
	in := 0
	for _, v := range rec {
		if v != "pending" {
			in++
		}
	}
	return fmt.Sprintf("%d/%d", in, len(rec))
}

// PipelineLine is `Discovery ✓ ─ Building ● review 3/5 ─ Validation ○ ─ Deploy ○`.
func PipelineLine(j job.Job) string {
	current := j.Stage
	if j.Stage == job.StageNeedsHuman {
		current = j.ResumeStage
	}
	steps := Steps(j)
	all := groupsOf(steps)
	at := -1
	stepAt := slices.IndexFunc(steps, func(s Step) bool { return s.Stage == current })
	if stepAt >= 0 {
		at = slices.Index(all, steps[stepAt].Group)
	}
	groups := make([]string, len(all))
	for i, g := range all {
		switch {
		case j.Stage == job.StageDone:
			groups[i] = g + " " + Paint(Green, "✓")
		case j.Stage == job.StageDiscarded:
			mark := Paint(Dim, "○")
			if j.Planned && i == 0 {
				mark = Paint(Green, "✓")
			}
			groups[i] = g + " " + mark
		case i < at:
			groups[i] = g + " " + Paint(Green, "✓")
		case i > at || stepAt < 0:
			groups[i] = g + " " + Paint(Dim, "○")
		default:
			mark := Paint(Cyan, "●")
			switch {
			case j.Stage == job.StageNeedsHuman && j.WaitingFor == job.WaitFailure:
				mark = Paint(Red, "✗")
			case NeedsYou(j):
				mark = Paint(Gold, "●")
			}
			groups[i] = Paint(Bold, g) + " " + mark + " " + steps[stepAt].Label + counter(j)
		}
	}
	return strings.Join(groups, Paint(Dim, " ─ "))
}

var waitingLabel = map[job.WaitingFor]string{
	job.WaitRequirements: "grill",
	job.WaitHumanReview:  "review",
	job.WaitEscalation:   "escalation",
	job.WaitFailure:      "failure",
}

var pullNumber = regexp.MustCompile(`/pull/(\d+)`)

// PRNumber is `#12` for a PR url, `#?` when it has no number, `-` for none.
func PRNumber(pr string) string {
	if pr == "" {
		return "-"
	}
	if m := pullNumber.FindStringSubmatch(pr); m != nil {
		return "#" + m[1]
	}
	return "#?"
}

// rank puts needs-you rows first, then running, then done or discarded.
func rank(j job.Job) int {
	switch {
	case NeedsYou(j):
		return 0
	case j.Stage == job.StageDone || j.Stage == job.StageDiscarded:
		return 2
	}
	return 1
}

// StatusTable is one row per job: `JOB  STAGE  TRIP  WAITING  PR  AGE`.
func StatusTable(jobs []job.Job, now time.Time) string {
	sorted := slices.Clone(jobs)
	sort.SliceStable(sorted, func(a, b int) bool { return rank(sorted[a]) < rank(sorted[b]) })
	header := []string{"JOB", "STAGE", "TRIP", "WAITING", "PR", "AGE"}
	type row struct {
		mark  bool
		cells []string
	}
	rows := make([]row, len(sorted))
	for i, j := range sorted {
		waiting := "-"
		if NeedsYou(j) {
			label, ok := waitingLabel[j.WaitingFor]
			if !ok {
				label = string(j.WaitingFor)
			}
			waiting = label
			if j.WaitingSince != nil {
				waiting += " " + Ago(*j.WaitingSince, now)
			}
		}
		trip := "-"
		if j.Trip > 0 {
			trip = fmt.Sprint(j.Trip)
		}
		rows[i] = row{NeedsYou(j), []string{j.ID, string(j.Stage), trip, waiting, PRNumber(j.PR), Ago(j.CreatedAt, now)}}
	}
	widths := make([]int, len(header))
	for c, h := range header {
		widths[c] = utf8.RuneCountInString(h)
		for _, r := range rows {
			widths[c] = max(widths[c], utf8.RuneCountInString(r.cells[c]))
		}
	}
	line := func(cells []string) string {
		padded := make([]string, len(cells))
		for c, s := range cells {
			padded[c] = s + strings.Repeat(" ", widths[c]-utf8.RuneCountInString(s))
		}
		return strings.TrimRight(strings.Join(padded, "  "), " ")
	}
	out := []string{"  " + Paint(Bold, line(header))}
	for _, r := range rows {
		mark := " "
		if r.mark {
			mark = Paint(Gold, "●")
		}
		out = append(out, mark+" "+line(r.cells))
	}
	return strings.Join(out, "\n")
}
