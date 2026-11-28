// Package machine is the job's state machine: pure functions from a job and
// an outcome or a command to the next job. No I/O.
package machine

import (
	"fmt"
	"slices"
	"time"

	"github.com/marco-souza/nixos/stow/factory/internal/job"
)

// OutcomeKind says whether a stage finished or failed.
type OutcomeKind string

// The outcome kinds.
const (
	OutcomeDone   OutcomeKind = "done"
	OutcomeFailed OutcomeKind = "failed"
)

// Outcome is what a stage produced.
type Outcome struct {
	Kind  OutcomeKind
	Stage job.Stage
	// Done only.
	Verdict        string
	ReworkStep     job.Stage // tech-discovery or design; empty means design
	HumanQuestions bool
	ReasonFile     string
	QuestionsFile  string
	// Failed only.
	Reason string
}

// CommandKind is a human command.
type CommandKind string

// The commands.
const (
	CmdApprove  CommandKind = "approve"
	CmdFeedback CommandKind = "feedback"
	CmdRetry    CommandKind = "retry"
	CmdUnblock  CommandKind = "unblock"
	CmdDiscard  CommandKind = "discard"
)

// Command is a human's command. File is the feedback or decision file.
type Command struct {
	Kind CommandKind
	File string
}

// CommandError means the command doesn't apply to the job as it is.
type CommandError struct{ Msg string }

func (e *CommandError) Error() string { return e.Msg }

func cmdErr(format string, a ...any) error { return &CommandError{fmt.Sprintf(format, a...)} }

// Limits are the caps from the config.
type Limits struct{ MaxTrips, MaxDiscoveryLoops int }

// next maps a stage whose done always leads to the same next stage.
var next = map[job.Stage]job.Stage{
	job.StageRequirements:  job.StagePreflight,
	job.StageReport:        job.StageHumanReview,
	job.StageTechDiscovery: job.StageDesign,
	job.StageDesign:        job.StageDiscoveryReview,
	job.StagePlanning:      job.StageBuild,
	job.StageBuild:         job.StageReview,
	job.StageReview:        job.StageBuildJudge,
	job.StageTestPlanning:  job.StageRebase,
	job.StageRebase:        job.StageQAWait,
	job.StageQAWait:        job.StageValidation,
	job.StageValidation:    job.StageValidationJudge,
	job.StageFinalize:      job.StageDone,
}

// waiting are the stages the driver stops at. requirements is one: the grill
// is a conversation `factory answer` drives, not the driver.
var waiting = []job.Stage{job.StageRequirements, job.StageHumanReview, job.StageNeedsHuman, job.StageDone, job.StageDiscarded}

// IsWaiting reports whether the driver stops at j's stage.
func IsWaiting(j job.Job) bool { return slices.Contains(waiting, j.Stage) }

// Route is the job after o, the outcome of j's current stage. It never
// touches in.
func Route(in job.Job, o Outcome, lim Limits, now time.Time) (job.Job, error) {
	if o.Stage != in.Stage {
		return job.Job{}, fmt.Errorf("outcome for %s but %s is in %s", o.Stage, in.ID, in.Stage)
	}
	j := in.Clone()
	if err := route(&j, o, lim); err != nil {
		return job.Job{}, err
	}
	stamp(in, &j, now)
	return j, nil
}

// Apply is the job after a human command. It returns a *CommandError when the
// command doesn't apply, and never touches in.
func Apply(in job.Job, c Command, now time.Time) (job.Job, error) {
	j := in.Clone()
	if err := command(&j, c); err != nil {
		return job.Job{}, err
	}
	stamp(in, &j, now)
	return j, nil
}

func route(j *job.Job, o Outcome, lim Limits) error {
	if o.Kind == OutcomeFailed {
		needsHuman(j, job.WaitFailure, o.Stage)
		j.Reason = o.Reason
		return nil
	}
	switch o.Stage {
	case job.StagePreflight:
		if j.Deliverable == job.DeliverReport {
			goTo(j, job.StageReport)
		} else {
			goTo(j, job.StageTechDiscovery)
		}
		return nil
	case job.StageDesign:
		if o.HumanQuestions {
			j.QuestionsFile = o.QuestionsFile
			discoveryLoop(j, job.StageRequirements, lim)
			return nil
		}
	case job.StageDiscoveryReview:
		discoveryReview(j, o, lim)
		return nil
	case job.StagePlanning:
		goTo(j, job.StageBuild)
		j.Planned = true
		return nil
	case job.StageBuildJudge:
		buildJudge(j, o, lim)
		return nil
	case job.StageValidationJudge:
		validationJudge(j, o, lim)
		return nil
	}
	to, ok := next[o.Stage]
	if !ok {
		return fmt.Errorf("no outcome expected in %s", o.Stage)
	}
	goTo(j, to)
	return nil
}

