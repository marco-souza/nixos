package app

import (
	"bufio"
	"encoding/json"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/ui"
)

const activityLines = 10

// statusJob is a job in --json output: the v3 job plus what it needs.
type statusJob struct {
	job.Job
	Hint    string `json:"hint"`
	WhatFor string `json:"whatFor"`
}

func toStatus(j job.Job) statusJob {
	return statusJob{Job: j, Hint: ui.NextHint(j), WhatFor: ui.WhatFor(j)}
}

// Status is the text `factory status` prints: every job and what it needs, or
// one job in detail.
func Status(repo, id string, asJSON bool, now time.Time) (string, error) {
	if id != "" {
		j, err := findJob(repo, id)
		if err != nil {
			return "", err
		}
		if asJSON {
			return marshal(toStatus(j))
		}
		return detail(repo, j), nil
	}
	jobs := job.List(repo)
	if asJSON {
		out := make([]statusJob, len(jobs))
		for i, j := range jobs {
			out[i] = toStatus(j)
		}
		return marshal(out)
	}
	if len(jobs) == 0 {
		return `No factory jobs yet. Start one: factory new "<feature>"`, nil
	}
	out := ui.StatusTable(jobs, now)
	// What to type for each job that needs the human, in table order.
	var hints []string
	for _, j := range jobs {
		if ui.NeedsYou(j) {
			hints = append(hints, ui.NextLines(ui.NextHint(j))...)
		}
	}
	if len(hints) > 0 {
		out += "\n\n" + strings.Join(hints, "\n")
	}
	return out, nil
}

func marshal(v any) (string, error) {
	b, err := json.MarshalIndent(v, "", "  ")
	return string(b), err
}

// detail is one job: header, pipeline, what it needs (with the full reason),
// running agents, recent activity and the next step.
func detail(repo string, j job.Job) string {
	title := ui.Paint(ui.Bold, j.ID)
	if j.Feature != "" {
		title += "  " + j.Feature
	}
	facts := []string{string(j.Stage), "cycle " + strconv.Itoa(j.Cycle)}
	if j.Trip > 0 {
		facts = append(facts, "trip "+strconv.Itoa(j.Trip))
	}
	facts = append(facts, "base "+j.Base)
	if j.Deliverable == job.DeliverReport {
		facts = append(facts, "report")
	}
	if j.PR != "" {
		facts = append(facts, j.PR)
	}
	sections := [][]string{{title, strings.Join(facts, " · "), ui.PipelineLine(j)}}

	var now []string
	if why := ui.WhatFor(j); why != "" {
		now = append(now, ui.Paint(ui.Gold, "Needs you:")+" "+why)
		// The one-line form above is the headline; show the rest of it.
		if j.Reason != "" && strings.Contains(j.Reason, "\n") && j.WaitingFor == job.WaitFailure {
			for l := range strings.Lines(strings.TrimRight(j.Reason, "\n")) {
				now = append(now, "  "+strings.TrimRight(l, "\n"))
			}
		}
	}
	if len(j.Running) > 0 {
		now = append(now, "Running: "+strings.Join(j.Running, ", "))
	}
	sections = append(sections, now)

	var act []string
	for _, l := range activity(repo, j.ID) {
		act = append(act, ui.Paint(ui.Dim, "  "+l))
	}
	sections = append(sections, act)
	if hint := ui.NextHint(j); hint != "" {
		sections = append(sections, ui.NextLines(hint))
	}
	var parts []string
	for _, s := range sections {
		if len(s) > 0 {
			parts = append(parts, strings.Join(s, "\n"))
		}
	}
	return strings.Join(parts, "\n\n")
}

func activity(repo, id string) []string {
	f, err := os.Open(job.NewPaths(repo, id).ActivityLog)
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()
	var lines []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if sc.Text() != "" {
			lines = append(lines, sc.Text())
		}
	}
	return slices.Clone(lines[max(0, len(lines)-activityLines):])
}
