package driver

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/marco-souza/nixos/stow/factory/internal/handoff"
	"github.com/marco-souza/nixos/stow/factory/internal/harness"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/machine"
	"github.com/marco-souza/nixos/stow/factory/internal/ui"
)

// stage is the effect of a stage. A returned error fails the stage with its
// message as the reason.
type stage func(ctx context.Context, r *run) (machine.Outcome, error)

// stages is the effect of every stage the driver runs; waiting stages have none.
var stages = map[job.Stage]stage{
	job.StageRequirements:    requirements,
	job.StagePreflight:       preflight,
	job.StageReport:          report,
	job.StageTechDiscovery:   techDiscovery,
	job.StageDesign:          design,
	job.StageDiscoveryReview: discoveryReview,
	job.StagePlanning:        planning,
	job.StageBuild:           build,
	job.StageReview:          review,
	job.StageBuildJudge:      buildJudge,
	job.StageTestPlanning:    testPlanning,
	job.StageRebase:          rebase,
	job.StageQAWait:          qaWait,
	job.StageValidation:      validation,
	job.StageValidationJudge: validationJudge,
	job.StageFinalize:        finalize,
}

func done(st job.Stage) machine.Outcome { return machine.Outcome{Kind: machine.OutcomeDone, Stage: st} }

func failed(st job.Stage, reason string) machine.Outcome {
	return machine.Outcome{Kind: machine.OutcomeFailed, Stage: st, Reason: reason}
}

func firstProblem(rs []agentResult) string {
	for _, r := range rs {
		if !r.OK {
			return r.Problem
		}
	}
	return ""
}

func readFile(file string) (string, error) {
	data, err := os.ReadFile(file)
	return string(data), err
}

func (r *run) localURL(i int) string {
	return "http://localhost:" + strconv.Itoa(5100+10*r.snapshot().Slot+i)
}

func (r *run) tripDir() string { return r.paths.TripDir(len(r.snapshot().Trips)) }

// tripFiles are the files of the current trip's folder that match, sorted.
func (r *run) tripFiles(match func(name string) bool) []string {
	dir := r.tripDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var files []string
	for _, e := range entries {
		if match(e.Name()) {
			files = append(files, filepath.Join(dir, e.Name()))
		}
	}
	sort.Strings(files)
	return files
}

// setTrip changes the current trip record.
func (r *run) setTrip(fn func(t *job.TripRecord)) error {
	return r.update(func(j *job.Job) {
		if n := len(j.Trips); n > 0 {
			fn(&j.Trips[n-1])
		}
	})
}

// browserTarget is the local dev server URL of a browser role, "" for any
// other: browser builders and reviewers get their own, as QA lags behind the
// branch until qa-wait.
func (r *run) browserTarget(role string, i int) (string, error) {
	rl, err := harness.LoadRole(r.deps.Roles, role)
	if err != nil {
		return "", err
	}
	if rl.Browser {
		return r.localURL(i), nil
	}
	return "", nil
}

func (r *run) push(ctx context.Context, force bool) error {
	j := r.snapshot()
	return r.deps.Git.Push(ctx, j.Worktree, j.Branch, force)
}

// writeDoc spawns the role that writes a doc and checks its output. The doc
// stays in the job folder: it is never committed.
func (r *run) writeDoc(ctx context.Context, role string, kind handoff.Kind, assignment string, inputs []string) (agentResult, error) {
	rs, err := r.spawn(ctx, []agentSpec{{Role: role, Kind: kind, Output: r.out(kind, ""), Assignment: assignment, Inputs: inputs}})
	if err != nil {
		return agentResult{}, err
	}
	return rs[0], nil
}

// reworkInputs is the review a REWORK step answers: the latest one, when it
// said REWORK.
func (r *run) reworkInputs() []string {
	d := r.snapshot().Discovery
	if n := len(d); n > 0 && d[n-1].Verdict == "REWORK" {
		return []string{r.paths.DiscoveryReview(n)}
	}
	return nil
}

func present(files ...string) []string {
	return slices.DeleteFunc(slices.Clone(files), func(f string) bool { return f == "" })
}

