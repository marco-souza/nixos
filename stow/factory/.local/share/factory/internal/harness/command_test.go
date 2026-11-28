package harness

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
)

var files = Files{System: "/job/run/system.md", Task: "/job/run/task.md"}

func role(browser bool, tools ...Tool) Role {
	return Role{Name: "r", Tools: tools, Browser: browser, Tier: config.Medium}
}

func claude(model string) Resolved { return Resolved{Harness: config.Claude, Model: model} }
func pi(model string) Resolved     { return Resolved{Harness: config.Pi, Model: model} }

func command(t *testing.T, r Role, h Resolved, jobDir string) string {
	t.Helper()
	got, err := Command(r, h, files, jobDir)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func fields(cmd string) []string { return strings.Split(cmd, " ") }

// arg is the value after flag in the command line, without quotes.
func arg(t *testing.T, cmd, flag string) string {
	t.Helper()
	f := fields(cmd)
	i := slices.Index(f, flag)
	if i < 0 || i+1 >= len(f) {
		t.Fatalf("no %s in %s", flag, cmd)
	}
	return strings.Trim(f[i+1], "'")
}

func TestCommandClaude(t *testing.T) {
	dir := t.TempDir()
	got := command(t, role(false, Read, Bash, Write), claude("sonnet"), dir)
	want := "claude -p \"$(cat '/job/run/task.md')\" --append-system-prompt-file '/job/run/system.md' --model 'sonnet'" +
		" --permission-mode auto --add-dir '" + dir + "'" +
		" --allowedTools 'Read,Bash,Write' --disallowedTools 'Grep,Glob,Edit,Agent'" +
		" --output-format stream-json --verbose"
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
	if _, err := os.Stat(filepath.Join(dir, "run")); err == nil {
		t.Error("a non-browser role must write no file")
	}
}

func TestCommandNoModel(t *testing.T) {
	for _, h := range []Resolved{claude(""), pi("")} {
		if got := command(t, role(false, Read), h, t.TempDir()); strings.Contains(got, "--model") {
			t.Errorf("%s: no model, no --model: %s", h.Harness, got)
		}
	}
}

func TestCommandClaudeBrowser(t *testing.T) {
	dir := t.TempDir()
	got := command(t, role(true, Read, Edit), claude("sonnet"), dir)
	file := filepath.Join(dir, "run", "playwright.mcp.json")
	if arg(t, got, "--mcp-config") != file {
		t.Errorf("--mcp-config: %s", got)
	}
	allowed := strings.Split(arg(t, got, "--allowedTools"), ",")
	if len(PlaywrightTools) != 12 || !slices.Equal(allowed[2:], PlaywrightTools) || !slices.Equal(allowed[:2], []string{"Read", "Edit"}) {
		t.Errorf("allowed: %v", allowed)
	}
	for _, name := range allowed[2:] {
		if !strings.HasPrefix(name, "mcp__playwright__browser_") {
			t.Errorf("tool %q", name)
		}
	}
	if strings.Contains(arg(t, got, "--disallowedTools"), "mcp__") {
		t.Error("the browser tools are not denied")
	}
	checkFile(t, file, dir, `"@playwright/mcp@0.0.86"`, `"--isolated"`, `"--headless"`, `"mcpServers"`, `"playwright"`)
}

func TestCommandPi(t *testing.T) {
	dir := t.TempDir()
	got := command(t, role(false, Read, Glob, Bash), pi("m"), dir)
	want := "pi -p --append-system-prompt '/job/run/system.md' --model 'm' --tools 'read,find,ls,bash' --mode json \"$(cat '/job/run/task.md')\""
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
	if strings.Contains(got, " -e ") {
		t.Error("a non-browser role gets no extension")
	}
	if _, err := os.Stat(filepath.Join(dir, "run")); err == nil {
		t.Error("a non-browser role must write no file")
	}
}

func TestCommandPiBrowser(t *testing.T) {
	dir := t.TempDir()
	got := command(t, role(true, Read, Bash), pi("m"), dir)
	file := filepath.Join(dir, "run", "playwright.pi.js")
	if arg(t, got, "-e") != file {
		t.Errorf("-e: %s", got)
	}
	tools := strings.Split(arg(t, got, "--tools"), ",")
	if !slices.Equal(tools, append([]string{"read", "bash"}, PlaywrightTools...)) {
		t.Errorf("tools: %v", tools)
	}
	if strings.Contains(got, "--mcp-config") {
		t.Error("pi takes no --mcp-config")
	}
	checkFile(t, file, dir, `"@playwright/mcp@0.0.86"`, `"--isolated"`, `"--headless"`, `registerMcpServer("playwright"`, `"exposure":"direct"`)
}

// checkFile asserts a generated file is private, outside the worktree and
// names the pinned server.
func checkFile(t *testing.T, file, jobDir string, contains ...string) {
	t.Helper()
	fi, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("%s mode %v, want 0600", file, fi.Mode().Perm())
	}
	if filepath.Dir(file) != filepath.Join(jobDir, "run") {
		t.Errorf("%s is not in the job's run folder", file)
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range contains {
		if !strings.Contains(string(b), s) {
			t.Errorf("%s lacks %s:\n%s", file, s, b)
		}
	}
}

func TestCommandResetsLooseMode(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "run", "playwright.mcp.json")
	if err := os.MkdirAll(filepath.Dir(file), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("old"), 0o644); err != nil { //nolint:gosec // the loose mode is the test
		t.Fatal(err)
	}
	command(t, role(true, Read), claude("m"), dir)
	checkFile(t, file, dir, "mcpServers")
}

func TestShq(t *testing.T) {
	if got := shq("it's"); got != `'it'\''s'` {
		t.Errorf("got %s", got)
	}
}
