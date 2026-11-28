package ui

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
)

var now = time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)

func mk(mods ...func(*job.Job)) job.Job {
	j := job.New(job.NewArgs{ID: "261126-x", Branch: "factory/261126-x", Base: "main", Feature: "f", Repo: "/repo", Harness: config.Claude, Slot: 1, Now: now.Add(-2 * time.Hour)})
	for _, m := range mods {
		m(&j)
	}
	return j
}

func stage(s job.Stage) func(*job.Job) {
	return func(j *job.Job) { j.Stage, j.WaitingFor, j.WaitingSince = s, "", nil }
}

func waiting(s job.Stage, w job.WaitingFor) func(*job.Job) {
	return func(j *job.Job) { j.Stage, j.WaitingFor, j.WaitingSince = s, w, new(now.Add(-3*time.Minute)) }
}

func TestAgo(t *testing.T) {
	cases := map[time.Duration]string{45 * time.Second: "45s", 3 * time.Minute: "3m", 2 * time.Hour: "2h", 96 * time.Hour: "4d", -time.Minute: "0s"}
	for d, want := range cases {
		if got := Ago(now.Add(-d), now); got != want {
			t.Errorf("%v: got %q, want %q", d, got, want)
		}
	}
	if got := Ago(time.Time{}, now); got != "-" {
		t.Errorf("zero: got %q", got)
	}
}