// blockedLine is `blocked: <first line under ### Blocked>`, or the status
// line when there is no such section.
func blockedLine(text string) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	at := -1
	for i, l := range lines {
		if strings.TrimSuffix(strings.TrimSpace(l), ":") == "### Blocked" {
			at = i
		}
	}
	if at >= 0 {
		for _, l := range lines[at+1:] {
			if strings.TrimSpace(l) != "" && !strings.HasPrefix(l, "#") {
				return "blocked: " + strings.TrimSpace(l)
			}
		}
	}
	return "STATUS: BLOCKED"
}

// requirements: the grill wrote and checked the doc; this takes the
// deliverable it settled.
func requirements(_ context.Context, r *run) (machine.Outcome, error) {
	text, err := readFile(r.out(handoff.Requirements, ""))
	if err != nil {
		return machine.Outcome{}, err
	}
	d := handoff.ParseRequirements(text).Deliverable
	if err := r.update(func(j *job.Job) { j.Deliverable = d }); err != nil {
		return machine.Outcome{}, err
	}
	return done(job.StageRequirements), nil
}

// preflight checks every access the requirements list (connectors, logins,
// CLIs, accounts) before any long work. A missing access stops the job here.
func preflight(ctx context.Context, r *run) (machine.Outcome, error) {
	text, err := readFile(r.out(handoff.Requirements, ""))
	if err != nil {
		return machine.Outcome{}, err
	}
	if len(handoff.ParseRequirements(text).Access) == 0 {
		return done(job.StagePreflight), nil
	}
	rs, err := r.spawn(ctx, []agentSpec{{
		Role: "access-checker", Kind: handoff.Access, Output: r.out(handoff.Access, ""), NoResume: true,
		Assignment: `Check every item under "## Access" in the requirements doc.`,
	}})
	if err != nil {
		return machine.Outcome{}, err
	}
	res := rs[0]
	if !res.OK {
		return failed(job.StagePreflight, res.Problem), nil
	}
	if res.Verdict == "BLOCKED" {
		return failed(job.StagePreflight, "access-checker: "+blockedLine(res.Text)), nil
	}
	return done(job.StagePreflight), nil
}

// report is a report job's one work step: no code, no branch pushed, no PR.
// Feedback comes back here.
func report(ctx context.Context, r *run) (machine.Outcome, error) {
	inputs := present(r.snapshot().ReasonFile)
	assignment := "Do what the requirements doc asks for and write the report."
	if len(inputs) > 0 {
		assignment = "Revise the report for the feedback in Inputs."
	}
	rs, err := r.spawn(ctx, []agentSpec{{Role: "reporter", Kind: handoff.Report, Output: r.out(handoff.Report, ""), Assignment: assignment, Inputs: inputs}})
	if err != nil {
		return machine.Outcome{}, err
	}
	res := rs[0]
	if !res.OK {
		return failed(job.StageReport, res.Problem), nil
	}
	if res.Verdict == "BLOCKED" {
		return failed(job.StageReport, "reporter: "+blockedLine(res.Text)), nil
	}
	return done(job.StageReport), nil
}

func techDiscovery(ctx context.Context, r *run) (machine.Outcome, error) {
	inputs := r.reworkInputs()
	assignment := "Explore the codebase for the request and write the tech discovery doc."
	if len(inputs) > 0 {
		assignment = "Rework the tech discovery doc as the discovery review in Inputs asks."
	}
	res, err := r.writeDoc(ctx, "tech-discoverer", handoff.TechDiscovery, assignment, inputs)
	if err != nil {
		return machine.Outcome{}, err
	}
	if !res.OK {
		return failed(job.StageTechDiscovery, res.Problem), nil
	}
	return done(job.StageTechDiscovery), nil
}

func design(ctx context.Context, r *run) (machine.Outcome, error) {
	inputs := r.reworkInputs()
	assignment := "Write the design doc for the request."
	if len(inputs) > 0 {
		assignment = "Rework the design doc as the discovery review in Inputs asks."
	}
	res, err := r.writeDoc(ctx, "designer", handoff.Design, assignment, inputs)
	if err != nil {
		return machine.Outcome{}, err
	}
	if !res.OK {
		return failed(job.StageDesign, res.Problem), nil
	}
	o := done(job.StageDesign)
	if handoff.HasHumanQuestions(res.Text) {
		o.HumanQuestions = true
		o.QuestionsFile = r.out(handoff.Design, "")
	}
	return o, nil
}

