// Command fake-agent stands in for a headless (or grill) agent in the
// end-to-end tests:
//
//	fake-agent <role> <taskFile> <scenarioFile>
//
// It reads the task prompt the driver wrote and writes a canned valid output
// for the role at its `Output:` path. Builders also commit a file in the
// worktree; validators write proof files in the job folder. The scenario is
// described in testkit.Scenario.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/marco-souza/nixos/stow/factory/internal/testkit"
)

// agent is one run: the parsed task prompt and the scenario.
type agent struct {
	role, taskFile, scenarioFile string
	task                         string
	sc                           testkit.Scenario
}

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: fake-agent <role> <taskFile> <scenarioFile>")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Args[3]); err != nil {
		fmt.Fprintln(os.Stderr, "fake-agent:", err)
		os.Exit(1)
	}
}

func run(role, taskFile, scenarioFile string) error {
	task, err := os.ReadFile(taskFile) //nolint:gosec // the path is the driver's argument
	if err != nil {
		return err
	}
	sc, err := testkit.ReadScenario(scenarioFile)
	if err != nil {
		return err
	}
	a := &agent{role: role, taskFile: taskFile, scenarioFile: scenarioFile, task: string(task), sc: sc}
	output, err := a.field("Output")
	if err != nil {
		return err
	}
	if ms := a.sc.Setting("sleepMs"); ms != "" {
		var n int
		_, _ = fmt.Sscan(ms, &n)
		// One tool call, then the wait: the log has it while the agent still runs.
		line, _ := json.Marshal(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{
			map[string]any{"type": "tool_use", "id": "t1", "name": "Read", "input": map[string]any{"file_path": "AGENTS.md"}},
		}}})
		fmt.Println(string(line))
		time.Sleep(time.Duration(n) * time.Millisecond)
	}
	if err := os.MkdirAll(filepath.Dir(output), 0o750); err != nil {
		return err
	}
	if role == "requirements" {
		question, err := a.grillQuestion()
		if err != nil {
			return err
		}
		if question != "" {
			if err := os.MkdirAll(filepath.Dir(question), 0o750); err != nil {
				return err
			}
			text := "Who is it for?\nWhy: sets the access rules.\nOptions:\n1. Admins (recommended)\n2. Everyone\n"
			if err := os.WriteFile(question, []byte(text), 0o600); err != nil {
				return err
			}
			fmt.Printf("fake %s: asked %s\n", role, question)
			return nil
		}
	}
	text, err := a.content(output)
	if err != nil {
		return err
	}
	if err := os.WriteFile(output, []byte(text), 0o600); err != nil {
		return err
	}
	fmt.Printf("fake %s: wrote %s\n", role, output)
	return nil
}

// field is the value of a `Name: value` line of the task.
func (a *agent) field(name string) (string, error) {
	m := regexp.MustCompile(`(?m)^` + name + `: (.+)$`).FindStringSubmatch(a.task)
	if m == nil {
		return "", fmt.Errorf("%s: no %q line", a.taskFile, name+":")
	}
	return strings.TrimSpace(m[1]), nil
}

func (a *agent) verdict(fallback string) (string, error) {
	return a.sc.Verdict(a.scenarioFile, a.role, fallback)
}

