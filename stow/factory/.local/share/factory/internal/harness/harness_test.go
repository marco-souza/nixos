package harness

import (
	"errors"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"

	factory "github.com/marco-souza/nixos/stow/factory"
	"github.com/marco-souza/nixos/stow/factory/internal/config"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
)

func roleFS(files map[string]string) fs.FS {
	m := fstest.MapFS{}
	for k, v := range files {
		m["roles/"+k+".md"] = &fstest.MapFile{Data: []byte(v)}
	}
	return m
}

const roleText = "---\nname: x\ndescription: d\ntools: [read, bash]\nbrowser: true\ntier: high\n---\n\n\nBody line.\n\n"

func TestParseRole(t *testing.T) {
	r, err := ParseRole(roleText, "x.md")
	if err != nil {
		t.Fatal(err)
	}
	if r.Name != "x" || r.Description != "d" || !r.Browser || r.Tier != config.High || r.Body != "Body line." {
		t.Errorf("got %+v", r)
	}
	if len(r.Tools) != 2 || r.Tools[0] != Read || r.Tools[1] != Bash {
		t.Errorf("tools: %v", r.Tools)
	}
	if len(r.Include) != 1 || r.Include[0] != "_common" {
		t.Errorf("include defaults to _common: %v", r.Include)
	}
}

func TestParseRoleDefaults(t *testing.T) {
	r, err := ParseRole("---\r\nname: x\r\ndescription: d\r\ntier: low\r\ninclude: []\r\n# a comment\r\n---", "x.md")
	if err != nil {
		t.Fatal(err)
	}
	if r.Browser || len(r.Tools) != 0 || len(r.Include) != 0 || r.Body != "" {
		t.Errorf("got %+v", r)
	}
}

func TestParseRoleErrors(t *testing.T) {
	head := "---\nname: x\ndescription: d\ntier: low\n"
	cases := []struct{ name, text, want string }{
		{"no frontmatter", "body", "x.md: missing frontmatter"},
		{"bad line", head + "oops\n---\n", `bad frontmatter line "oops"`},
		{"unknown key", head + "harness: pi\n---\n", `unknown frontmatter key "harness"`},
		{"missing name", "---\ndescription: d\ntier: low\n---\n", `missing "name"`},
		{"missing tier", "---\nname: x\ndescription: d\n---\n", `missing "tier"`},
		{"bad tier", "---\nname: x\ndescription: d\ntier: top\n---\n", `invalid tier "top"`},
		{"bad tool", head + "tools: [read, sudo]\n---\n", `unknown tool "sudo"`},
		{"tools not a list", head + "tools: read\n---\n", `"tools" must be an inline list`},
		{"include not a list", head + "include: _common\n---\n", `"include" must be an inline list`},
		{"bad browser", head + "browser: yes\n---\n", `"browser" must be true or false`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := ParseRole(c.text, "x.md")
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("got %v, want %q", err, c.want)
			}
		})
	}
}

func TestLoadRoleJoinsIncludes(t *testing.T) {
	fsys := roleFS(map[string]string{
		"a":       "---\nname: a\ndescription: d\ntier: low\ninclude: [_one, _two]\n---\nA body.\n",
		"_one":    "\n\nOne.\n\n",
		"_two":    "Two.",
		"default": "---\nname: default\ndescription: d\ntier: low\n---\nBody.\n",
		"_common": "Common.\n",
		"broken":  "---\nname: broken\ndescription: d\ntier: low\ninclude: [_gone]\n---\n",
	})
	r, err := LoadRole(fsys, "a")
	if err != nil || r.Body != "One.\n\nTwo.\n\nA body." {
		t.Errorf("got %q, %v", r.Body, err)
	}
	if r, err = LoadRole(fsys, "default"); err != nil || r.Body != "Common.\n\nBody." {
		t.Errorf("default include: got %q, %v", r.Body, err)
	}
	if _, err = LoadRole(fsys, "broken"); err == nil || !strings.Contains(err.Error(), "include file roles/_gone.md not found") {
		t.Errorf("missing include: %v", err)
	}
	if _, err = LoadRole(fsys, "nope"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("missing role: %v", err)
	}
}