func discoveryReview(ctx context.Context, r *run) (machine.Outcome, error) {
	output := r.out(handoff.DiscoveryReview, "")
	n := len(r.snapshot().Discovery) + 1
	rs, err := r.spawn(ctx, []agentSpec{{
		Role: "discovery-reviewer", Kind: handoff.DiscoveryReview, Output: output,
		Assignment: fmt.Sprintf("Review the discovery docs against the request and the repo (review %d).", n),
	}})
	if err != nil {
		return machine.Outcome{}, err
	}
	res := rs[0]
	if !res.OK {
		return failed(job.StageDiscoveryReview, res.Problem), nil
	}
	v, err := handoff.ParseDiscoveryReview(res.Text)
	if err != nil {
		return machine.Outcome{}, err
	}
	o := done(job.StageDiscoveryReview)
	o.Verdict = v.Verdict
	o.ReworkStep = job.Stage(v.Step)
	if v.Verdict == "ASK" {
		o.QuestionsFile = output
	}
	return o, nil
}

func planning(ctx context.Context, r *run) (machine.Outcome, error) {
	inputs := present(r.snapshot().ReasonFile)
	assignment := "Write the spec: numbered acceptance criteria, tasks with a specialist each, the review lenses and the run order."
	if len(inputs) > 0 {
		assignment = "Revise the spec for the Inputs. When they change what the human wants, also amend the requirements and design docs and name the Inputs file there."
	}
	res, err := r.writeDoc(ctx, "planner", handoff.Spec, assignment, inputs)
	if err != nil {
		return machine.Outcome{}, err
	}
	if !res.OK {
		return failed(job.StagePlanning, res.Problem), nil
	}
	return done(job.StagePlanning), nil
}

// build runs the plan's tasks one builder at a time, pushing after each, and
// opens the draft PR at the first push that puts the branch ahead of its base.
func build(ctx context.Context, r *run) (machine.Outcome, error) {
	specText, err := readFile(r.out(handoff.Spec, ""))
	if err != nil {
		return machine.Outcome{}, err
	}
	plan := handoff.ParsePlan(specText)
	output := r.out(handoff.Build, "")
	for _, t := range plan.Tasks {
		if !slices.Contains(handoff.Specialists, t.Specialist) {
			r.note(fmt.Sprintf("%s: unknown specialist %q → %s", t.ID, t.Specialist, handoff.BuilderFor(t.Specialist)))
		}
	}
	pushed := true
	for _, id := range plan.Run {
		if trips := r.snapshot().Trips; len(trips) > 0 && slices.Contains(trips[len(trips)-1].Built, id) {
			r.note("skip " + id + ": already built")
			pushed = false
			continue
		}
		specialist := "general"
		for _, t := range plan.Tasks {
			if t.ID == id {
				specialist = t.Specialist
			}
		}
		role := handoff.BuilderFor(specialist)
		target, err := r.browserTarget(role, 0)
		if err != nil {
			return machine.Outcome{}, err
		}
		section := regexp.MustCompile(`(?m)^## ` + regexp.QuoteMeta(id) + `\b`)
		check := func(text string) handoff.Check {
			c := handoff.CheckOutput(handoff.Build, text, r.cfg)
			if !c.OK || section.MatchString(text) {
				return c
			}
			return handoff.Check{Problem: fmt.Sprintf("no %q section", "## "+id)}
		}
		rs, err := r.spawn(ctx, []agentSpec{{
			Role: role, Kind: handoff.Build, Output: output, Assignment: "Task " + id,
			Target: target, Check: check, NoResume: true,
		}})
		if err != nil {
			return machine.Outcome{}, err
		}
		res := rs[0]
		if !res.OK {
			return failed(job.StageBuild, res.Problem), nil
		}
		if res.Verdict == "BLOCKED" {
			return failed(job.StageBuild, fmt.Sprintf("%s: %s %s", role, id, blockedLine(res.Text))), nil
		}
		// Recorded before the push, so a failed push retries the push, not the builder.
		if err := r.setTrip(func(t *job.TripRecord) { t.Built = append(t.Built, id) }); err != nil {
			return machine.Outcome{}, err
		}
		if err := r.push(ctx, false); err != nil {
			return machine.Outcome{}, err
		}
		if err := r.ensurePR(ctx); err != nil {
			return machine.Outcome{}, err
		}
		pushed = true
	}
	if !pushed {
		if err := r.push(ctx, false); err != nil {
			return machine.Outcome{}, err
		}
		if err := r.ensurePR(ctx); err != nil {
			return machine.Outcome{}, err
		}
	}
	if j := r.snapshot(); j.PR == "" {
		return failed(job.StageBuild, fmt.Sprintf("build made no commits ahead of %s: nothing to open a PR for", j.Base)), nil
	}
	return done(job.StageBuild), nil
}