func discoveryReview(j *job.Job, o Outcome, lim Limits) {
	j.Discovery = append(j.Discovery, job.DiscoveryRecord{N: len(j.Discovery) + 1, Verdict: o.Verdict})
	switch o.Verdict {
	case "PASS":
		goTo(j, job.StagePlanning)
		newTrip(j, j.Cycle, 1)
	case "REWORK":
		to := o.ReworkStep
		if to == "" {
			to = job.StageDesign
		}
		discoveryLoop(j, to, lim)
	case "ASK":
		j.QuestionsFile = o.QuestionsFile
		discoveryLoop(j, job.StageRequirements, lim)
	default:
		unexpected(j, o)
	}
}

func buildJudge(j *job.Job, o Outcome, lim Limits) {
	recordVerdict(j, func(t *job.TripRecord) { t.BuildJudge = o.Verdict })
	switch o.Verdict {
	case "APPROVE":
		goTo(j, job.StageTestPlanning)
	case "CHANGES":
		nextTrip(j, o, lim)
	case "ESCALATE":
		needsHuman(j, job.WaitEscalation, job.StageTestPlanning)
		judgeFiles(j, o)
	default:
		unexpected(j, o)
	}
}

func validationJudge(j *job.Job, o Outcome, lim Limits) {
	recordVerdict(j, func(t *job.TripRecord) { t.ValidationJudge = o.Verdict })
	switch o.Verdict {
	case "PASS":
		goTo(j, job.StageHumanReview)
	case "FAIL":
		nextTrip(j, o, lim)
	case "ENV":
		// One ENV retry per trip: wait for QA again and re-run validation, then pause.
		if j.EnvRetries < 1 {
			goTo(j, job.StageQAWait)
			j.EnvRetries++
			return
		}
		needsHuman(j, job.WaitEscalation, job.StageHumanReview)
		j.CapHit = job.CapEnv
		if o.ReasonFile != "" {
			j.ReasonFile = o.ReasonFile
		}
		j.QuestionsFile = ""
	case "ESCALATE":
		needsHuman(j, job.WaitEscalation, job.StageHumanReview)
		judgeFiles(j, o)
	default:
		unexpected(j, o)
	}
}

// discoveryLoop: ASK, REWORK and designer questions share one cap, raised by
// each discovery retry.
func discoveryLoop(j *job.Job, to job.Stage, lim Limits) {
	j.DiscoveryLoops++
	limit := lim.MaxDiscoveryLoops + j.ExtraDiscoveryLoops
	if j.DiscoveryLoops >= limit {
		needsHuman(j, job.WaitFailure, to)
		j.CapHit = job.CapDiscovery
		j.Reason = fmt.Sprintf("discovery loop cap (%d) reached", limit)
		return
	}
	goTo(j, to)
}

// nextTrip: CHANGES or FAIL go back to planning for another trip, unless the
// trip cap is reached.
func nextTrip(j *job.Job, o Outcome, lim Limits) {
	if o.ReasonFile != "" {
		j.ReasonFile = o.ReasonFile
	}
	limit := lim.MaxTrips + j.ExtraTrips
	if j.Trip >= limit {
		needsHuman(j, job.WaitFailure, job.StagePlanning)
		j.CapHit = job.CapTrips
		j.Reason = fmt.Sprintf("trip cap (%d) reached", limit)
		return
	}
	goTo(j, job.StagePlanning)
	newTrip(j, j.Cycle, j.Trip+1)
}

func unexpected(j *job.Job, o Outcome) {
	verdict := o.Verdict
	if verdict == "" {
		verdict = "none"
	}
	needsHuman(j, job.WaitFailure, o.Stage)
	j.Reason = fmt.Sprintf("%s: unexpected verdict %s", o.Stage, verdict)
}