func (a *agent) content(output string) (string, error) {
	role := a.role
	switch {
	case role == "requirements":
		return a.requirements()
	case role == "access-checker":
		return a.access()
	case role == "reporter":
		return a.report()
	case role == "tech-discoverer":
		return "# Tech discovery\n\n## Findings\n- One router.\n\n## Risks\n- None.\n", nil
	case role == "designer":
		return "# Design\n\n## Approach\nA middleware.\n\n## Alternatives\nA proxy.\n\n## Questions for the human\nNone\n", nil
	case role == "discovery-reviewer":
		return a.judged("PASS", "The docs match the request.")
	case role == "planner":
		return a.spec()
	case strings.HasPrefix(role, "builder-"):
		return a.build(output)
	case strings.HasPrefix(role, "reviewer-"):
		return a.judged("PASS", "Looks right.")
	case role == "build-judge":
		return a.judged("APPROVE", "Weighed the reviews.")
	case role == "test-planner":
		return "# Test plan\n\n## Cases\n1. Send 101 requests; the last gets a 429.\n\nValidators: e2e\n", nil
	case strings.HasPrefix(role, "validator-"):
		return a.validate(strings.TrimPrefix(role, "validator-"))
	case role == "validation-judge":
		return a.judged("PASS", "Weighed the validators.")
	case role == "resolver":
		return "STATUS: READY\n\nNo conflicts left.\n", nil
	case role == "summarizer":
		return "# Add rate limiting\n\nLimits requests per client.\n", nil
	}
	return "", fmt.Errorf("unknown role %s", role)
}

func (a *agent) requirements() (string, error) {
	job, _ := a.field("Job")
	request, _ := a.field("Request")
	access := "None."
	if items := a.sc["access"]; len(items) > 0 {
		lines := make([]string, len(items))
		for i, it := range items {
			lines[i] = "- " + it
		}
		access = strings.Join(lines, "\n")
	}
	deliverable := "pr"
	if d := a.sc.Setting("deliverable"); d != "" {
		deliverable = d
	}
	return fmt.Sprintf("# Requirements for %s\n\n> Request: %s\n\nDeliverable: %s\n\n## Intent\n%s\n\n## Requirements\n1. Limit requests.\n\n## Decisions\n- None.\n\n## Access\n%s\n",
		job, request, deliverable, request, access), nil
}

func (a *agent) access() (string, error) {
	word, err := a.verdict("READY")
	if err != nil {
		return "", err
	}
	items := a.sc["access"]
	blocked := ""
	if word == "BLOCKED" && len(items) > 0 {
		blocked = "### Blocked\n" + items[0] + ": not logged in. Fix: run gh auth login\n\n"
	}
	checks := make([]string, len(items))
	for i, it := range items {
		checks[i] = "- " + it + ": gh auth status"
	}
	return "STATUS: " + word + "\n\n" + blocked + "## Checks\n" + strings.Join(checks, "\n") + "\n", nil
}

func (a *agent) report() (string, error) {
	word, err := a.verdict("READY")
	if err != nil {
		return "", err
	}
	blocked := ""
	if word == "BLOCKED" {
		blocked = "\n### Blocked\nThe sheet is not shared with you.\n"
	}
	return "STATUS: " + word + "\n\n# Rate limit audit\n" + blocked +
		"\n## Summary\nNo limits today.\n\n## Findings\n- None.\n\n## Deliverables\nNone.\n\n## Open\nNone.\n", nil
}

// judged is a verdict line, with the questions an ASK or ESCALATE needs.
func (a *agent) judged(fallback, why string) (string, error) {
	word, err := a.verdict(fallback)
	if err != nil {
		return "", err
	}
	questions := ""
	if word == "ASK" || word == "ESCALATE" {
		questions = "\n## Questions\n- Should it be done this way?\n"
	}
	return "VERDICT: " + word + "\n\n" + why + "\n" + questions, nil
}

func (a *agent) spec() (string, error) {
	job, _ := a.field("Job")
	return "# Spec for " + job + "\n\n## Acceptance criteria\n1. Requests over the limit get a 429.\n2. The limit is configurable.\n\n" +
		"## Tasks\n### T1 Limiter middleware\nSpecialist: backend\n\n### T2 Settings page\nSpecialist: frontend\n\nLenses: product, code, security\n\n## Run\nT1, T2\n", nil
}

var taskID = regexp.MustCompile(`^Task (T\d+)$`)

