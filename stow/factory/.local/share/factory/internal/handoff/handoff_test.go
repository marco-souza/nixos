package handoff

import (
	"reflect"
	"strings"
	"testing"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
)

func TestBuilderFor(t *testing.T) {
	cases := map[string]string{
		"backend":        "builder-backend",
		"Backend.":       "builder-backend",
		"**Front-end**":  "builder-frontend",
		"- `infra`":      "builder-infra",
		"back-end":       "builder-backend",
		"data engineer":  "builder-general",
		"":               "builder-general",
		"`general`, 1st": "builder-general",
	}
	for in, want := range cases {
		if got := BuilderFor(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestOutputPath(t *testing.T) {
	p := job.NewPaths("/r", "j1")
	ok := map[Kind]OutputArgs{
		Requirements:    {},
		TechDiscovery:   {},
		Design:          {},
		Spec:            {},
		TestPlan:        {},
		DiscoveryReview: {N: 2},
		Build:           {Trip: 3},
		Review:          {Trip: 1, Name: "code"},
		BuildJudge:      {Trip: 1},
		Validation:      {Trip: 2, Name: "e2e"},
		ValidationJudge: {Trip: 2},
		Rebase:          {Trip: 2},
		PR:              {},
		Access:          {},
		Report:          {},
	}
	want := map[Kind]string{
		Requirements:    "/r/.factory/jobs/j1/docs/requirements.md",
		TechDiscovery:   "/r/.factory/jobs/j1/docs/tech-discovery.md",
		Design:          "/r/.factory/jobs/j1/docs/design.md",
		Spec:            "/r/.factory/jobs/j1/docs/spec.md",
		TestPlan:        "/r/.factory/jobs/j1/docs/test-plan.md",
		DiscoveryReview: "/r/.factory/jobs/j1/discovery-review-2.md",
		Build:           "/r/.factory/jobs/j1/trip-3/build.md",
		Review:          "/r/.factory/jobs/j1/trip-1/review-code.md",
		BuildJudge:      "/r/.factory/jobs/j1/trip-1/build-judge.md",
		Validation:      "/r/.factory/jobs/j1/trip-2/validation-e2e.md",
		ValidationJudge: "/r/.factory/jobs/j1/trip-2/validation-judge.md",
		Rebase:          "/r/.factory/jobs/j1/trip-2/rebase.md",
		PR:              "/r/.factory/jobs/j1/pr.md",
		Access:          "/r/.factory/jobs/j1/access.md",
		Report:          "/r/.factory/jobs/j1/report.md",
	}
	for kind, args := range ok {
		args.Paths = p
		got, err := OutputPath(kind, args)
		if err != nil || got != want[kind] {
			t.Errorf("%s: got %q, %v; want %q", kind, got, err, want[kind])
		}
	}
	for _, kind := range []Kind{Review, Validation} {
		if _, err := OutputPath(kind, OutputArgs{Paths: p, Trip: 1}); err == nil {
			t.Errorf("%s without a name must fail", kind)
		}
	}
	if _, err := OutputPath("nope", OutputArgs{Paths: p}); err == nil {
		t.Error("unknown kind must fail")
	}
}

const spec = `# Spec

## Acceptance criteria

1. First.
2. Second.

## Tasks

### T1: One
- Specialist: Back-end
- Files: x

### T2: Two
Specialist: **frontend**.

### Notes
Specialist: ignored

## Review

Lenses: Product, code

## Run

Run: T1, T2.
`

func TestParsePlan(t *testing.T) {
	want := Plan{
		Tasks:    []PlanTask{{"T1", "backend"}, {"T2", "frontend"}},
		Run:      []string{"T1", "T2"},
		Lenses:   []string{"product", "code"},
		Criteria: []int{1, 2},
	}
	if got := ParsePlan(spec); !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
	if got := ParsePlan("nothing"); len(got.Tasks)+len(got.Run)+len(got.Lenses)+len(got.Criteria) != 0 {
		t.Errorf("empty: %+v", got)
	}
}

func TestParsePlanKeepsUnknownSpecialist(t *testing.T) {
	got := ParsePlan("## Tasks\n### T1: x\nSpecialist: Data Engineer\n")
	if got.Tasks[0].Specialist != "Data Engineer" {
		t.Errorf("got %q", got.Tasks[0].Specialist)
	}
}

func TestParseTestPlan(t *testing.T) {
	if got := ParseTestPlan("## Cases\n\nValidators: e2e, **User**\n"); !reflect.DeepEqual(got, []string{"e2e", "user"}) {
		t.Errorf("got %v", got)
	}
	if got := ParseTestPlan("## Cases\n"); got != nil {
		t.Errorf("got %v", got)
	}
}

func TestParseDiscoveryReview(t *testing.T) {
	cases := []struct {
		in   string
		want DiscoveryVerdict
		bad  bool
	}{
		{"VERDICT: PASS\n", DiscoveryVerdict{"PASS", ""}, false},
		{"VERDICT: ASK", DiscoveryVerdict{"ASK", ""}, false},
		{"VERDICT: REWORK design\r\nbody", DiscoveryVerdict{"REWORK", "design"}, false},
		{"VERDICT: REWORK tech-discovery", DiscoveryVerdict{"REWORK", "tech-discovery"}, false},
		{"VERDICT: REWORK spec", DiscoveryVerdict{}, true},
		{"**VERDICT: PASS**", DiscoveryVerdict{}, true},
		{"", DiscoveryVerdict{}, true},
	}
	for _, c := range cases {
		got, err := ParseDiscoveryReview(c.in)
		if (err != nil) != c.bad || got != c.want {
			t.Errorf("%q: got %+v, %v", c.in, got, err)
		}
	}
}

func TestParseRequirements(t *testing.T) {
	cases := []struct {
		name, in string
		want     RequirementsDoc
	}{
		{
			"report with access", "# Add a thing\n\nDeliverable: report\n\n## Access\n\n- Jira PROJ-1\n- `Slack`\n\n## Next\n",
			RequirementsDoc{"Add a thing", job.DeliverReport, []string{"Jira PROJ-1", "Slack"}},
		},
		{"none", "# T\n\n## Access\n\nNone.\n", RequirementsDoc{"T", job.DeliverPR, nil}},
		{"bulleted none", "# T\nDeliverable: pr\n## Access\n- **None**\n", RequirementsDoc{"T", job.DeliverPR, nil}},
		{"nothing listed", "# T\n## Access\n", RequirementsDoc{"T", job.DeliverPR, nil}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ParseRequirements(c.in); !reflect.DeepEqual(got, c.want) {
				t.Errorf("got %+v, want %+v", got, c.want)
			}
		})
	}
}

func TestHasHumanQuestions(t *testing.T) {
	doc := func(body string) string {
		return "## Approach\n\nx\n\n## Questions for the human\n" + body + "\n## Other\n"
	}
	cases := map[string]bool{
		"\nNone.\n":                           false,
		"\n- None\n":                          false,
		"\nn/a\n":                             false,
		"\nNone - the requirements decide.\n": false,
		"\nNone: all decided\n":               false,
		"\n\n":                                false,
		"\nNone of the options fit. Which?\n": true,
		"\n1. Which database?\n":              true,
		"\nNone.\nBut what about X?\n":        true,
		"\nNone\n- Q: Which?\n":               true,
		"\nNone – but ask\n":                  false,
	}
	for body, want := range cases {
		if got := HasHumanQuestions(doc(body)); got != want {
			t.Errorf("%q: got %v, want %v", body, got, want)
		}
	}
	if HasHumanQuestions("## Approach\n") {
		t.Error("no section means no questions")
	}
}

func TestCheckOutput(t *testing.T) {
	cfg := config.Defaults()
	req := "# Title\n\nDeliverable: pr\n\n## Intent\n## Requirements\n## Decisions\n## Access\nNone.\n"
	validSpec := spec
	cases := []struct {
		name    string
		kind    Kind
		text    string
		ok      bool
		verdict string
		problem string
	}{
		{"requirements ok", Requirements, req, true, "", ""},
		{"requirements no title", Requirements, "Title\n", false, "", `first line must start with "# "`},
		{"requirements missing heading", Requirements, "# T\n## Intent\n", false, "", `missing "## Requirements"`},
		{"requirements heading with colon", Requirements, strings.Replace(req, "## Intent", "## Intent:", 1), true, "", ""},
		{"requirements no deliverable", Requirements, strings.Replace(req, "Deliverable: pr", "", 1), false, "", `missing "Deliverable: pr" or "Deliverable: report" line`},
		{"requirements bad deliverable", Requirements, strings.Replace(req, "pr", "memo", 1), false, "", `missing "Deliverable: pr" or "Deliverable: report" line`},
		{"tech ok", TechDiscovery, "## Findings\n## Risks\n", true, "", ""},
		{"tech missing", TechDiscovery, "## Findings\n", false, "", `missing "## Risks"`},
		{"design ok", Design, "## Approach\n## Alternatives\n## Questions for the human\n", true, "", ""},
		{"design missing", Design, "## Approach\n## Alternatives\n", false, "", `missing "## Questions for the human"`},
		{"discovery pass", DiscoveryReview, "VERDICT: PASS\n", true, "PASS", ""},
		{"discovery rework", DiscoveryReview, "VERDICT: REWORK design\n", true, "REWORK", ""},
		{"discovery ask needs questions", DiscoveryReview, "VERDICT: ASK\n", false, "", `missing "## Questions"`},
		{"discovery ask empty questions", DiscoveryReview, "VERDICT: ASK\n## Questions\n\n", false, "", `empty "## Questions"`},
		{"discovery ask ok", DiscoveryReview, "VERDICT: ASK\n## Questions\nWhich?\n", true, "ASK", ""},
		{"discovery bad line", DiscoveryReview, "PASS", false, "", `first line must be "VERDICT: PASS", "VERDICT: REWORK tech-discovery", "VERDICT: REWORK design" or "VERDICT: ASK"`},
		{"spec ok", Spec, validSpec, true, "", ""},
		{"spec no tasks", Spec, "## Acceptance criteria\n1. a\n## Tasks\n", false, "", `no "### T<k>" tasks under "## Tasks"`},
		{"spec no criteria", Spec, "## Acceptance criteria\n## Tasks\n", false, "", "no numbered acceptance criteria"},
		{"spec no specialist", Spec, strings.Replace(validSpec, "Specialist: **frontend**.", "", 1), false, "", `task T2 has no "Specialist: <s>" line`},
		{"spec no lenses", Spec, strings.Replace(validSpec, "Lenses: Product, code", "", 1), false, "", `missing "Lenses:" line`},
		{"spec bad lens", Spec, strings.Replace(validSpec, "code", "vibes", 1), false, "", `unknown lens "vibes"`},
		{"spec run not last", Spec, validSpec + "\n## After\n", false, "", `missing "## Run" as the last section`},
		{"spec empty run", Spec, strings.Replace(validSpec, "Run: T1, T2.", "", 1), false, "", `empty "## Run"`},
		{"spec unknown run task", Spec, strings.Replace(validSpec, "T1, T2.", "T1, T9", 1), false, "", `Run lists unknown task "T9"`},
		{"test plan ok", TestPlan, "## Cases\nValidators: e2e, user\n", true, "", ""},
		{"test plan no cases", TestPlan, "Validators: e2e\n", false, "", `missing "## Cases"`},
		{"test plan no validators", TestPlan, "## Cases\n", false, "", `missing "Validators:" line`},
		{"test plan disabled validator", TestPlan, "## Cases\nValidators: load\n", false, "", `validator "load" is not enabled in .factory.json`},
		{"pr ok", PR, "# Add a thing\n", true, "", ""},
		{"pr no title", PR, "Add\n", false, "", `first line must be "# <PR title>"`},
		{"pr empty title", PR, "# \n", false, "", `first line must be "# <PR title>"`},
		{"build ready", Build, "STATUS: READY\n", true, "READY", ""},
		{"build blocked", Build, "STATUS: BLOCKED\n", true, "BLOCKED", ""},
		{"build bad", Build, "STATUS: DONE\n", false, "", `first line must be "STATUS: READY" or "STATUS: BLOCKED"`},
		{"build bom and crlf", Build, "\ufeffSTATUS: READY\r\nrest", true, "READY", ""},
		{"review pass", Review, "VERDICT: PASS\n", true, "PASS", ""},
		{"review bad", Review, "**VERDICT: PASS**\n", false, "", `first line must be "VERDICT: PASS" or "VERDICT: CHANGES"`},
		{"validation fail", Validation, "VERDICT: FAIL\n", true, "FAIL", ""},
		{"build judge approve", BuildJudge, "VERDICT: APPROVE\n", true, "APPROVE", ""},
		{"build judge escalate needs questions", BuildJudge, "VERDICT: ESCALATE\n", false, "", `missing "## Questions"`},
		{"build judge escalate ok", BuildJudge, "VERDICT: ESCALATE\n## Questions\nWhy?\n", true, "ESCALATE", ""},
		{"validation judge env", ValidationJudge, "VERDICT: ENV\n", true, "ENV", ""},
		{"validation judge bad", ValidationJudge, "VERDICT: APPROVE\n", false, "", `first line must be "VERDICT: PASS", "VERDICT: FAIL", "VERDICT: ENV" or "VERDICT: ESCALATE"`},
		{"rebase", Rebase, "STATUS: READY\n", true, "READY", ""},
		{"access", Access, "STATUS: BLOCKED\n", true, "BLOCKED", ""},
		{"report", Report, "STATUS: READY\n", true, "READY", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			want := Check{OK: c.ok, Verdict: c.verdict, Problem: c.problem}
			if got := CheckOutput(c.kind, c.text, cfg); got != want {
				t.Errorf("got %+v, want %+v", got, want)
			}
		})
	}
}