func command(j *job.Job, c Command) error {
	id, stage, resume, reason := j.ID, j.Stage, j.ResumeStage, j.Reason
	clearCap := func() { j.CapHit, j.Reason, j.ResumeStage = "", "", "" }
	switch c.Kind {
	case CmdApprove:
		if stage == job.StageHumanReview {
			goTo(j, job.StageFinalize)
			clearCap()
			setReady(j, true)
			return nil
		}
		if stage != job.StageNeedsHuman {
			return cmdErr("nothing to approve: %s is in %s", id, stage)
		}
		// Approving an escalation goes on as if the judge had approved.
		if j.WaitingFor == job.WaitEscalation {
			if resume == "" {
				return cmdErr("nothing to resume: %s has no resume stage", id)
			}
			goTo(j, resume)
			clearCap()
			return nil
		}
		goTo(j, job.StageFinalize)
		clearCap()
		setReady(j, false)
		j.StoppedReason = reason
	case CmdFeedback:
		if stage == job.StageDiscarded {
			return cmdErr("cannot send feedback: %s is discarded", id)
		}
		// A new cycle: its caps start over.
		cycle := j.Cycle + 1
		clearCap()
		j.Cycle = cycle
		j.ReasonFile = c.File
		j.QuestionsFile = ""
		j.FeedbackCount++
		j.Ready = nil
		j.StoppedReason = ""
		j.EnvRetries, j.ExtraTrips, j.DiscoveryLoops, j.ExtraDiscoveryLoops = 0, 0, 0, 0
		switch {
		case j.Deliverable == job.DeliverReport:
			goTo(j, job.StageReport)
			j.Trip = 0
		case j.Planned:
			goTo(j, job.StagePlanning)
			newTrip(j, cycle, 1)
		default:
			goTo(j, job.StageRequirements)
			j.Trip = 0
		}
	case CmdRetry:
		if stage != job.StageNeedsHuman || (j.WaitingFor != job.WaitFailure && j.CapHit != job.CapEnv) {
			var waiting string
			if stage == job.StageNeedsHuman {
				waiting = fmt.Sprintf(" waiting for %s", j.WaitingFor)
			}
			return cmdErr("nothing to retry: %s is in %s%s", id, stage, waiting)
		}
		capHit := j.CapHit
		// Retrying clears what an earlier approval of a failure recorded.
		clearCap()
		j.StoppedReason = ""
		switch {
		// QA is back: wait for it and validate again, in the same trip.
		case capHit == job.CapEnv:
			goTo(j, job.StageQAWait)
			j.EnvRetries = 0
		case capHit == job.CapTrips:
			goTo(j, job.StagePlanning)
			j.ExtraTrips++
			newTrip(j, j.Cycle, j.Trip+1)
		case resume == "":
			return cmdErr("nothing to resume: %s has no resume stage", id)
		default:
			goTo(j, resume)
			if capHit == job.CapDiscovery {
				j.ExtraDiscoveryLoops++
			}
		}
	case CmdUnblock:
		// A retry, with the human's decision as an input of every agent from now on.
		if err := command(j, Command{Kind: CmdRetry}); err != nil {
			return err
		}
		j.Decisions = append(j.Decisions, c.File)
	case CmdDiscard:
		if stage == job.StageDiscarded {
			return cmdErr("nothing to discard: %s is already discarded", id)
		}
		goTo(j, job.StageDiscarded)
	}
	return nil
}

func setReady(j *job.Job, v bool) { j.Ready = &v }

// goTo moves to stage, waiting on what that stage waits on.
func goTo(j *job.Job, stage job.Stage) {
	j.Stage = stage
	j.WaitingFor = waitsOn(stage)
}

func waitsOn(stage job.Stage) job.WaitingFor {
	switch stage {
	case job.StageRequirements:
		return job.WaitRequirements
	case job.StageHumanReview:
		return job.WaitHumanReview
	}
	return ""
}

func needsHuman(j *job.Job, waitingFor job.WaitingFor, resume job.Stage) {
	j.Stage = job.StageNeedsHuman
	j.WaitingFor = waitingFor
	j.ResumeStage = resume
	j.CapHit = ""
	j.Reason = ""
}

// newTrip starts trip of cycle; each trip gets one ENV retry.
func newTrip(j *job.Job, cycle, trip int) {
	j.Cycle, j.Trip, j.EnvRetries = cycle, trip, 0
	j.Trips = append(j.Trips, job.TripRecord{Cycle: cycle, Trip: trip, Reviews: map[string]string{}, Validations: map[string]string{}})
}

// recordVerdict applies set to the current trip's record.
func recordVerdict(j *job.Job, set func(*job.TripRecord)) {
	for i := range j.Trips {
		if j.Trips[i].Cycle == j.Cycle && j.Trips[i].Trip == j.Trip {
			set(&j.Trips[i])
		}
	}
}

// judgeFiles: an escalating judge's file holds both its reasons and its questions.
func judgeFiles(j *job.Job, o Outcome) {
	if o.ReasonFile != "" {
		j.ReasonFile = o.ReasonFile
	}
	j.QuestionsFile = o.QuestionsFile
}

// stamp restarts waitingSince when the job starts waiting on something new,
// and clears it when the job waits on nothing.
func stamp(prev job.Job, next *job.Job, now time.Time) {
	switch {
	case next.WaitingFor == "":
		next.WaitingSince = nil
	case next.WaitingFor == prev.WaitingFor && next.Stage == prev.Stage:
		next.WaitingSince = prev.Clone().WaitingSince
	default:
		next.WaitingSince = &now
	}
}