func review(ctx context.Context, r *run) (machine.Outcome, error) {
	specText, err := readFile(r.out(handoff.Spec, ""))
	if err != nil {
		return machine.Outcome{}, err
	}
	lenses := handoff.ParsePlan(specText).Lenses
	if err := r.setTrip(func(t *job.TripRecord) {
		t.Reviews = pending(lenses, t.Reviews)
	}); err != nil {
		return machine.Outcome{}, err
	}
	specs := make([]agentSpec, len(lenses))
	for i, lens := range lenses {
		role := "reviewer-" + lens
		target, err := r.browserTarget(role, i)
		if err != nil {
			return machine.Outcome{}, err
		}
		specs[i] = agentSpec{
			Role: role, Kind: handoff.Review, Output: r.out(handoff.Review, lens),
			Assignment: "Review the branch through the " + lens + " lens.", Target: target,
			OnResult: func(res agentResult) error {
				if !res.OK {
					return nil
				}
				return r.setTrip(func(t *job.TripRecord) { t.Reviews[lens] = res.Verdict })
			},
		}
	}
	rs, err := r.spawn(ctx, specs)
	if err != nil {
		return machine.Outcome{}, err
	}
	if p := firstProblem(rs); p != "" {
		return failed(job.StageReview, p), nil
	}
	return done(job.StageReview), nil
}

// pending is a verdict record with one entry per name: the old verdict, or
// "pending".
func pending(names []string, old map[string]string) map[string]string {
	m := make(map[string]string, len(names))
	for _, n := range names {
		m[n] = "pending"
		if v, ok := old[n]; ok {
			m[n] = v
		}
	}
	return m
}

// judge runs a judge, whose verdict file holds the reasons and questions the
// machine needs.
func judge(ctx context.Context, r *run, st job.Stage, kind handoff.Kind, assignment string, inputs []string) (machine.Outcome, error) {
	output := r.out(kind, "")
	rs, err := r.spawn(ctx, []agentSpec{{Role: string(st), Kind: kind, Output: output, Assignment: assignment, Inputs: inputs}})
	if err != nil {
		return machine.Outcome{}, err
	}
	res := rs[0]
	if !res.OK {
		return failed(st, res.Problem), nil
	}
	o := done(st)
	o.Verdict = res.Verdict
	o.ReasonFile = output
	o.QuestionsFile = output
	return o, nil
}

var reviewFile = regexp.MustCompile(`^review-[^.]+\.md$`)

// validationFile matches a validator's file, not the judge's.
func validationFile(name string) bool {
	return validationNow.MatchString(name) && name != "validation-judge.md"
}

func buildJudge(ctx context.Context, r *run) (machine.Outcome, error) {
	return judge(ctx, r, job.StageBuildJudge, handoff.BuildJudge,
		fmt.Sprintf("Judge trip %d: weigh the reviews against the spec.", r.snapshot().Trip), r.tripFiles(reviewFile.MatchString))
}

func testPlanning(ctx context.Context, r *run) (machine.Outcome, error) {
	assignment := "Write the test plan: the cases and the validators to run. Enabled validators: " + strings.Join(r.cfg.Validators, ", ")
	res, err := r.writeDoc(ctx, "test-planner", handoff.TestPlan, assignment, nil)
	if err != nil {
		return machine.Outcome{}, err
	}
	if !res.OK {
		return failed(job.StageTestPlanning, res.Problem), nil
	}
	return done(job.StageTestPlanning), nil
}

