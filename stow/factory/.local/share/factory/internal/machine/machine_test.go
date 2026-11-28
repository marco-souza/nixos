package machine

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
)

const id = "261126-x"

var (
	earlier = time.Date(2026, 11, 26, 9, 0, 0, 0, time.UTC)
	now     = time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	lim     = Limits{MaxTrips: 3, MaxDiscoveryLoops: 3}
	// nada marks a field that must be unset.
	nada any
)

func ts(t time.Time) string { return t.Format(time.RFC3339Nano) }

type mod func(*job.Job)

// mkJob is a job in a stage; stages other than requirements start with no wait.
func mkJob(mods ...mod) job.Job {
	j := job.New(job.NewArgs{ID: id, Branch: "factory/" + id, Base: "main", Feature: "f", Repo: "/repo", Harness: config.Claude, Slot: 1, Now: earlier})
	for _, m := range mods {
		m(&j)
	}
	if j.Stage != job.StageRequirements && j.WaitingFor == job.WaitRequirements {
		j.WaitingFor, j.WaitingSince = "", nil
	}
	return j
}

func in(s job.Stage) mod { return func(j *job.Job) { j.Stage = s } }

func rec(cycle, trip int) job.TripRecord {
	return job.TripRecord{Cycle: cycle, Trip: trip, Reviews: map[string]string{}, Validations: map[string]string{}}
}

// inTrip is a planned job in trip 1 (mods can override).
func inTrip(mods ...mod) job.Job {
	return mkJob(append([]mod{func(j *job.Job) {
		j.Planned, j.Trip, j.Trips = true, 1, []job.TripRecord{rec(1, 1)}
	}}, mods...)...)
}

func waits(wf job.WaitingFor, since time.Time) mod {
	return func(j *job.Job) { j.WaitingFor, j.WaitingSince = wf, &since }
}

func done(stage job.Stage, mods ...func(*Outcome)) Outcome {
	o := Outcome{Kind: OutcomeDone, Stage: stage}
	for _, m := range mods {
		m(&o)
	}
	return o
}

func verdict(v string) func(*Outcome)    { return func(o *Outcome) { o.Verdict = v } }
func reasonFile(f string) func(*Outcome) { return func(o *Outcome) { o.ReasonFile = f } }
func questions(f string) func(*Outcome)  { return func(o *Outcome) { o.QuestionsFile = f } }