func (a *agent) build(output string) (string, error) {
	assignment, _ := a.field("Assignment")
	m := taskID.FindStringSubmatch(assignment)
	if m == nil {
		return "", fmt.Errorf("builder: unexpected assignment %q", assignment)
	}
	id := m[1]
	file := filepath.Join("src", strings.ToLower(id)+".txt")
	if a.sc.Setting("noCommit") == "" {
		if err := a.commit(id, file); err != nil {
			return "", err
		}
	}
	rest := "# Build"
	if data, err := os.ReadFile(output); err == nil {
		_, after, _ := strings.Cut(string(data), "\n")
		rest = strings.TrimRight(after, " \t\r\n")
	}
	return fmt.Sprintf("STATUS: READY\n%s\n\n## %s\nBuilt %s.\n", rest, id, file), nil
}

// commit writes the task's file in the worktree and commits it.
func (a *agent) commit(id, file string) error {
	worktree, _ := a.field("Worktree")
	worktree = strings.TrimSuffix(worktree, " (your working directory)")
	job, _ := a.field("Job")
	cycle := regexp.MustCompile(`(?m)^Cycle: (\d+)`).FindStringSubmatch(a.task)
	trip := regexp.MustCompile(`\bTrip: (\d+)`).FindStringSubmatch(a.task)
	if cycle == nil || trip == nil {
		return fmt.Errorf("%s: no Cycle or Trip", a.taskFile)
	}
	path := filepath.Join(worktree, file)
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	old, _ := os.ReadFile(path)
	line := fmt.Sprintf("%s cycle %s trip %s\n", id, cycle[1], trip[1])
	if err := os.WriteFile(path, append(old, line...), 0o600); err != nil { //nolint:gosec // a path in the job's worktree
		return err
	}
	msg := fmt.Sprintf("feat: %s for %s (cycle %s trip %s)", strings.ToLower(id), job, cycle[1], trip[1])
	for _, args := range [][]string{{"add", "--", file}, {"commit", "-q", "-m", msg}} {
		cmd := exec.Command("git", append([]string{"-C", worktree}, args...)...) //nolint:noctx // a short-lived test helper
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("git %s: %w\n%s", strings.Join(args, " "), err, out)
		}
	}
	return nil
}

var (
	criterion = regexp.MustCompile(`(?m)^(\d+)\. (.+)$`)
	notSlug   = regexp.MustCompile(`[^a-z0-9]+`)
)

func (a *agent) validate(kind string) (string, error) {
	jobDir, _ := a.field("Job folder")
	docs, _ := a.field("Docs")
	m := regexp.MustCompile(`\bspec=([^,\s]+)`).FindStringSubmatch(docs)
	if m == nil {
		return "", fmt.Errorf("no spec= in Docs: %s", docs)
	}
	spec, err := os.ReadFile(m[1])
	if err != nil {
		return "", err
	}
	proof := filepath.Join(jobDir, "proof")
	if err := os.MkdirAll(proof, 0o750); err != nil {
		return "", err
	}
	for _, c := range criterion.FindAllStringSubmatch(string(spec), -1) {
		slug := strings.Trim(notSlug.ReplaceAllString(strings.ToLower(c[2]), "-"), "-")
		name := fmt.Sprintf("ac%s-%s-%s.txt", c[1], kind, slug)
		if err := os.WriteFile(filepath.Join(proof, name), []byte("$ check\n"+c[2]+": ok\n"), 0o600); err != nil { //nolint:gosec // proof goes in the job folder
			return "", err
		}
	}
	target, _ := a.field("Target")
	return a.judged("PASS", "Every case passed on "+target+".")
}

// grillQuestion is the question file path on the opening turn of the grill,
// "" once the transcript is in Inputs (then the turn writes the doc).
func (a *agent) grillQuestion() (string, error) {
	if m := regexp.MustCompile(`(?m)^Inputs: (.+)$`).FindStringSubmatch(a.task); m != nil && strings.Contains(m[1], "transcript.md") {
		return "", nil
	}
	assignment, err := a.field("Assignment")
	if err != nil {
		return "", err
	}
	_, q, _ := strings.Cut(assignment, "Question file: ")
	return q, nil
}