func rebase(ctx context.Context, r *run) (machine.Outcome, error) {
	j := r.snapshot()
	conflict, err := r.deps.Git.Rebase(ctx, j.Worktree, j.Base)
	if err != nil {
		return machine.Outcome{}, err
	}
	if conflict {
		r.note("rebase onto origin/" + j.Base + " conflicts; starting the resolver")
		// An earlier rebase.md can't count: the branch still conflicts.
		rs, err := r.spawn(ctx, []agentSpec{{
			Role: "resolver", Kind: handoff.Rebase, Output: r.out(handoff.Rebase, ""), NoResume: true,
			Assignment: fmt.Sprintf("Rebase %s onto origin/%s and resolve the conflicts without changing behaviour.", j.Branch, j.Base),
		}})
		if err != nil {
			return machine.Outcome{}, err
		}
		res := rs[0]
		if !res.OK {
			return failed(job.StageRebase, res.Problem), nil
		}
		if res.Verdict == "BLOCKED" {
			return failed(job.StageRebase, "resolver: "+blockedLine(res.Text)), nil
		}
	}
	if err := r.push(ctx, true); err != nil {
		return machine.Outcome{}, err
	}
	return done(job.StageRebase), nil
}

var (
	validationNow = regexp.MustCompile(`^validation-[^.]+\.md$`)
	envFile       = regexp.MustCompile(`\.env(\d+)\.md$`)
)

// moveValidationAside handles an ENV retry, which validates again in the same
// trip: it keeps the old files under `.env<k>.md` so resume does not reuse
// them.
func (r *run) moveValidationAside() error {
	dir := r.tripDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var current []string
	taken := map[string]bool{}
	for _, e := range entries {
		switch name := e.Name(); {
		case validationNow.MatchString(name):
			current = append(current, name)
		case envFile.MatchString(name):
			taken[name[strings.LastIndex(name, ".env"):]] = true
		}
	}
	if len(current) == 0 {
		return nil
	}
	k := 1
	for taken[".env"+strconv.Itoa(k)+".md"] {
		k++
	}
	for _, f := range current {
		to := strings.TrimSuffix(f, ".md") + ".env" + strconv.Itoa(k) + ".md"
		if err := os.Rename(filepath.Join(dir, f), filepath.Join(dir, to)); err != nil {
			return err
		}
	}
	if err := r.setTrip(func(t *job.TripRecord) { t.Validations = map[string]string{} }); err != nil {
		return err
	}
	r.note(fmt.Sprintf("moved this trip's validation files aside (.env%d.md) to validate again", k))
	return nil
}

func qaWait(ctx context.Context, r *run) (machine.Outcome, error) {
	if err := r.moveValidationAside(); err != nil {
		return machine.Outcome{}, err
	}
	// The QA env may be assigned some time after the PR opened.
	if err := r.qaURL(ctx); err != nil {
		return machine.Outcome{}, err
	}
	ready, err := r.waitQAReady(ctx)
	if err != nil {
		return machine.Outcome{}, err
	}
	if !ready {
		return failed(job.StageQAWait, fmt.Sprintf("QA env not ready after %d min", r.cfg.QAReadyTimeoutMin)), nil
	}
	return done(job.StageQAWait), nil
}

func validation(ctx context.Context, r *run) (machine.Outcome, error) {
	planText, err := readFile(r.out(handoff.TestPlan, ""))
	if err != nil {
		return machine.Outcome{}, err
	}
	kinds := handoff.ParseTestPlan(planText)
	if err := r.setTrip(func(t *job.TripRecord) { t.Validations = pending(kinds, t.Validations) }); err != nil {
		return machine.Outcome{}, err
	}
	qa := r.snapshot().QAURL
	specs := make([]agentSpec, len(kinds))
	for i, kind := range kinds {
		target := qa
		if target == "" {
			target = r.localURL(i)
		}
		specs[i] = agentSpec{
			Role: "validator-" + kind, Kind: handoff.Validation, Output: r.out(handoff.Validation, kind),
			Assignment: "Validate the branch against the test plan with the " + kind + " validator.", Target: target,
			OnResult: func(res agentResult) error {
				if !res.OK {
					return nil
				}
				return r.setTrip(func(t *job.TripRecord) { t.Validations[kind] = res.Verdict })
			},
		}
	}
	rs, err := r.spawn(ctx, specs)
	if err != nil {
		return machine.Outcome{}, err
	}
	if p := firstProblem(rs); p != "" {
		return failed(job.StageValidation, p), nil
	}
	return done(job.StageValidation), nil
}

