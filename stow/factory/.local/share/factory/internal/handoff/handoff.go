// Package handoff names the files agents write and checks what they wrote.
// The factory reads these files literally, so the rules here are strict.
package handoff

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
)

// Kind is a kind of agent output.
type Kind string

// The kinds of output.
const (
	Requirements    Kind = "requirements"
	TechDiscovery   Kind = "tech-discovery"
	Design          Kind = "design"
	DiscoveryReview Kind = "discovery-review"
	Spec            Kind = "spec"
	Build           Kind = "build"
	Review          Kind = "review"
	BuildJudge      Kind = "build-judge"
	TestPlan        Kind = "test-plan"
	Validation      Kind = "validation"
	ValidationJudge Kind = "validation-judge"
	Rebase          Kind = "rebase"
	PR              Kind = "pr"
	Access          Kind = "access"
	Report          Kind = "report"
)

// Check is the result of checking an output. Verdict is the word on a
// verdict or status line, "" for kinds that have none.
type Check struct {
	OK      bool
	Verdict string
	Problem string
}

var (
	// Lenses are the review lenses a spec may list.
	Lenses = []string{"product", "security", "code", "ux", "ui"}
	// Specialists are the builder specialties.
	Specialists = []string{"backend", "frontend", "mobile", "data", "infra", "general"}
)

var (
	bullet   = regexp.MustCompile(`^(?:[-*+]|\d+[.)])\s+`)
	emphasis = regexp.MustCompile("[*`]")
	underbar = regexp.MustCompile(`(^|[\s:])_+|_+($|[\s:,.])`)
	hyphen   = regexp.MustCompile(`^(front|back)-end$`)
	trailing = regexp.MustCompile(`[.,;:]+$`)
)

// unmark strips a leading bullet or number and emphasis marks (`**`, `_`,
// backticks) from a line.
func unmark(line string) string {
	s := bullet.ReplaceAllString(strings.TrimSpace(line), "")
	s = emphasis.ReplaceAllString(s, "")
	s = underbar.ReplaceAllString(s, "${1}${2}")
	return strings.TrimSpace(s)
}

// normalizeSpecialist lowercases a known specialist (hyphen variants
// folded); anything else is returned as written.
func normalizeSpecialist(raw string) string {
	v := strings.TrimSpace(trailing.ReplaceAllString(strings.TrimSpace(raw), ""))
	k := hyphen.ReplaceAllString(strings.ToLower(v), "${1}end")
	if slices.Contains(Specialists, k) {
		return k
	}
	return v
}

// BuilderFor is the builder role for a specialist; unknown ones get
// builder-general.
func BuilderFor(specialist string) string {
	s := normalizeSpecialist(unmark(specialist))
	if !slices.Contains(Specialists, s) {
		s = "general"
	}
	return "builder-" + s
}

// OutputArgs say which output OutputPath names. N is the discovery review
// number, Trip the trip, Name the lens or validator.
type OutputArgs struct {
	Paths job.Paths
	Trip  int
	N     int
	Name  string
}

// OutputPath is the file an agent of kind writes. The five docs live in the
// job folder, never in the worktree. Review and validation outputs need a
// Name.
func OutputPath(kind Kind, a OutputArgs) (string, error) {
	p := a.Paths
	trip := func(file string) string { return filepath.Join(p.TripDir(a.Trip), file) }
	named := func() (string, error) {
		if a.Name == "" {
			return "", fmt.Errorf("outputPath: %q needs a name", kind)
		}
		return a.Name, nil
	}
	switch kind {
	case Requirements, TechDiscovery, Design, Spec, TestPlan:
		return p.Doc(string(kind)), nil
	case DiscoveryReview:
		return p.DiscoveryReview(a.N), nil
	case Build:
		return trip("build.md"), nil
	case Review:
		n, err := named()
		return trip("review-" + n + ".md"), err
	case BuildJudge:
		return trip("build-judge.md"), nil
	case Validation:
		n, err := named()
		return trip("validation-" + n + ".md"), err
	case ValidationJudge:
		return trip("validation-judge.md"), nil
	case Rebase:
		return trip("rebase.md"), nil
	case PR:
		return p.PRFile, nil
	case Access:
		return p.AccessFile, nil
	case Report:
		return p.ReportFile, nil
	}
	return "", fmt.Errorf("outputPath: unknown kind %q", kind)
}