func TestHeadline(t *testing.T) {
	cases := map[string]string{
		"git push failed (exit 1): rejected": "git push failed (exit 1): rejected",
		"summary line\n\nlast output\nmore":  "summary line",
		"":                                   "",
		"trailing  \nx":                      "trailing",
	}
	for in, want := range cases {
		if got := Headline(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestWhatForAndNextHint(t *testing.T) {
	cases := []struct {
		name       string
		job        job.Job
		what, next string
	}{
		{"grill", mk(), "Answer the grill questions", "factory answer 261126-x"},
		{"running", mk(stage(job.StageBuild)), "", "factory logs 261126-x -f to watch"},
		{"done", mk(stage(job.StageDone)), "", ""},
		{
			"review with pr", mk(waiting(job.StageHumanReview, job.WaitHumanReview), func(j *job.Job) { j.PR = "https://x/pull/7" }),
			"Review the PR: https://x/pull/7", `factory approve 261126-x   or   factory feedback 261126-x "…"`,
		},
		{
			"report", mk(waiting(job.StageHumanReview, job.WaitHumanReview), func(j *job.Job) { j.Deliverable = job.DeliverReport }),
			"Read the report: .factory/jobs/261126-x/report.md", `factory approve 261126-x   or   factory feedback 261126-x "…"`,
		},
		{
			"failure takes the headline", mk(waiting(job.StageNeedsHuman, job.WaitFailure), func(j *job.Job) { j.Reason = "gh failed (exit 1): nope\n\ntail" }),
			"Failed: gh failed (exit 1): nope", `factory unblock 261126-x "<decision>"   or   factory run 261126-x to retry   or   factory discard 261126-x`,
		},
		{
			"failure without reason", mk(waiting(job.StageNeedsHuman, job.WaitFailure)), "Failed: unknown reason",
			`factory unblock 261126-x "<decision>"   or   factory run 261126-x to retry   or   factory discard 261126-x`,
		},
		{
			"escalation", mk(waiting(job.StageNeedsHuman, job.WaitEscalation), func(j *job.Job) { j.QuestionsFile = "/repo/.factory/jobs/261126-x/docs/design.md" }),
			"A judge escalated; see .factory/jobs/261126-x/docs/design.md",
			`factory approve 261126-x   or   factory feedback 261126-x "…"   (see .factory/jobs/261126-x/docs/design.md)`,
		},
		{
			"env cap", mk(waiting(job.StageNeedsHuman, job.WaitFailure), func(j *job.Job) { j.CapHit = job.CapEnv }),
			"QA env failed twice; see the validation files",
			"factory run 261126-x once QA is back   or   factory approve 261126-x   or   factory discard 261126-x",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := WhatFor(c.job); got != c.what {
				t.Errorf("WhatFor: got %q, want %q", got, c.what)
			}
			if got := NextHint(c.job); got != c.next {
				t.Errorf("NextHint: got %q, want %q", got, c.next)
			}
		})
	}
}

func TestNextLines(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	if got := NextLines("factory answer x"); !slices.Equal(got, []string{"next: factory answer x"}) {
		t.Errorf("short: %q", got)
	}
	long := NextHint(mk(waiting(job.StageNeedsHuman, job.WaitEscalation), func(j *job.Job) { j.QuestionsFile = "/repo/.factory/jobs/261126-x/docs/design.md" }))
	want := []string{
		"next: factory approve 261126-x",
		`  or  factory feedback 261126-x "…"`,
		"      (see .factory/jobs/261126-x/docs/design.md)",
	}
	if got := NextLines(long); !slices.Equal(got, want) {
		t.Errorf("long:\n%s", strings.Join(got, "\n"))
	}
}

func TestStatusTable(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	jobs := []job.Job{
		mk(stage(job.StageDone), func(j *job.Job) { j.ID, j.PR = "done-1", "https://x/pull/3" }),
		mk(stage(job.StageBuild), func(j *job.Job) { j.ID, j.Trip = "run-1", 2 }),
		mk(waiting(job.StageHumanReview, job.WaitHumanReview), func(j *job.Job) { j.ID = "wait-1" }),
	}
	want := strings.Join([]string{
		"  JOB     STAGE         TRIP  WAITING    PR  AGE",
		"● wait-1  human-review  -     review 3m  -   2h",
		"  run-1   build         2     -          -   2h",
		"  done-1  done          -     -          #3  2h",
	}, "\n")
	if got := StatusTable(jobs, now); got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestPipelineLine(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	cases := []struct {
		name string
		job  job.Job
		want string
	}{
		{"review counter", mk(stage(job.StageReview), func(j *job.Job) {
			j.Trips = []job.TripRecord{{Reviews: map[string]string{"code": "pass", "ux": "pending", "ui": "pending"}}}
		}), "Discovery ✓ ─ Building ● review 1/3 ─ Validation ○ ─ Deploy ○"},
		{
			"failure", mk(waiting(job.StageNeedsHuman, job.WaitFailure), func(j *job.Job) { j.ResumeStage = job.StageBuild }),
			"Discovery ✓ ─ Building ✗ build ─ Validation ○ ─ Deploy ○",
		},
		{"done", mk(stage(job.StageDone)), "Discovery ✓ ─ Building ✓ ─ Validation ✓ ─ Deploy ✓"},
		{
			"report job", mk(stage(job.StageReport), func(j *job.Job) { j.Deliverable = job.DeliverReport }),
			"Discovery ✓ ─ Building ● report ─ Deploy ○",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := PipelineLine(c.job); got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestPRNumber(t *testing.T) {
	for in, want := range map[string]string{"": "-", "https://github.com/o/r/pull/12": "#12", "https://x/y": "#?"} {
		if got := PRNumber(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestRenderStatus(t *testing.T) {
	cfg := config.Defaults()
	docs := []string{".factory/jobs/261126-x/docs/requirements.md", ".factory/jobs/261126-x/docs/design.md"}
	j := mk(stage(job.StageReview), func(j *job.Job) {
		j.Cycle, j.Trip, j.ExtraTrips, j.Planned = 2, 1, 1, true
		j.Trips = []job.TripRecord{{Reviews: map[string]string{"code": "pass", "ux": "pending"}}}
	})
	want := strings.Join([]string{
		"<!-- factory:status -->",
		"**🏭 Factory** · `261126-x` · cycle 2 · trip 1/4 · ⏳ **Building: review (1/2)**",
		"",
		"| Stage | Steps |",
		"| --- | --- |",
		"| Discovery | ✅ requirements · ✅ access check · ✅ tech discovery · ✅ design · ✅ AI review |",
		"| Building | ✅ plan · ✅ build · ⏳ review (1/2) · ⬜ judge |",
		"| Validation | ⬜ test plan · ⬜ rebase · ⬜ QA ready · ⬜ validators · ⬜ judge |",
		"| Deploy | ⬜ your review · ⬜ ready |",
		"",
		"Docs: `.factory/jobs/261126-x/docs/requirements.md` · `.factory/jobs/261126-x/docs/design.md`",
		"<!-- /factory:status -->",
	}, "\n")
	got := RenderStatus(j, cfg, docs)
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
	if strings.Contains(got, "](") {
		t.Error("docs must be code spans, not links")
	}
	if strings.Contains(RenderStatus(j, cfg, nil), "Docs:") {
		t.Error("no docs line without docs")
	}
}

func TestRenderStatusHeadlines(t *testing.T) {
	cfg := config.Defaults()
	cases := []struct {
		name string
		job  job.Job
		want string
	}{
		{"grill", mk(), "⏸ **Waiting for you: answer the grill**"},
		{"multi-line reason shows its first line", mk(waiting(job.StageNeedsHuman, job.WaitFailure), func(j *job.Job) {
			j.ResumeStage, j.Reason = job.StageBuild, "git push failed (exit 1): rejected\n\nremote: no\nremote: no"
		}), "⏸ **Waiting for you: git push failed (exit 1): rejected**"},
		{"escalation without a reason", mk(waiting(job.StageNeedsHuman, job.WaitEscalation), func(j *job.Job) { j.ResumeStage = job.StageBuild }), "⏸ **Waiting for you: escalation**"},
		{"done", mk(stage(job.StageDone)), "✅ **Done**"},
		{"discarded", mk(stage(job.StageDiscarded)), "🗑 **Discarded**"},
		{"review", mk(waiting(job.StageHumanReview, job.WaitHumanReview)), "⏸ **Waiting for your review**"},
		{"running", mk(stage(job.StageBuild)), "⏳ **Building: build**"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := RenderStatus(c.job, cfg, nil); !strings.Contains(got, c.want) {
				t.Errorf("want %q in:\n%s", c.want, got)
			}
		})
	}
	failed := RenderStatus(cases[1].job, cfg, nil)
	if strings.Contains(failed, "remote: no") || !strings.Contains(failed, "❌ build") {
		t.Errorf("failed block:\n%s", failed)
	}
}

func TestInitialBody(t *testing.T) {
	got := InitialBody(mk())
	if !strings.HasSuffix(got, "\n\n_Work in progress by the factory. Commits land here as they are pushed._\n") {
		t.Errorf("got:\n%s", got)
	}
	if strings.Contains(got, "trip ") {
		t.Error("a fresh job shows no trip cap")
	}
}

func TestMergeStatus(t *testing.T) {
	const old = statusStart + "\nold\n" + statusEnd
	cases := []struct{ name, body, status, want string }{
		{"prepends", "text", "S", "S\n\ntext"},
		{"replaces", "top\n" + old + "\nbottom", "S", "top\nS\nbottom"},
		{"dollar stays literal", old, "$1 $&", "$1 $&"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := MergeStatus(c.body, c.status); got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestMergeDecision(t *testing.T) {
	status := statusStart + "\ns\n" + statusEnd
	block := func(d string) string { return decisionStart + "\n" + d + "\n" + decisionEnd }
	cases := []struct{ name, body, decision, want string }{
		{"below the status block", status + "\n\nrest", "D", status + "\n\n" + block("D") + "\n\nrest"},
		{"status only", status, "D", status + "\n\n" + block("D")},
		{"no status goes on top", "rest", "D", block("D") + "\n\nrest"},
		{"empty body", "", "D", block("D")},
		{"replaces an earlier one", status + "\n\n" + block("old") + "\n\nrest", "new", status + "\n\n" + block("new") + "\n\nrest"},
		{"removes", status + "\n\n" + block("old") + "\n\nrest", "", status + "\n\nrest"},
		{"removing from nothing", "rest", "", "rest"},
		{"dollar stays literal", status, "$1", status + "\n\n" + block("$1")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := MergeDecision(c.body, c.decision); got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestProofCoverage(t *testing.T) {
	files := []string{"ac1-merged.txt", "AC2.png", "ac30-x.txt", "notes.txt"}
	if got := ProofCoverage([]int{1, 2, 3, 30}, files); !slices.Equal(got, []int{3}) {
		t.Errorf("got %v", got)
	}
	if got := ProofCoverage([]int{3}, []string{"ac3"}); !slices.Equal(got, []int{3}) {
		t.Errorf("ac3 without a separator is not proof: %v", got)
	}
}