// Every role the binary ships must load, so a typo in a role file fails here
// and not in the middle of a job.
func TestLoadEveryEmbeddedRole(t *testing.T) {
	entries, err := fs.ReadDir(factory.Roles, "roles")
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range entries {
		name := strings.TrimSuffix(e.Name(), ".md")
		if strings.HasPrefix(name, "_") {
			continue
		}
		n++
		r, err := LoadRole(factory.Roles, name)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if r.Name != name || r.Body == "" {
			t.Errorf("%s: name %q, empty body %v", name, r.Name, r.Body == "")
		}
	}
	if n < 20 {
		t.Errorf("only %d roles found", n)
	}
}

func TestResolve(t *testing.T) {
	cfg := config.Defaults()
	cfg.Models[config.Pi] = map[config.Tier]string{config.High: "big"}
	cfg.Roles["slow"] = config.RoleOverride{TimeoutMin: 99}
	cfg.Roles["lifted"] = config.RoleOverride{Tier: config.High}
	role := func(name string, tier config.Tier, browser bool) Role {
		return Role{Name: name, Tier: tier, Browser: browser}
	}
	cases := []struct {
		name string
		role Role
		h    config.Harness
		want Resolved
	}{
		{"claude tier model and timeout", role("r", config.Medium, false), config.Claude, Resolved{config.Claude, "sonnet", 30}},
		{"browser role stays on the job's harness", role("r", config.High, true), config.Pi, Resolved{config.Pi, "big", 45}},
		{"pi with no model for the tier", role("r", config.Low, false), config.Pi, Resolved{config.Pi, "", 15}},
		{"timeout override", role("slow", config.Low, false), config.Claude, Resolved{config.Claude, "haiku", 99}},
		{"tier override", role("lifted", config.Low, false), config.Claude, Resolved{config.Claude, "opus", 45}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := Resolve(c.role, c.h, cfg)
			if err != nil || got != c.want {
				t.Errorf("got %+v, %v; want %+v", got, err, c.want)
			}
		})
	}
	var he *Error
	if _, err := Resolve(role("r", config.Low, false), "gpt", cfg); !errors.As(err, &he) || !strings.Contains(err.Error(), `unknown harness "gpt"`) {
		t.Errorf("bad harness: %v", err)
	}
	if _, err := Resolve(role("r", "top", false), config.Claude, cfg); !errors.As(err, &he) || !strings.Contains(err.Error(), `unknown tier "top"`) {
		t.Errorf("bad tier: %v", err)
	}
}

func TestTaskPrompt(t *testing.T) {
	j := job.New(job.NewArgs{ID: "j1", Branch: "factory/j1", Base: "main", Feature: "do it", Repo: "/r", Harness: config.Claude, Slot: 1})
	j.Cycle, j.Trip = 2, 3
	c := TaskContext{Job: j, Paths: job.NewPaths("/r", "j1"), Assignment: "Task T1", Output: "/r/.factory/jobs/j1/trip-3/build.md"}
	want := strings.Join([]string{
		"Job: j1",
		"Request: do it",
		"Worktree: /r/.factory/j1 (your working directory)",
		"Job folder: /r/.factory/jobs/j1",
		"Cycle: 2  Trip: 3",
		"Base: main",
		"Docs: requirements=/r/.factory/jobs/j1/docs/requirements.md, tech-discovery=/r/.factory/jobs/j1/docs/tech-discovery.md, design=/r/.factory/jobs/j1/docs/design.md, spec=/r/.factory/jobs/j1/docs/spec.md, test-plan=/r/.factory/jobs/j1/docs/test-plan.md",
		"Assignment: Task T1",
		"Output: /r/.factory/jobs/j1/trip-3/build.md",
	}, "\n")
	if got := TaskPrompt(c); got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
	c.Inputs = []string{"/a.md", "/b.md"}
	c.Target = "http://localhost:3000"
	got := TaskPrompt(c)
	if !strings.HasSuffix(got, "\nInputs: /a.md, /b.md\nTarget: http://localhost:3000") {
		t.Errorf("inputs and target: %s", got)
	}
}