func lines(text string) []string {
	return strings.Split(strings.ReplaceAll(strings.TrimPrefix(text, "\ufeff"), "\r\n", "\n"), "\n")
}

func firstLine(text string) string { return strings.TrimRight(lines(text)[0], " \t\r\n") }

var headingTail = regexp.MustCompile(`:?\s*$`)

// headingOf is a heading line without trailing spaces or one trailing colon.
func headingOf(l string) string { return headingTail.ReplaceAllString(l, "") }

func hasHeading(text, h string) bool {
	return slices.ContainsFunc(lines(text), func(l string) bool { return headingOf(l) == h })
}

// section is the body lines of the `## ` section named h, up to the next
// `## ` heading. ok is false when the section is absent.
func section(text, h string) (body []string, ok bool) {
	all := lines(text)
	start := slices.IndexFunc(all, func(l string) bool { return headingOf(l) == h })
	if start < 0 {
		return nil, false
	}
	rest := all[start+1:]
	if end := slices.IndexFunc(rest, func(l string) bool { return strings.HasPrefix(l, "## ") }); end >= 0 {
		rest = rest[:end]
	}
	return rest, true
}

// listLine is the comma-separated values of the first `<key>: a, b` line,
// lowercased. ok is false when there is no such line.
func listLine(text, key string) (vals []string, ok bool) {
	re := regexp.MustCompile(`(?i)^` + regexp.QuoteMeta(key) + `:\s*(.+?)\s*$`)
	for _, l := range lines(text) {
		if m := re.FindStringSubmatch(unmark(l)); m != nil {
			for s := range strings.SplitSeq(m[1], ",") {
				if s = strings.ToLower(strings.TrimSpace(s)); s != "" {
					vals = append(vals, s)
				}
			}
			return vals, true
		}
	}
	return nil, false
}

func missing(text string, headings ...string) string {
	for _, h := range headings {
		if !hasHeading(text, h) {
			return fmt.Sprintf("missing %q", h)
		}
	}
	return ""
}

// PlanTask is one `### T<k>` task of a spec.
type PlanTask struct{ ID, Specialist string }

// Plan is what the factory reads from a spec.
type Plan struct {
	Tasks    []PlanTask
	Run      []string
	Lenses   []string
	Criteria []int
}

var (
	taskHeading = regexp.MustCompile(`^###\s+(T\d+)\b`)
	specialist  = regexp.MustCompile(`(?i)^Specialist:\s*(.+)$`)
	runPrefix   = regexp.MustCompile(`(?i)^Run:\s*`)
	criterion   = regexp.MustCompile(`^\s*(\d+)\.\s`)
)

// ParsePlan reads a spec's tasks, run list, lenses and criteria numbers.
func ParsePlan(text string) Plan {
	var p Plan
	tasks, _ := section(text, "## Tasks")
	cur := -1
	for _, l := range tasks {
		switch m := taskHeading.FindStringSubmatch(l); {
		case m != nil:
			p.Tasks = append(p.Tasks, PlanTask{ID: m[1]})
			cur = len(p.Tasks) - 1
		case strings.HasPrefix(l, "### "):
			cur = -1
		case cur >= 0 && p.Tasks[cur].Specialist == "":
			if s := specialist.FindStringSubmatch(unmark(l)); s != nil {
				p.Tasks[cur].Specialist = normalizeSpecialist(s[1])
			}
		}
	}
	run, _ := section(text, "## Run")
	var parts []string
	for _, l := range run {
		if s := runPrefix.ReplaceAllString(unmark(l), ""); s != "" {
			parts = append(parts, s)
		}
	}
	for s := range strings.SplitSeq(strings.Join(parts, ","), ",") {
		if s = strings.TrimSuffix(strings.TrimSpace(s), "."); s != "" {
			p.Run = append(p.Run, s)
		}
	}
	crit, _ := section(text, "## Acceptance criteria")
	for _, l := range crit {
		if m := criterion.FindStringSubmatch(l); m != nil {
			n, _ := strconv.Atoi(m[1])
			p.Criteria = append(p.Criteria, n)
		}
	}
	p.Lenses, _ = listLine(text, "Lenses")
	return p
}

// ParseTestPlan reads the validators a test plan lists.
func ParseTestPlan(text string) (validators []string) {
	validators, _ = listLine(text, "Validators")
	return validators
}

