// Package job holds a job's state (job.json), its files and its lock.
package job

import (
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
)

// Version is the job.json schema version.
const Version = 3

// Stage is where a job is in the flow.
type Stage string

// The stages of a job.
const (
	StageRequirements    Stage = "requirements"
	StagePreflight       Stage = "preflight"
	StageReport          Stage = "report"
	StageTechDiscovery   Stage = "tech-discovery"
	StageDesign          Stage = "design"
	StageDiscoveryReview Stage = "discovery-review"
	StagePlanning        Stage = "planning"
	StageBuild           Stage = "build"
	StageReview          Stage = "review"
	StageBuildJudge      Stage = "build-judge"
	StageTestPlanning    Stage = "test-planning"
	StageRebase          Stage = "rebase"
	StageQAWait          Stage = "qa-wait"
	StageValidation      Stage = "validation"
	StageValidationJudge Stage = "validation-judge"
	StageHumanReview     Stage = "human-review"
	StageFinalize        Stage = "finalize"
	StageDone            Stage = "done"
	StageNeedsHuman      Stage = "needs-human"
	StageDiscarded       Stage = "discarded"
)

// WaitingFor is what a waiting job waits on.
type WaitingFor string

// The things a job waits on. The zero value waits on nothing.
const (
	WaitRequirements WaitingFor = "requirements"
	WaitHumanReview  WaitingFor = "human-review"
	WaitEscalation   WaitingFor = "escalation"
	WaitFailure      WaitingFor = "failure"
)

// CapHit is the cap a paused job ran into.
type CapHit string

// The caps. The zero value is no cap.
const (
	CapTrips     CapHit = "trips"
	CapDiscovery CapHit = "discovery"
	CapEnv       CapHit = "env"
)

// Deliverable is what the job delivers, decided in the grill.
type Deliverable string

// The deliverables. The zero value is not decided yet.
const (
	DeliverPR     Deliverable = "pr"
	DeliverReport Deliverable = "report"
)

// TripRecord is what one trip of one cycle produced.
type TripRecord struct {
	Cycle           int               `json:"cycle"`
	Trip            int               `json:"trip"`
	Reviews         map[string]string `json:"reviews"`
	BuildJudge      string            `json:"buildJudge,omitempty"`
	Validations     map[string]string `json:"validations"`
	ValidationJudge string            `json:"validationJudge,omitempty"`
	// Built lists the task ids whose builder landed READY in this trip, in
	// order. Build resume skips exactly these.
	Built []string `json:"built,omitempty"`
}

// DiscoveryRecord is the verdict of discovery review N.
type DiscoveryRecord struct {
	N       int    `json:"n"`
	Verdict string `json:"verdict"`
}

// Job is job.json.
type Job struct {
	Version int    `json:"version"`
	ID      string `json:"id"`
	Feature string `json:"feature"`
	Branch  string `json:"branch"`
	// Base is the branch the job starts from, opens its PR against and
	// rebases onto. Fixed when the job is created.
	Base string `json:"base"`
	// Harness is fixed at `factory new`; every role of the job runs on it.
	Harness     config.Harness `json:"harness"`
	Deliverable Deliverable    `json:"deliverable,omitempty"`
	// Decisions are the decision-<k>.md files from `factory unblock`; every
	// later agent reads them.
	Decisions           []string   `json:"decisions"`
	Worktree            string     `json:"worktree"`
	Slot                int        `json:"slot"`
	Stage               Stage      `json:"stage"`
	Cycle               int        `json:"cycle"`
	Trip                int        `json:"trip"`
	Planned             bool       `json:"planned"`
	DiscoveryLoops      int        `json:"discoveryLoops"`
	ExtraDiscoveryLoops int        `json:"extraDiscoveryLoops"`
	ExtraTrips          int        `json:"extraTrips"`
	EnvRetries          int        `json:"envRetries"`
	WaitingFor          WaitingFor `json:"waitingFor,omitempty"`
	WaitingSince        *time.Time `json:"waitingSince,omitempty"`
	// Reason may span lines: a summary, a blank line, then the output's tail.
	Reason string `json:"reason,omitempty"`
	// StoppedReason is why a job the human approved anyway had stopped, for
	// the draft PR's Open section.
	StoppedReason string `json:"stoppedReason,omitempty"`
	ResumeStage   Stage  `json:"resumeStage,omitempty"`
	CapHit        CapHit `json:"capHit,omitempty"`
	ReasonFile    string `json:"reasonFile,omitempty"`
	// QuestionsFile may point at <jobDir>/docs/design.md.
	QuestionsFile string            `json:"questionsFile,omitempty"`
	FeedbackCount int               `json:"feedbackCount"`
	Ready         *bool             `json:"ready"`
	PR            string            `json:"pr,omitempty"`
	QAURL         string            `json:"qaUrl,omitempty"`
	Running       []string          `json:"running"`
	Trips         []TripRecord      `json:"trips"`
	Discovery     []DiscoveryRecord `json:"discovery"`
	CreatedAt     time.Time         `json:"createdAt"`
	UpdatedAt     time.Time         `json:"updatedAt"`
}

