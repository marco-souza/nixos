package driver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/marco-souza/nixos/stow/factory/internal/deps"
	"github.com/marco-souza/nixos/stow/factory/internal/handoff"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/machine"
)

// GrillResult is what one turn of the grill ended with: a question for the
// human, or (Done) the requirements doc and the job after preflight.
type GrillResult struct {
	Question string
	Done     bool
	Job      job.Job
}

// GrillTurn runs one turn of the requirements grill to completion; give it
// inline deps. The grill agent is headless and stateless: it reads the
// transcript, then writes either the next question or, once the human has
// confirmed, the doc. answer is the human's reply to the pending question;
// nil opens the grill, or shows the pending question again. When the doc
// lands, the stage finishes and preflight runs here too; the caller starts
// the driver unless the job then waits on the human.
func GrillTurn(ctx context.Context, repo, id string, d deps.Deps, answer *string) (GrillResult, error) {
	r, err := newRun(repo, id, d)
	if err != nil {
		return GrillResult{}, &machine.CommandError{Msg: fmt.Sprintf("no job %s (see: factory status)", id)}
	}
	release, err := job.Acquire(r.paths.JobDir, os.Getpid())
	if err != nil {
		return GrillResult{}, err
	}
	defer release()
	if st := r.snapshot().Stage; st != job.StageRequirements {
		return GrillResult{}, &machine.CommandError{Msg: fmt.Sprintf("%s is not in the grill: it is in %s", id, st)}
	}
	if err := r.enterVisit(); err != nil {
		return GrillResult{}, err
	}
	// A new visit (feedback, design questions) is a new conversation.
	if err := r.freshGrill(); err != nil {
		return GrillResult{}, err
	}
	questionFile := filepath.Join(r.paths.GrillDir, "question.md")
	transcript := filepath.Join(r.paths.GrillDir, "transcript.md")
	if answer != nil {
		q, err := os.ReadFile(questionFile)
		if err != nil {
			return GrillResult{}, &machine.CommandError{Msg: fmt.Sprintf("no question is pending for %s; run: factory answer %s", id, id)}
		}
		entry := "## Question\n\n" + strings.TrimSpace(string(q)) + "\n\n## Answer\n\n" + strings.TrimSpace(*answer) + "\n\n"
		if err := appendFile(transcript, entry); err != nil {
			return GrillResult{}, err
		}
		if err := os.Remove(questionFile); err != nil {
			return GrillResult{}, err
		}
	} else if q, ok := readTrimmed(questionFile); ok {
		return GrillResult{Question: q}, nil
	}

	j := r.snapshot()
	var inputs []string
	for _, f := range []string{j.QuestionsFile, j.ReasonFile, transcript} {
		if f == "" {
			continue
		}
		if _, err := os.Stat(f); err == nil {
			inputs = append(inputs, f)
		}
	}
	spec := agentSpec{
		Role:       "requirements",
		Kind:       handoff.Requirements,
		Output:     r.out(handoff.Requirements, ""),
		Assignment: "One turn of the grill. Question file: " + questionFile,
		Inputs:     inputs,
	}
	a, err := r.startAgent(ctx, spec)
	if err != nil {
		return GrillResult{}, err
	}
	res, err := r.finishAgent(ctx, a)
	if err != nil {
		return GrillResult{}, err
	}
	if res.OK {
		if err := os.Remove(questionFile); err != nil && !errors.Is(err, os.ErrNotExist) {
			return GrillResult{}, err
		}
		// Preflight too, so a missing login or connector shows up in this turn's output, not an hour later.
		for {
			st := r.snapshot().Stage
			if st != job.StageRequirements && st != job.StagePreflight {
				break
			}
			if err := r.step(ctx); err != nil {
				return GrillResult{}, err
			}
		}
		return GrillResult{Done: true, Job: r.snapshot()}, nil
	}
	if q, ok := readTrimmed(questionFile); ok {
		return GrillResult{Question: q}, nil
	}
	return GrillResult{}, fmt.Errorf("the grill agent wrote no question and no doc (%s); see: factory logs %s requirements", res.Problem, id)
}

// freshGrill empties the grill folder when the job is in a new visit.
func (r *run) freshGrill() error {
	marker := filepath.Join(r.paths.GrillDir, "visit")
	key := visitKey(r.snapshot())
	if data, err := os.ReadFile(marker); err == nil && string(data) == key {
		return nil
	}
	if err := os.RemoveAll(r.paths.GrillDir); err != nil {
		return err
	}
	if err := os.MkdirAll(r.paths.GrillDir, 0o750); err != nil {
		return err
	}
	return os.WriteFile(marker, []byte(key), 0o600)
}

func appendFile(file, text string) error {
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.WriteString(text)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	return werr
}

// readTrimmed is the trimmed text of file; ok is false when it does not exist.
func readTrimmed(file string) (string, bool) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(data)), true
}