var discoveryLine = regexp.MustCompile(`^VERDICT: (PASS|ASK|REWORK (tech-discovery|design))$`)

// DiscoveryVerdict is a parsed discovery review: PASS, ASK, or REWORK of
// Step.
type DiscoveryVerdict struct{ Verdict, Step string }

// ParseDiscoveryReview reads a discovery review's verdict line.
func ParseDiscoveryReview(text string) (DiscoveryVerdict, error) {
	m := discoveryLine.FindStringSubmatch(firstLine(text))
	if m == nil {
		return DiscoveryVerdict{}, errors.New("not a discovery-review verdict line")
	}
	word, _, _ := strings.Cut(m[1], " ")
	return DiscoveryVerdict{Verdict: word, Step: m[2]}, nil
}

func deliverableOf(text string) job.Deliverable {
	if v, _ := listLine(text, "Deliverable"); len(v) > 0 {
		if d := job.Deliverable(v[0]); d == job.DeliverPR || d == job.DeliverReport {
			return d
		}
	}
	return ""
}

// RequirementsDoc is what the factory reads from a checked requirements doc.
type RequirementsDoc struct {
	Title       string
	Deliverable job.Deliverable
	// Access is the access list; empty for "None.".
	Access []string
}

// ParseRequirements reads the title, deliverable and access list of a
// requirements doc. A missing deliverable means pr.
func ParseRequirements(text string) RequirementsDoc {
	var items []string
	body, _ := section(text, "## Access")
	for _, l := range body {
		if s := unmark(l); s != "" {
			items = append(items, s)
		}
	}
	d := deliverableOf(text)
	if d == "" {
		d = job.DeliverPR
	}
	if len(items) == 1 && noneWord.MatchString(items[0]) {
		items = nil
	}
	return RequirementsDoc{
		Title:       strings.TrimSpace(strings.TrimPrefix(firstLine(text), "# ")),
		Deliverable: d,
		Access:      items,
	}
}

var (
	noneWord = regexp.MustCompile(`(?i)^none\b`)
	// Only a single line counts as "none"; an explanation must follow on the
	// same line.
	noQuestions = regexp.MustCompile(`(?i)^(none|n/a)[ \t]*\.?[ \t]*([-\x{2013}\x{2014}:][^\n]*)?$`)
)

// HasHumanQuestions is true when a design's "Questions for the human"
// section holds a question.
func HasHumanQuestions(design string) bool {
	var body []string
	sec, _ := section(design, "## Questions for the human")
	for _, l := range sec {
		if strings.TrimSpace(l) != "" {
			body = append(body, l)
		}
	}
	if len(body) == 0 {
		return false
	}
	return len(body) > 1 || !noQuestions.MatchString(unmark(body[0]))
}

type lineSpec struct {
	prefix      string
	words       []string
	questionsOn []string
}

var lineSpecs = map[Kind]lineSpec{
	Build:           {"STATUS", []string{"READY", "BLOCKED"}, nil},
	Rebase:          {"STATUS", []string{"READY", "BLOCKED"}, nil},
	Access:          {"STATUS", []string{"READY", "BLOCKED"}, nil},
	Report:          {"STATUS", []string{"READY", "BLOCKED"}, nil},
	Review:          {"VERDICT", []string{"PASS", "CHANGES"}, nil},
	Validation:      {"VERDICT", []string{"PASS", "FAIL"}, nil},
	BuildJudge:      {"VERDICT", []string{"APPROVE", "CHANGES", "ESCALATE"}, []string{"ESCALATE"}},
	ValidationJudge: {"VERDICT", []string{"PASS", "FAIL", "ENV", "ESCALATE"}, []string{"ESCALATE"}},
}

// quote is `"a", "b" or "c"`.
func quote(items []string) string {
	q := make([]string, len(items))
	for i, s := range items {
		q[i] = strconv.Quote(s)
	}
	if len(q) < 2 {
		return strings.Join(q, "")
	}
	return strings.Join(q[:len(q)-1], ", ") + " or " + q[len(q)-1]
}

func questionsProblem(text string) string {
	body, ok := section(text, "## Questions")
	switch {
	case !ok:
		return `missing "## Questions"`
	case strings.TrimSpace(strings.Join(body, "")) == "":
		return `empty "## Questions"`
	}
	return ""
}

