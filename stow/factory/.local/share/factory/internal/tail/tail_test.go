package tail

import (
	"bytes"
	"strings"
	"testing"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
)

func plain(t *testing.T) {
	t.Helper()
	t.Setenv("FORCE_COLOR", "")
	t.Setenv("NO_COLOR", "1")
}

const claudeStream = `{"type":"system","subtype":"init"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Reading the spec."},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/w/spec.md"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"go test ./...\nsecond line"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":[{"type":"text","text":"FAIL pkg\nmore"}]}]}}
not json
{"type":"result","subtype":"success","duration_ms":187000,"total_cost_usd":0.4321}
`

const piStream = `{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"On it."}]}}
{"type":"tool_execution_start","toolName":"bash","args":{"command":"ls"}}
{"type":"tool_execution_end","toolName":"bash","isError":true,"result":{"content":[{"type":"text","text":"boom"}]}}
{"type":"auto_retry_end","success":false,"finalError":"overloaded"}
{"type":"agent_settled"}
{"type":"agent_settled","aborted":true}
`

func run(t *testing.T, format config.Harness, in string) []string {
	t.Helper()
	var out bytes.Buffer
	if err := Run(strings.NewReader(in), &out, format, 80); err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
}

func eq(t *testing.T, got, want []string) {
	t.Helper()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("got:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestClaudeStream(t *testing.T) {
	plain(t)
	eq(t, run(t, config.Claude, claudeStream), []string{
		"Reading the spec.",
		"▸ Read  /w/spec.md",
		"▸ Bash  go test ./...",
		"✗ Bash: FAIL pkg",
		"not json",
		"✓ done in 3m07s · $0.43",
	})
}

func TestClaudeResultFailures(t *testing.T) {
	plain(t)
	f := NewFormatter(config.Claude, 80)
	for in, want := range map[string]string{
		`{"type":"result","subtype":"error_max_turns"}`:                      "✗ failed: error_max_turns",
		`{"type":"result","subtype":"success","is_error":true,"result":"x"}`: "✗ failed: x",
		`{"type":"result","is_error":true}`:                                  "✗ failed: error",
		`{"type":"result","subtype":"success"}`:                              "✓ done",
	} {
		if got, _ := f(in); got != want {
			t.Errorf("%s: got %q, want %q", in, got, want)
		}
	}
}

func TestPiStream(t *testing.T) {
	plain(t)
	eq(t, run(t, config.Pi, piStream), []string{
		"On it.",
		"▸ bash  ls",
		"✗ bash: boom",
		"✗ failed: overloaded",
		"✓ done",
		"✗ failed: aborted",
	})
}

func TestRunKeepsUnterminatedLastLine(t *testing.T) {
	plain(t)
	eq(t, run(t, config.Pi, "plain tail"), []string{"plain tail"})
}

func TestFormatterStripsControls(t *testing.T) {
	plain(t)
	got, _ := NewFormatter(config.Claude, 80)("evil\x1b[2Jtext\r")
	if got != "evil[2Jtext" {
		t.Errorf("got %q", got)
	}
}

func TestWrap(t *testing.T) {
	if got := wrap("aaa bbb ccc", 7); got != "aaa bbb\nccc" {
		t.Errorf("got %q", got)
	}
}

func TestLastTool(t *testing.T) {
	cases := []struct {
		name   string
		format config.Harness
		log    string
		want   string
	}{
		{"claude latest tool_use", config.Claude, claudeStream, "Bash  go test ./..."},
		{"claude none", config.Claude, `{"type":"result"}`, ""},
		{"pi latest start", config.Pi, piStream, "bash  ls"},
		{"pi ignores claude events", config.Pi, claudeStream, ""},
		{"empty", config.Claude, "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := LastTool(c.log, c.format, 80); got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
		})
	}
	if got := LastTool(claudeStream, config.Claude, 8); got != "Bash  g…" {
		t.Errorf("truncated: got %q", got)
	}
}

func TestUseColor(t *testing.T) {
	cases := []struct {
		name, force, noColor string
		want                 bool
	}{
		{"force wins over NO_COLOR", "1", "1", true},
		{"force 0 is off", "0", "1", false},
		{"NO_COLOR is off", "", "1", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("FORCE_COLOR", c.force)
			t.Setenv("NO_COLOR", c.noColor)
			if got := UseColor(); got != c.want {
				t.Errorf("got %v, want %v", got, c.want)
			}
		})
	}
	t.Setenv("FORCE_COLOR", "1")
	if got := Paint(Red, "x"); got != "\x1b[31mx\x1b[0m" {
		t.Errorf("paint: %q", got)
	}
}

func TestFormatDuration(t *testing.T) {
	for ms, want := range map[float64]string{0: "0s", 45000: "45s", 187000: "3m07s", 3720000: "1h02m"} {
		if got := FormatDuration(ms); got != want {
			t.Errorf("%v: got %q, want %q", ms, got, want)
		}
	}
}