func routeOK(t *testing.T, j job.Job, o Outcome) job.Job {
	t.Helper()
	got, err := Route(j, o, lim, now)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func applyOK(t *testing.T, j job.Job, c Command) job.Job {
	t.Helper()
	got, err := Apply(j, c, now)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// match checks the listed fields of j by their JSON names (toMatchObject).
// nada means absent or null.
func match(t *testing.T, j job.Job, want map[string]any) {
	t.Helper()
	data, _ := json.Marshal(j)
	var got map[string]any
	_ = json.Unmarshal(data, &got)
	data, _ = json.Marshal(want)
	var w map[string]any
	_ = json.Unmarshal(data, &w)
	for k, wv := range w {
		if gv := got[k]; !reflect.DeepEqual(gv, wv) {
			t.Errorf("%s = %v, want %v", k, gv, wv)
		}
	}
}

func trips(t *testing.T, j job.Job, want ...job.TripRecord) {
	t.Helper()
	if len(j.Trips) != len(want) || (len(want) > 0 && !reflect.DeepEqual(j.Trips, want)) {
		t.Errorf("trips = %+v, want %+v", j.Trips, want)
	}
}

func withJudge(r job.TripRecord, build, validation string) job.TripRecord {
	r.BuildJudge, r.ValidationJudge = build, validation
	return r
}

func wantCommandError(t *testing.T, j job.Job, c Command, msg string) {
	t.Helper()
	_, err := Apply(j, c, now)
	var ce *CommandError
	if !errors.As(err, &ce) {
		t.Fatalf("err = %v, want a *CommandError", err)
	}
	if err.Error() != msg {
		t.Errorf("err = %q, want %q", err, msg)
	}
}

func TestRouteLinearStages(t *testing.T) {
	for _, c := range [][2]job.Stage{
		{"requirements", "preflight"},
		{"preflight", "tech-discovery"},
		{"tech-discovery", "design"},
		{"design", "discovery-review"},
		{"build", "review"},
		{"review", "build-judge"},
		{"test-planning", "rebase"},
		{"rebase", "qa-wait"},
		{"qa-wait", "validation"},
		{"validation", "validation-judge"},
		{"finalize", "done"},
	} {
		t.Run(string(c[0])+" → "+string(c[1]), func(t *testing.T) {
			j := routeOK(t, mkJob(in(c[0])), done(c[0]))
			match(t, j, map[string]any{"stage": string(c[1]), "waitingFor": nada, "waitingSince": nada})
		})
	}

	t.Run("a report job goes from preflight to report, then to the human", func(t *testing.T) {
		r := routeOK(t, mkJob(in(job.StagePreflight), func(j *job.Job) { j.Deliverable = job.DeliverReport }), done(job.StagePreflight))
		match(t, r, map[string]any{"stage": "report", "waitingFor": nada})
		match(t, routeOK(t, r, done(job.StageReport)), map[string]any{"stage": "human-review", "waitingFor": "human-review"})
	})

	t.Run("planning done sets planned and goes to build", func(t *testing.T) {
		j := routeOK(t, inTrip(in(job.StagePlanning), func(j *job.Job) { j.Planned = false }), done(job.StagePlanning))
		match(t, j, map[string]any{"stage": "build", "planned": true, "trip": 1})
	})
}

func TestRouteDiscovery(t *testing.T) {
	t.Run("design with human questions goes back to requirements", func(t *testing.T) {
		j := routeOK(t, mkJob(in(job.StageDesign)), done(job.StageDesign, func(o *Outcome) { o.HumanQuestions, o.QuestionsFile = true, "/design.md" }))
		match(t, j, map[string]any{
			"stage": "requirements", "discoveryLoops": 1, "waitingFor": "requirements", "waitingSince": ts(now), "questionsFile": "/design.md",
		})
		if len(j.Discovery) != 0 {
			t.Errorf("discovery = %v, want none", j.Discovery)
		}
	})

	t.Run("design questions at the cap go to needs-human, resuming in requirements", func(t *testing.T) {
		j := routeOK(t, mkJob(in(job.StageDesign), func(j *job.Job) { j.DiscoveryLoops = 2 }),
			done(job.StageDesign, func(o *Outcome) { o.HumanQuestions, o.QuestionsFile = true, "/design.md" }))
		match(t, j, map[string]any{
			"stage": "needs-human", "waitingFor": "failure", "capHit": "discovery", "resumeStage": "requirements",
			"discoveryLoops": 3, "questionsFile": "/design.md", "reason": "discovery loop cap (3) reached",
		})
	})

	t.Run("PASS starts trip 1 with a new TripRecord", func(t *testing.T) {
		j := routeOK(t, mkJob(in(job.StageDiscoveryReview), func(j *job.Job) { j.EnvRetries = 1 }), done(job.StageDiscoveryReview, verdict("PASS")))
		match(t, j, map[string]any{"stage": "planning", "cycle": 1, "trip": 1, "envRetries": 0, "waitingFor": nada, "discoveryLoops": 0})
		trips(t, j, rec(1, 1))
		if want := []job.DiscoveryRecord{{N: 1, Verdict: "PASS"}}; !reflect.DeepEqual(j.Discovery, want) {
			t.Errorf("discovery = %v", j.Discovery)
		}
	})

	t.Run("REWORK goes to the named step without the human", func(t *testing.T) {
		j := routeOK(t, mkJob(in(job.StageDiscoveryReview)), done(job.StageDiscoveryReview, verdict("REWORK"), func(o *Outcome) { o.ReworkStep = job.StageTechDiscovery }))
		match(t, j, map[string]any{"stage": "tech-discovery", "discoveryLoops": 1, "waitingFor": nada, "waitingSince": nada})
		if want := []job.DiscoveryRecord{{N: 1, Verdict: "REWORK"}}; !reflect.DeepEqual(j.Discovery, want) {
			t.Errorf("discovery = %v", j.Discovery)
		}
	})

	t.Run("REWORK without a step defaults to design", func(t *testing.T) {
		j := routeOK(t, mkJob(in(job.StageDiscoveryReview)), done(job.StageDiscoveryReview, verdict("REWORK")))
		match(t, j, map[string]any{"stage": "design"})
	})

	t.Run("ASK goes to requirements with the questions", func(t *testing.T) {
		prior := []job.DiscoveryRecord{{N: 1, Verdict: "REWORK"}}
		j := routeOK(t, mkJob(in(job.StageDiscoveryReview), func(j *job.Job) { j.DiscoveryLoops, j.Discovery = 1, prior }),
			done(job.StageDiscoveryReview, verdict("ASK"), questions("/q")))
		match(t, j, map[string]any{
			"stage": "requirements", "discoveryLoops": 2, "waitingFor": "requirements", "waitingSince": ts(now), "questionsFile": "/q",
		})
		if want := append(append([]job.DiscoveryRecord{}, prior...), job.DiscoveryRecord{N: 2, Verdict: "ASK"}); !reflect.DeepEqual(j.Discovery, want) {
			t.Errorf("discovery = %v", j.Discovery)
		}
	})

	t.Run("third non-PASS discovery review hits the cap", func(t *testing.T) {
		j := routeOK(t, mkJob(in(job.StageDiscoveryReview), func(j *job.Job) { j.DiscoveryLoops = 2 }),
			done(job.StageDiscoveryReview, verdict("ASK"), questions("/q")))
		match(t, j, map[string]any{
			"stage": "needs-human", "waitingFor": "failure", "capHit": "discovery", "resumeStage": "requirements",
			"discoveryLoops": 3, "questionsFile": "/q", "reason": "discovery loop cap (3) reached", "waitingSince": ts(now),
		})
		if want := []job.DiscoveryRecord{{N: 1, Verdict: "ASK"}}; !reflect.DeepEqual(j.Discovery, want) {
			t.Errorf("discovery = %v", j.Discovery)
		}
	})

	t.Run("REWORK at the cap resumes into the rework step", func(t *testing.T) {
		j := routeOK(t, mkJob(in(job.StageDiscoveryReview), func(j *job.Job) { j.DiscoveryLoops = 2 }),
			done(job.StageDiscoveryReview, verdict("REWORK"), func(o *Outcome) { o.ReworkStep = job.StageTechDiscovery }))
		match(t, j, map[string]any{"stage": "needs-human", "capHit": "discovery", "resumeStage": "tech-discovery"})
	})

	t.Run("extra discovery loops raise the cap", func(t *testing.T) {
		ask := done(job.StageDiscoveryReview, verdict("ASK"), questions("/q"))
		match(t, routeOK(t, mkJob(in(job.StageDiscoveryReview), func(j *job.Job) { j.DiscoveryLoops, j.ExtraDiscoveryLoops = 3, 1 }), ask),
			map[string]any{"stage": "needs-human", "discoveryLoops": 4, "reason": "discovery loop cap (4) reached"})
		match(t, routeOK(t, mkJob(in(job.StageDiscoveryReview), func(j *job.Job) { j.DiscoveryLoops, j.ExtraDiscoveryLoops = 2, 1 }), ask),
			map[string]any{"stage": "requirements", "discoveryLoops": 3})
	})
}

func TestRouteBuildJudge(t *testing.T) {
	t.Run("APPROVE goes to test-planning and records the verdict", func(t *testing.T) {
		j := routeOK(t, inTrip(in(job.StageBuildJudge)), done(job.StageBuildJudge, verdict("APPROVE")))
		match(t, j, map[string]any{"stage": "test-planning", "trip": 1})
		trips(t, j, withJudge(rec(1, 1), "APPROVE", ""))
	})

	t.Run("CHANGES starts the next trip from planning", func(t *testing.T) {
		j := routeOK(t, inTrip(in(job.StageBuildJudge), func(j *job.Job) { j.EnvRetries = 1 }), done(job.StageBuildJudge, verdict("CHANGES"), reasonFile("/judge.md")))
		match(t, j, map[string]any{"stage": "planning", "trip": 2, "reasonFile": "/judge.md", "envRetries": 0, "waitingFor": nada})
		trips(t, j, withJudge(rec(1, 1), "CHANGES", ""), rec(1, 2))
	})

	t.Run("CHANGES at the trip cap goes to needs-human", func(t *testing.T) {
		j := routeOK(t, inTrip(in(job.StageBuildJudge), func(j *job.Job) { j.Trip, j.Trips = 3, []job.TripRecord{rec(1, 1), rec(1, 2), rec(1, 3)} }),
			done(job.StageBuildJudge, verdict("CHANGES"), reasonFile("/judge.md")))
		match(t, j, map[string]any{
			"stage": "needs-human", "waitingFor": "failure", "capHit": "trips", "resumeStage": "planning", "trip": 3,
			"reasonFile": "/judge.md", "reason": "trip cap (3) reached", "waitingSince": ts(now),
		})
		trips(t, j, rec(1, 1), rec(1, 2), withJudge(rec(1, 3), "CHANGES", ""))
	})

	t.Run("extra trips raise the trip cap", func(t *testing.T) {
		changes := done(job.StageBuildJudge, verdict("CHANGES"), reasonFile("/judge.md"))
		match(t, routeOK(t, inTrip(in(job.StageBuildJudge), func(j *job.Job) { j.Trip, j.ExtraTrips = 3, 1 }), changes),
			map[string]any{"stage": "planning", "trip": 4})
		match(t, routeOK(t, inTrip(in(job.StageBuildJudge), func(j *job.Job) { j.Trip, j.ExtraTrips = 4, 1 }), changes),
			map[string]any{"stage": "needs-human", "capHit": "trips", "reason": "trip cap (4) reached"})
	})

	t.Run("ESCALATE pauses for the human without spending a trip", func(t *testing.T) {
		j := routeOK(t, inTrip(in(job.StageBuildJudge)), done(job.StageBuildJudge, verdict("ESCALATE"), reasonFile("/judge.md"), questions("/judge.md")))
		match(t, j, map[string]any{
			"stage": "needs-human", "waitingFor": "escalation", "resumeStage": "test-planning", "trip": 1, "capHit": nada,
			"reasonFile": "/judge.md", "questionsFile": "/judge.md", "waitingSince": ts(now),
		})
		trips(t, j, withJudge(rec(1, 1), "ESCALATE", ""))
	})
}

func TestRouteValidationJudge(t *testing.T) {
	t.Run("PASS goes to human-review", func(t *testing.T) {
		j := routeOK(t, inTrip(in(job.StageValidationJudge)), done(job.StageValidationJudge, verdict("PASS")))
		match(t, j, map[string]any{"stage": "human-review", "waitingFor": "human-review", "waitingSince": ts(now)})
		trips(t, j, withJudge(rec(1, 1), "", "PASS"))
	})

	t.Run("FAIL starts the next trip like CHANGES", func(t *testing.T) {
		j := routeOK(t, inTrip(in(job.StageValidationJudge), func(j *job.Job) { j.EnvRetries = 1 }), done(job.StageValidationJudge, verdict("FAIL"), reasonFile("/vj.md")))
		match(t, j, map[string]any{"stage": "planning", "trip": 2, "reasonFile": "/vj.md", "envRetries": 0})
		trips(t, j, withJudge(rec(1, 1), "", "FAIL"), rec(1, 2))
	})

	t.Run("FAIL at the trip cap goes to needs-human", func(t *testing.T) {
		j := routeOK(t, inTrip(in(job.StageValidationJudge), func(j *job.Job) { j.Trip = 3 }), done(job.StageValidationJudge, verdict("FAIL"), reasonFile("/vj.md")))
		match(t, j, map[string]any{"stage": "needs-human", "waitingFor": "failure", "capHit": "trips", "resumeStage": "planning", "trip": 3, "reasonFile": "/vj.md"})
	})

	t.Run("first ENV waits for QA again without a trip", func(t *testing.T) {
		j := routeOK(t, inTrip(in(job.StageValidationJudge)), done(job.StageValidationJudge, verdict("ENV")))
		match(t, j, map[string]any{"stage": "qa-wait", "envRetries": 1, "trip": 1, "waitingFor": nada})
		trips(t, j, withJudge(rec(1, 1), "", "ENV"))
	})

	t.Run("second ENV in a trip escalates to the human", func(t *testing.T) {
		j := routeOK(t, inTrip(in(job.StageValidationJudge), func(j *job.Job) { j.EnvRetries = 1 }), done(job.StageValidationJudge, verdict("ENV"), reasonFile("/vj.md")))
		match(t, j, map[string]any{"stage": "needs-human", "waitingFor": "escalation", "resumeStage": "human-review", "reasonFile": "/vj.md"})
	})

	t.Run("second ENV marks the pause as an env cap without stale questions", func(t *testing.T) {
		j := routeOK(t, inTrip(in(job.StageValidationJudge), func(j *job.Job) { j.EnvRetries, j.QuestionsFile = 1, "/old-q.md" }),
			done(job.StageValidationJudge, verdict("ENV"), reasonFile("/vj.md")))
		match(t, j, map[string]any{"capHit": "env", "questionsFile": nada})
	})

	t.Run("ESCALATE pauses for the human, resuming in human-review", func(t *testing.T) {
		j := routeOK(t, inTrip(in(job.StageValidationJudge)), done(job.StageValidationJudge, verdict("ESCALATE"), reasonFile("/vj.md"), questions("/vj.md")))
		match(t, j, map[string]any{"stage": "needs-human", "waitingFor": "escalation", "resumeStage": "human-review", "trip": 1, "questionsFile": "/vj.md"})
	})
}

func TestRouteFailuresAndGuards(t *testing.T) {
	t.Run("failed goes to needs-human, resuming in the failed stage", func(t *testing.T) {
		j := routeOK(t, inTrip(in(job.StageBuild)), Outcome{Kind: OutcomeFailed, Stage: job.StageBuild, Reason: "builder-backend: STATUS: BLOCKED"})
		match(t, j, map[string]any{
			"stage": "needs-human", "waitingFor": "failure", "resumeStage": "build", "reason": "builder-backend: STATUS: BLOCKED",
			"capHit": nada, "waitingSince": ts(now),
		})
	})

	t.Run("an unexpected verdict pauses for the human", func(t *testing.T) {
		j := routeOK(t, inTrip(in(job.StageBuildJudge)), done(job.StageBuildJudge, verdict("MAYBE")))
		match(t, j, map[string]any{"stage": "needs-human", "waitingFor": "failure", "resumeStage": "build-judge", "reason": "build-judge: unexpected verdict MAYBE"})
	})

	t.Run("an outcome for another stage throws", func(t *testing.T) {
		_, err := Route(mkJob(in(job.StageBuild)), done(job.StageReview), lim, now)
		if err == nil || err.Error() != "outcome for review but 261126-x is in build" {
			t.Errorf("err = %v", err)
		}
	})

	t.Run("no outcome is expected while waiting", func(t *testing.T) {
		_, err := Route(mkJob(in(job.StageHumanReview)), done(job.StageHumanReview), lim, now)
		if err == nil || err.Error() != "no outcome expected in human-review" {
			t.Errorf("err = %v", err)
		}
	})

	t.Run("route never mutates its input", func(t *testing.T) {
		cases := []struct {
			in job.Job
			o  Outcome
		}{
			{inTrip(in(job.StageBuildJudge)), done(job.StageBuildJudge, verdict("CHANGES"), reasonFile("/j"))},
			{mkJob(in(job.StageDiscoveryReview)), done(job.StageDiscoveryReview, verdict("PASS"))},
			{mkJob(in(job.StageDiscoveryReview), func(j *job.Job) { j.DiscoveryLoops = 2 }), done(job.StageDiscoveryReview, verdict("ASK"), questions("/q"))},
			{inTrip(in(job.StageValidationJudge)), done(job.StageValidationJudge, verdict("ENV"))},
		}
		for _, c := range cases {
			before := c.in.Clone()
			got := routeOK(t, c.in, c.o)
			if reflect.DeepEqual(got, c.in) {
				t.Error("route returned the input unchanged")
			}
			if !reflect.DeepEqual(c.in, before) {
				t.Errorf("input changed:\n got %+v\nwant %+v", c.in, before)
			}
		}
	})
}

func TestApplyCommandApprove(t *testing.T) {
	t.Run("human-review → finalize, ready", func(t *testing.T) {
		j := applyOK(t, inTrip(in(job.StageHumanReview), waits(job.WaitHumanReview, earlier)), Command{Kind: CmdApprove})
		match(t, j, map[string]any{"stage": "finalize", "ready": true, "waitingFor": nada, "waitingSince": nada})
	})

	t.Run("an escalation resumes where the judge would have gone", func(t *testing.T) {
		esc := func(resume job.Stage) job.Job {
			return inTrip(in(job.StageNeedsHuman), waits(job.WaitEscalation, earlier), func(j *job.Job) { j.ResumeStage = resume })
		}
		match(t, applyOK(t, esc("test-planning"), Command{Kind: CmdApprove}), map[string]any{
			"stage": "test-planning", "waitingFor": nada, "waitingSince": nada, "resumeStage": nada, "capHit": nada, "reason": nada, "stoppedReason": nada,
		})
		match(t, applyOK(t, esc("human-review"), Command{Kind: CmdApprove}), map[string]any{
			"stage": "human-review", "waitingFor": "human-review", "waitingSince": ts(now), "resumeStage": nada,
		})
	})

	t.Run("an env cap goes on to human-review", func(t *testing.T) {
		j := applyOK(t, inTrip(in(job.StageNeedsHuman), func(j *job.Job) {
			j.WaitingFor, j.CapHit, j.ResumeStage, j.EnvRetries = job.WaitEscalation, job.CapEnv, job.StageHumanReview, 1
		}), Command{Kind: CmdApprove})
		match(t, j, map[string]any{"stage": "human-review", "waitingFor": "human-review", "capHit": nada, "resumeStage": nada})
	})

	t.Run("any other needs-human → finalize, not ready", func(t *testing.T) {
		j := applyOK(t, inTrip(in(job.StageNeedsHuman), func(j *job.Job) {
			j.WaitingFor, j.CapHit, j.ResumeStage, j.Reason = job.WaitFailure, job.CapTrips, job.StagePlanning, "trip cap (3) reached"
		}), Command{Kind: CmdApprove})
		match(t, j, map[string]any{
			"stage": "finalize", "ready": false, "waitingFor": nada, "capHit": nada, "resumeStage": nada, "reason": nada,
			"stoppedReason": "trip cap (3) reached",
		})
	})

	t.Run("anything else has nothing to approve", func(t *testing.T) {
		wantCommandError(t, mkJob(in(job.StageBuild)), Command{Kind: CmdApprove}, "nothing to approve: 261126-x is in build")
	})
}

func TestApplyCommandFeedback(t *testing.T) {
	t.Run("a planned job starts a new cycle at planning, trip 1", func(t *testing.T) {
		ready := true
		j := applyOK(t, inTrip(in(job.StageHumanReview), waits(job.WaitHumanReview, earlier), func(j *job.Job) {
			j.Trip, j.Trips, j.Ready, j.FeedbackCount = 2, []job.TripRecord{rec(1, 1), rec(1, 2)}, &ready, 1
		}), Command{Kind: CmdFeedback, File: "/feedback-2.md"})
		match(t, j, map[string]any{
			"stage": "planning", "cycle": 2, "trip": 1, "reasonFile": "/feedback-2.md", "feedbackCount": 2, "ready": nada,
			"waitingFor": nada, "waitingSince": nada,
		})
		trips(t, j, rec(1, 1), rec(1, 2), rec(2, 1))
	})

	t.Run("an unplanned job starts a new cycle at requirements, trip 0", func(t *testing.T) {
		j := applyOK(t, mkJob(in(job.StageDesign)), Command{Kind: CmdFeedback, File: "/feedback-1.md"})
		match(t, j, map[string]any{
			"stage": "requirements", "cycle": 2, "trip": 0, "reasonFile": "/feedback-1.md", "feedbackCount": 1, "ready": nada,
			"waitingFor": "requirements", "waitingSince": ts(now),
		})
		trips(t, j)
	})

	t.Run("a report job writes the report again in a new cycle", func(t *testing.T) {
		j := applyOK(t, mkJob(in(job.StageDone), func(j *job.Job) { j.Deliverable = job.DeliverReport }), Command{Kind: CmdFeedback, File: "/feedback-1.md"})
		match(t, j, map[string]any{"stage": "report", "cycle": 2, "trip": 0, "reasonFile": "/feedback-1.md", "waitingFor": nada})
	})

	t.Run("feedback clears the wait it answers", func(t *testing.T) {
		j := applyOK(t, inTrip(in(job.StageNeedsHuman), func(j *job.Job) {
			j.WaitingFor, j.ResumeStage, j.Reason, j.QuestionsFile = job.WaitEscalation, job.StageTestPlanning, "x", "/judge.md"
		}), Command{Kind: CmdFeedback, File: "/f.md"})
		match(t, j, map[string]any{"stage": "planning", "waitingFor": nada, "resumeStage": nada, "reason": nada, "capHit": nada, "questionsFile": nada})
		after := applyOK(t, inTrip(in(job.StageDone), func(j *job.Job) { j.StoppedReason = "boom" }), Command{Kind: CmdFeedback, File: "/f.md"})
		match(t, after, map[string]any{"stoppedReason": nada})
	})

	t.Run("feedback resets the per-cycle counters", func(t *testing.T) {
		j := applyOK(t, mkJob(in(job.StageNeedsHuman), func(j *job.Job) {
			j.WaitingFor, j.CapHit, j.DiscoveryLoops, j.ExtraDiscoveryLoops, j.ExtraTrips, j.EnvRetries = job.WaitFailure, job.CapDiscovery, 4, 1, 2, 1
		}), Command{Kind: CmdFeedback, File: "/f.md"})
		match(t, j, map[string]any{"discoveryLoops": 0, "extraDiscoveryLoops": 0, "extraTrips": 0, "envRetries": 0, "capHit": nada})
	})

	t.Run("a discarded job takes no feedback", func(t *testing.T) {
		wantCommandError(t, mkJob(in(job.StageDiscarded)), Command{Kind: CmdFeedback, File: "/f.md"}, "cannot send feedback: 261126-x is discarded")
	})
}

func TestApplyCommandRetry(t *testing.T) {
	t.Run("a trip cap gets one more trip", func(t *testing.T) {
		three := []job.TripRecord{rec(1, 1), rec(1, 2), rec(1, 3)}
		j := applyOK(t, inTrip(in(job.StageNeedsHuman), func(j *job.Job) {
			j.WaitingFor, j.CapHit, j.ResumeStage, j.Reason = job.WaitFailure, job.CapTrips, job.StagePlanning, "trip cap (3) reached"
			j.Trip, j.Trips, j.ReasonFile, j.EnvRetries = 3, three, "/judge.md", 1
		}), Command{Kind: CmdRetry})
		match(t, j, map[string]any{
			"stage": "planning", "extraTrips": 1, "trip": 4, "envRetries": 0, "reasonFile": "/judge.md",
			"waitingFor": nada, "waitingSince": nada, "capHit": nada, "resumeStage": nada, "reason": nada,
		})
		trips(t, j, rec(1, 1), rec(1, 2), rec(1, 3), rec(1, 4))
	})

	t.Run("a discovery cap gets one more loop, resuming where it would have gone", func(t *testing.T) {
		j := applyOK(t, mkJob(in(job.StageNeedsHuman), func(j *job.Job) {
			j.WaitingFor, j.CapHit, j.ResumeStage, j.Reason = job.WaitFailure, job.CapDiscovery, job.StageRequirements, "discovery loop cap (3) reached"
			j.DiscoveryLoops, j.QuestionsFile = 3, "/q"
		}), Command{Kind: CmdRetry})
		match(t, j, map[string]any{
			"stage": "requirements", "extraDiscoveryLoops": 1, "discoveryLoops": 3, "questionsFile": "/q",
			"waitingFor": "requirements", "waitingSince": ts(now), "capHit": nada, "resumeStage": nada, "reason": nada,
		})
	})

	t.Run("a failure resumes the failed stage", func(t *testing.T) {
		j := applyOK(t, inTrip(in(job.StageNeedsHuman), func(j *job.Job) { j.WaitingFor, j.ResumeStage, j.Reason = job.WaitFailure, job.StageBuild, "boom" }), Command{Kind: CmdRetry})
		match(t, j, map[string]any{"stage": "build", "trip": 1, "waitingFor": nada, "resumeStage": nada, "reason": nada, "extraTrips": 0})
		fin := applyOK(t, inTrip(in(job.StageNeedsHuman), func(j *job.Job) {
			j.WaitingFor, j.ResumeStage, j.Reason, j.StoppedReason = job.WaitFailure, job.StageFinalize, "gh down", "boom"
		}), Command{Kind: CmdRetry})
		match(t, fin, map[string]any{"stage": "finalize", "stoppedReason": nada})
	})

	t.Run("an env cap validates again in the same trip", func(t *testing.T) {
		j := applyOK(t, inTrip(in(job.StageNeedsHuman), func(j *job.Job) {
			j.WaitingFor, j.CapHit, j.ResumeStage, j.EnvRetries, j.ReasonFile = job.WaitEscalation, job.CapEnv, job.StageHumanReview, 1, "/vj.md"
		}), Command{Kind: CmdRetry})
		match(t, j, map[string]any{
			"stage": "qa-wait", "envRetries": 0, "trip": 1, "waitingFor": nada, "waitingSince": nada, "capHit": nada, "resumeStage": nada, "reason": nada,
		})
		trips(t, j, rec(1, 1))
	})

	t.Run("only a failure or an env cap can be retried", func(t *testing.T) {
		wantCommandError(t, inTrip(in(job.StageNeedsHuman), func(j *job.Job) { j.WaitingFor, j.ResumeStage = job.WaitEscalation, job.StageTestPlanning }),
			Command{Kind: CmdRetry}, "nothing to retry: 261126-x is in needs-human waiting for escalation")
		wantCommandError(t, mkJob(in(job.StageBuild)), Command{Kind: CmdRetry}, "nothing to retry: 261126-x is in build")
	})
}

func TestApplyCommandUnblock(t *testing.T) {
	t.Run("a failure resumes the failed stage with the decision, in the same trip and cycle", func(t *testing.T) {
		j := applyOK(t, inTrip(in(job.StageNeedsHuman), func(j *job.Job) {
			j.WaitingFor, j.ResumeStage, j.Reason, j.Decisions = job.WaitFailure, job.StageBuild, "blocked", []string{"/decision-1.md"}
		}), Command{Kind: CmdUnblock, File: "/decision-2.md"})
		match(t, j, map[string]any{
			"stage": "build", "cycle": 1, "trip": 1, "waitingFor": nada, "reason": nada, "decisions": []string{"/decision-1.md", "/decision-2.md"},
		})
	})

	t.Run("a trip cap gets one more trip, like retry", func(t *testing.T) {
		j := applyOK(t, inTrip(in(job.StageNeedsHuman), func(j *job.Job) {
			j.WaitingFor, j.ResumeStage, j.CapHit = job.WaitFailure, job.StagePlanning, job.CapTrips
		}), Command{Kind: CmdUnblock, File: "/decision-1.md"})
		match(t, j, map[string]any{"stage": "planning", "trip": 2, "extraTrips": 1, "decisions": []string{"/decision-1.md"}})
	})

	t.Run("only what retry takes can be unblocked", func(t *testing.T) {
		wantCommandError(t, mkJob(in(job.StageBuild)), Command{Kind: CmdUnblock, File: "/d.md"}, "nothing to retry: 261126-x is in build")
	})
}

func TestApplyCommandDiscard(t *testing.T) {
	for _, s := range []job.Stage{"requirements", "build", "needs-human", "human-review", "done"} {
		t.Run(string(s)+" → discarded", func(t *testing.T) {
			j := applyOK(t, mkJob(in(s)), Command{Kind: CmdDiscard})
			match(t, j, map[string]any{"stage": "discarded", "waitingFor": nada, "waitingSince": nada})
		})
	}

	t.Run("a discarded job cannot be discarded again", func(t *testing.T) {
		wantCommandError(t, mkJob(in(job.StageDiscarded)), Command{Kind: CmdDiscard}, "nothing to discard: 261126-x is already discarded")
	})
}

func TestWaits(t *testing.T) {
	for _, c := range []struct {
		stage   job.Stage
		waiting bool
	}{
		{"human-review", true},
		{"needs-human", true},
		{"done", true},
		{"discarded", true},
		{"requirements", true},
		{"tech-discovery", false},
		{"design", false},
		{"discovery-review", false},
		{"planning", false},
		{"build", false},
		{"review", false},
		{"build-judge", false},
		{"test-planning", false},
		{"rebase", false},
		{"qa-wait", false},
		{"validation", false},
		{"validation-judge", false},
		{"finalize", false},
	} {
		t.Run("isWaiting("+string(c.stage)+") is "+map[bool]string{true: "true", false: "false"}[c.waiting], func(t *testing.T) {
			if got := IsWaiting(mkJob(in(c.stage))); got != c.waiting {
				t.Errorf("IsWaiting = %v", got)
			}
		})
	}

	t.Run("waitingSince is kept while the job keeps waiting on the same thing", func(t *testing.T) {
		j := applyOK(t, mkJob(in(job.StageRequirements)), Command{Kind: CmdFeedback, File: "/f.md"})
		match(t, j, map[string]any{"stage": "requirements", "waitingFor": "requirements", "waitingSince": ts(earlier)})
	})

	t.Run("applyCommand never mutates its input", func(t *testing.T) {
		input := inTrip(in(job.StageNeedsHuman), func(j *job.Job) {
			j.WaitingFor, j.CapHit, j.ResumeStage, j.Trip, j.Trips = job.WaitFailure, job.CapTrips, job.StagePlanning, 3, []job.TripRecord{rec(1, 3)}
		})
		before := input.Clone()
		for _, c := range []Command{{Kind: CmdRetry}, {Kind: CmdFeedback, File: "/f.md"}} {
			if got := applyOK(t, input, c); reflect.DeepEqual(got, input) {
				t.Errorf("%s returned the input unchanged", c.Kind)
			}
		}
		if !reflect.DeepEqual(input, before) {
			t.Errorf("input changed:\n got %+v\nwant %+v", input, before)
		}
	})
}