func validationJudge(ctx context.Context, r *run) (machine.Outcome, error) {
	return judge(ctx, r, job.StageValidationJudge, handoff.ValidationJudge,
		fmt.Sprintf("Judge trip %d's validation.", r.snapshot().Trip), r.tripFiles(validationFile))
}

// finalize pushes the proof, has the summarizer write the PR and, when the
// job is clean, marks it ready for review.
func finalize(ctx context.Context, r *run) (machine.Outcome, error) {
	j := r.snapshot()
	if j.Deliverable == job.DeliverReport {
		return done(job.StageFinalize), nil
	}
	if j.PR == "" {
		return failed(job.StageFinalize, "no pull request to finalize"), nil
	}
	sha, err := pushProof(ctx, r.deps.Exec, r.repo, r.paths.ProofDir, j.ID, filepath.Join(r.paths.RunDir, "proof.index"))
	if err != nil {
		return machine.Outcome{}, err
	}
	var proof []string
	if sha != "" {
		entries, err := os.ReadDir(r.paths.ProofDir)
		if err != nil {
			return machine.Outcome{}, err
		}
		for _, e := range entries {
			proof = append(proof, e.Name())
		}
		sort.Strings(proof)
	}
	var inputs []string
	for _, f := range []string{"build.md", "validation-judge.md"} {
		if p := filepath.Join(r.tripDir(), f); fileExists(p) {
			inputs = append(inputs, p)
		}
	}
	title := "the title in the repo's convention"
	if r.cfg.PRTitle != "" {
		title = fmt.Sprintf("a short summary only: the factory formats the title as %q", r.cfg.PRTitle)
	}
	rs, err := r.spawn(ctx, []agentSpec{{
		Role: "summarizer", Kind: handoff.PR, Output: r.out(handoff.PR, ""), Inputs: inputs,
		Assignment: fmt.Sprintf(`Write the pull request: the first line is "# " and %s; then the body.`, title),
	}})
	if err != nil {
		return machine.Outcome{}, err
	}
	res := rs[0]
	if !res.OK {
		return failed(job.StageFinalize, res.Problem), nil
	}
	first, rest, _ := strings.Cut(res.Text, "\n")
	summary := strings.TrimSpace(strings.TrimPrefix(first, "#"))
	var criteria []int
	if text, err := readFile(r.out(handoff.Spec, "")); err == nil {
		criteria = handoff.ParsePlan(text).Criteria
	}
	gaps := ui.ProofCoverage(criteria, proof)
	j = r.snapshot()
	ready := j.Ready != nil && *j.Ready && len(gaps) == 0
	var parts []string
	if !ready {
		parts = append(parts, openSection(j, gaps))
	}
	parts = append(parts, strings.TrimSpace(rest))
	if sha != "" {
		nwo, err := r.deps.GH.NameWithOwner(ctx)
		if err != nil {
			return machine.Outcome{}, err
		}
		parts = append(parts, proofSection(nwo, sha, proof))
	}
	parts = slices.DeleteFunc(parts, func(s string) bool { return s == "" })
	bodyFile := filepath.Join(r.paths.JobDir, "pr-body.md")
	if err := os.WriteFile(bodyFile, []byte(strings.Join(parts, "\n\n")+"\n"), 0o600); err != nil {
		return machine.Outcome{}, err
	}
	if err := r.deps.GH.EditTitle(ctx, j.PR, r.prTitle(j, summary)); err != nil {
		return machine.Outcome{}, err
	}
	if err := r.deps.GH.EditBody(ctx, j.PR, bodyFile); err != nil {
		return machine.Outcome{}, err
	}
	if ready {
		if err := r.deps.GH.Ready(ctx, j.PR); err != nil {
			return machine.Outcome{}, err
		}
		r.note("PR ready for review: " + j.PR)
	} else {
		r.note("PR stays a draft: " + j.PR)
	}
	return done(job.StageFinalize), nil
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