func checkLine(kind Kind, text string) Check {
	spec := lineSpec{}
	if s, ok := lineSpecs[kind]; ok {
		spec = s
	}
	re := regexp.MustCompile("^" + spec.prefix + ": (" + strings.Join(spec.words, "|") + ")$")
	m := re.FindStringSubmatch(firstLine(text))
	if m == nil {
		want := make([]string, len(spec.words))
		for i, w := range spec.words {
			want[i] = spec.prefix + ": " + w
		}
		return Check{Problem: "first line must be " + quote(want)}
	}
	if slices.Contains(spec.questionsOn, m[1]) {
		if p := questionsProblem(text); p != "" {
			return Check{Problem: p}
		}
	}
	return Check{OK: true, Verdict: m[1]}
}

func fail(problem string) Check { return Check{Problem: problem} }

var pass = Check{OK: true}

func checkSpec(text string) Check {
	if m := missing(text, "## Acceptance criteria", "## Tasks"); m != "" {
		return fail(m)
	}
	plan := ParsePlan(text)
	if len(plan.Criteria) == 0 {
		return fail("no numbered acceptance criteria")
	}
	if len(plan.Tasks) == 0 {
		return fail(`no "### T<k>" tasks under "## Tasks"`)
	}
	for _, t := range plan.Tasks {
		if t.Specialist == "" {
			return fail(fmt.Sprintf(`task %s has no "Specialist: <s>" line`, t.ID))
		}
	}
	lenses, ok := listLine(text, "Lenses")
	if !ok {
		return fail(`missing "Lenses:" line`)
	}
	for _, l := range lenses {
		if !slices.Contains(Lenses, l) {
			return fail(fmt.Sprintf("unknown lens %q", l))
		}
	}
	var last string
	for _, l := range lines(text) {
		if strings.HasPrefix(l, "## ") {
			last = headingOf(l)
		}
	}
	if last != "## Run" {
		return fail(`missing "## Run" as the last section`)
	}
	if len(plan.Run) == 0 {
		return fail(`empty "## Run"`)
	}
	ids := make([]string, len(plan.Tasks))
	for i, t := range plan.Tasks {
		ids[i] = t.ID
	}
	for _, r := range plan.Run {
		if !slices.Contains(ids, r) {
			return fail(fmt.Sprintf("Run lists unknown task %q", r))
		}
	}
	return pass
}

var firstTitle = regexp.MustCompile(`^# \S`)

// CheckOutput checks an agent's output of the given kind.
func CheckOutput(kind Kind, text string, cfg config.Config) Check {
	switch kind {
	case Requirements:
		if !strings.HasPrefix(firstLine(text), "# ") {
			return fail(`first line must start with "# "`)
		}
		if m := missing(text, "## Intent", "## Requirements", "## Decisions", "## Access"); m != "" {
			return fail(m)
		}
		if deliverableOf(text) == "" {
			return fail(`missing "Deliverable: pr" or "Deliverable: report" line`)
		}
		return pass
	case TechDiscovery:
		if m := missing(text, "## Findings", "## Risks"); m != "" {
			return fail(m)
		}
		return pass
	case Design:
		if m := missing(text, "## Approach", "## Alternatives", "## Questions for the human"); m != "" {
			return fail(m)
		}
		return pass
	case DiscoveryReview:
		r, err := ParseDiscoveryReview(text)
		if err != nil {
			return fail("first line must be " + quote([]string{"VERDICT: PASS", "VERDICT: REWORK tech-discovery", "VERDICT: REWORK design", "VERDICT: ASK"}))
		}
		if r.Verdict == "ASK" {
			if p := questionsProblem(text); p != "" {
				return fail(p)
			}
		}
		return Check{OK: true, Verdict: r.Verdict}
	case Spec:
		return checkSpec(text)
	case TestPlan:
		if m := missing(text, "## Cases"); m != "" {
			return fail(m)
		}
		validators := ParseTestPlan(text)
		if len(validators) == 0 {
			return fail(`missing "Validators:" line`)
		}
		for _, v := range validators {
			if !slices.Contains(cfg.Validators, v) {
				return fail(fmt.Sprintf("validator %q is not enabled in .factory.json", v))
			}
		}
		return pass
	case PR:
		if firstTitle.MatchString(firstLine(text)) {
			return pass
		}
		return fail(`first line must be "# <PR title>"`)
	}
	return checkLine(kind, text)
}