// NewArgs are the inputs of New.
type NewArgs struct {
	ID, Branch, Base, Feature, Repo string
	Harness                         config.Harness
	Slot                            int
	Now                             time.Time
}

// New is a job at the start of the grill.
func New(a NewArgs) Job {
	now := a.Now
	return Job{
		Version:      Version,
		ID:           a.ID,
		Feature:      a.Feature,
		Branch:       a.Branch,
		Base:         a.Base,
		Harness:      a.Harness,
		Decisions:    []string{},
		Worktree:     NewPaths(a.Repo, a.ID).Worktree,
		Slot:         a.Slot,
		Stage:        StageRequirements,
		Cycle:        1,
		WaitingFor:   WaitRequirements,
		WaitingSince: &now,
		Running:      []string{},
		Trips:        []TripRecord{},
		Discovery:    []DiscoveryRecord{},
		CreatedAt:    now,
		UpdatedAt:    now,
	}
}

// Clone is a deep copy: it shares no slice, map or pointer with j.
func (j Job) Clone() Job {
	c := j
	c.Decisions = slices.Clone(j.Decisions)
	c.Running = slices.Clone(j.Running)
	c.Discovery = slices.Clone(j.Discovery)
	if j.Trips != nil {
		c.Trips = make([]TripRecord, len(j.Trips))
		for i, t := range j.Trips {
			t.Reviews = maps.Clone(t.Reviews)
			t.Validations = maps.Clone(t.Validations)
			t.Built = slices.Clone(t.Built)
			c.Trips[i] = t
		}
	}
	if j.WaitingSince != nil {
		t := *j.WaitingSince
		c.WaitingSince = &t
	}
	if j.Ready != nil {
		r := *j.Ready
		c.Ready = &r
	}
	return c
}

// Load reads a job.json. It fails when the file is not JSON or not a v3 job.
func Load(file string) (Job, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return Job{}, err
	}
	var j Job
	if err := json.Unmarshal(data, &j); err != nil {
		return Job{}, fmt.Errorf("%s: %w", file, err)
	}
	if j.Version != Version {
		return Job{}, fmt.Errorf("%s: not a factory v%d job", file, Version)
	}
	if j.Decisions == nil {
		j.Decisions = []string{}
	}
	if j.Running == nil {
		j.Running = []string{}
	}
	if j.Trips == nil {
		j.Trips = []TripRecord{}
	}
	if j.Discovery == nil {
		j.Discovery = []DiscoveryRecord{}
	}
	return j, nil
}

// Save stamps UpdatedAt and writes j to file through <file>.tmp and a rename.
func Save(file string, j *Job, now time.Time) error {
	j.UpdatedAt = now
	data, err := json.MarshalIndent(j, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o750); err != nil {
		return err
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// List is every readable v3 job of repo, newest first. A job.json that can't
// be read must not hide the other jobs.
func List(repo string) []Job {
	entries, err := os.ReadDir(NewPaths(repo, "").JobsDir)
	if err != nil {
		return nil
	}
	var jobs []Job
	for _, e := range entries {
		if j, err := Load(NewPaths(repo, e.Name()).JobFile); err == nil {
			jobs = append(jobs, j)
		}
	}
	slices.SortStableFunc(jobs, func(a, b Job) int { return b.CreatedAt.Compare(a.CreatedAt) })
	return jobs
}

// AppendActivity adds a timestamped line to the activity log.
func AppendActivity(file, line string, now time.Time) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o750); err != nil {
		return err
	}
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.WriteString(now.Format("15:04:05") + " " + line + "\n")
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	return werr
}

// HeldSlots are the slots of jobs that are still alive (not done or discarded).
func HeldSlots(repo string) map[int]bool {
	used := map[int]bool{}
	for _, j := range List(repo) {
		if j.Stage != StageDone && j.Stage != StageDiscarded {
			used[j.Slot] = true
		}
	}
	return used
}

// NextSlot is the lowest slot from 1 up that no live job holds.
func NextSlot(repo string) int {
	used := HeldSlots(repo)
	slot := 1
	for used[slot] {
		slot++
	}
	return slot
}
