// Package tail turns an agent's raw JSON event stream into the lines a human
// reads in the driver window and in `factory logs`.
package tail

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
)

const esc = "\x1b["

// UseColor is true on a TTY without NO_COLOR; FORCE_COLOR turns it on
// regardless.
func UseColor() bool {
	if f := os.Getenv("FORCE_COLOR"); f != "" && f != "0" {
		return true
	}
	if _, ok := os.LookupEnv("NO_COLOR"); ok {
		return false
	}
	fi, err := os.Stdout.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

// Style is a color the formatter uses.
type Style string

// The styles the formatter uses.
const (
	Dim   Style = "2"
	Red   Style = "31"
	Green Style = "32"
)

// Paint wraps text in style's ANSI code when UseColor allows it.
func Paint(style Style, text string) string {
	if !UseColor() {
		return text
	}
	return esc + string(style) + "m" + text + esc + "0m"
}

// FormatDuration is `45s`, `3m07s` or `1h02m`.
func FormatDuration(ms float64) string {
	total := int(math.Round(ms / 1000))
	h, m, s := total/3600, total%3600/60, total%60
	switch {
	case h > 0:
		return fmt.Sprintf("%dh%02dm", h, m)
	case m > 0:
		return fmt.Sprintf("%dm%02ds", m, s)
	}
	return fmt.Sprintf("%ds", s)
}

var controls = regexp.MustCompile(`[\x00-\x08\x0b-\x1f\x7f]`)

// clean drops C0 controls (except \n and \t) and DEL, so agent output can't
// drive the terminal.
func clean(text string) string { return controls.ReplaceAllString(text, "") }

func wrap(text string, width int) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		var out []string
		cur := ""
		for _, word := range strings.Split(line, " ") {
			switch {
			case cur != "" && utf8.RuneCountInString(cur)+1+utf8.RuneCountInString(word) > width:
				out = append(out, cur)
				cur = word
			case cur == "" && len(out) == 0:
				cur = word
			default:
				cur += " " + word
			}
		}
		lines[i] = strings.Join(append(out, cur), "\n")
	}
	return strings.Join(lines, "\n")
}

func firstLine(text string) string {
	for l := range strings.SplitSeq(text, "\n") {
		if strings.TrimSpace(l) != "" {
			return strings.TrimSpace(l)
		}
	}
	return ""
}

func truncate(text string, limit int) string {
	r := []rune(text)
	if len(r) <= limit {
		return text
	}
	return string(r[:max(0, limit-1)]) + "…"
}

// argKeys are the tool-input fields worth showing, most telling first.
var argKeys = []string{"command", "file_path", "path", "url", "pattern", "query", "prompt", "description"}

// firstArg is the first line of the most telling string in a tool's input.
func firstArg(input any) string {
	obj, ok := input.(map[string]any)
	if !ok {
		return ""
	}
	for _, k := range argKeys {
		if s, ok := obj[k].(string); ok && s != "" {
			return firstLine(clean(s))
		}
	}
	// Map order is random; sorted keys keep the output stable.
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		if s, ok := obj[k].(string); ok && s != "" {
			return firstLine(clean(s))
		}
	}
	return ""
}

// str is JS's String(v) for the values an event can hold.
func str(v any) string {
	switch s := v.(type) {
	case string:
		return s
	case nil:
		return "undefined"
	case float64:
		return strconv.FormatFloat(s, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

func toolLine(name string, input any, width int) string {
	arg := firstArg(input)
	head := "▸ " + clean(name)
	room := width - utf8.RuneCountInString(head) - 2
	shown := ""
	if arg != "" {
		shown = "  " + truncate(arg, max(1, room))
	}
	return Paint(Dim, head) + shown
}

func errorLine(tool string, body any, width int) string {
	return Paint(Red, truncate("✗ "+clean(tool)+": "+firstLine(clean(blockText(body))), width))
}

// blockText is a tool result's text: a string, or an array of text blocks.
func blockText(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		parts := make([]string, len(c))
		for i, b := range c {
			if m, ok := b.(map[string]any); ok {
				parts[i], _ = m["text"].(string)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func blocks(ev map[string]any) ([]any, bool) {
	msg, _ := ev["message"].(map[string]any)
	b, ok := msg["content"].([]any)
	return b, ok
}

func claudeEvent(ev map[string]any, width int, toolNames map[string]string) string {
	switch ev["type"] {
	case "assistant":
		content, ok := blocks(ev)
		if !ok {
			return ""
		}
		var parts []string
		for _, b := range content {
			block, _ := b.(map[string]any)
			switch block["type"] {
			case "text":
				if t, ok := block["text"].(string); ok && strings.TrimSpace(t) != "" {
					parts = append(parts, wrap(strings.TrimSpace(clean(t)), width))
				}
			case "tool_use":
				if id, ok := block["id"].(string); ok {
					toolNames[id] = str(block["name"])
				}
				parts = append(parts, toolLine(str(block["name"]), block["input"], width))
			}
		}
		return strings.Join(parts, "\n")
	case "user":
		content, ok := blocks(ev)
		if !ok {
			return ""
		}
		var parts []string
		for _, b := range content {
			block, _ := b.(map[string]any)
			if block["type"] != "tool_result" {
				continue
			}
			id, _ := block["tool_use_id"].(string)
			if block["is_error"] == true {
				name, ok := toolNames[id]
				if !ok {
					name = "tool"
				}
				parts = append(parts, errorLine(name, block["content"], width))
			}
			delete(toolNames, id)
		}
		return strings.Join(parts, "\n")
	case "result":
		subtype, hasSubtype := ev["subtype"]
		if ev["is_error"] == true || (hasSubtype && subtype != "success") {
			var why string
			if !hasSubtype || subtype == "success" {
				r, _ := ev["result"].(string)
				if why = firstLine(clean(r)); why == "" {
					why = "error"
				}
			} else {
				why = str(subtype)
			}
			return Paint(Red, "✗ failed: "+why)
		}
		line := "✓ done"
		if d, ok := ev["duration_ms"].(float64); ok {
			line = "✓ done in " + FormatDuration(d)
		}
		if c, ok := ev["total_cost_usd"].(float64); ok {
			line += fmt.Sprintf(" · $%.2f", c)
		}
		return Paint(Green, line)
	}
	return ""
}

func piEvent(ev map[string]any, width int) string {
	switch ev["type"] {
	case "message_end":
		msg, _ := ev["message"].(map[string]any)
		content, ok := msg["content"].([]any)
		if msg["role"] != "assistant" || !ok {
			return ""
		}
		var texts []string
		for _, b := range content {
			block, _ := b.(map[string]any)
			if t, ok := block["text"].(string); block["type"] == "text" && ok && strings.TrimSpace(t) != "" {
				texts = append(texts, wrap(strings.TrimSpace(clean(t)), width))
			}
		}
		return strings.Join(texts, "\n")
	case "tool_execution_start":
		return toolLine(str(ev["toolName"]), ev["args"], width)
	case "tool_execution_end":
		if ev["isError"] == true {
			res, _ := ev["result"].(map[string]any)
			return errorLine(str(ev["toolName"]), res["content"], width)
		}
	case "auto_retry_end":
		if ev["success"] == false {
			e := "retry"
			if ev["finalError"] != nil {
				e = str(ev["finalError"])
			}
			return Paint(Red, "✗ failed: "+clean(e))
		}
	case "agent_settled":
		if ev["aborted"] == true {
			return Paint(Red, "✗ failed: aborted")
		}
		return Paint(Green, "✓ done")
	}
	return ""
}

// LastTool is `<tool>  <first argument>` of the latest tool call in a raw
// agent log, cut to width. It is "" when there is none.
func LastTool(log string, format config.Harness, width int) string {
	lines := strings.Split(log, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		var ev map[string]any
		if json.Unmarshal([]byte(lines[i]), &ev) != nil {
			continue
		}
		var name, input any
		switch {
		case format == config.Claude && ev["type"] == "assistant":
			content, _ := blocks(ev)
			for j := len(content) - 1; j >= 0; j-- {
				if b, _ := content[j].(map[string]any); b["type"] == "tool_use" {
					name, input = b["name"], b["input"]
					break
				}
			}
		case format == config.Pi && ev["type"] == "tool_execution_start":
			name, input = ev["toolName"], ev["args"]
		}
		if name == nil {
			continue
		}
		text := clean(str(name))
		if arg := firstArg(input); arg != "" {
			text += "  " + arg
		}
		return truncate(text, width)
	}
	return ""
}

// NewFormatter returns a formatter for one stream. It keeps the tool_use id
// to name map, so a later is_error tool_result can say which tool failed.
// The bool is false when the line shows nothing.
func NewFormatter(format config.Harness, width int) func(line string) (string, bool) {
	toolNames := map[string]string{}
	return func(line string) (string, bool) {
		if strings.TrimSpace(line) == "" {
			return "", false
		}
		var ev any
		m, ok := map[string]any(nil), false
		if json.Unmarshal([]byte(line), &ev) == nil {
			m, ok = ev.(map[string]any)
		}
		if !ok {
			return clean(line), true
		}
		var out string
		if format == config.Claude {
			out = claudeEvent(m, width, toolNames)
		} else {
			out = piEvent(m, width)
		}
		return out, out != ""
	}
}

// Width is the terminal width: $COLUMNS, else 120.
func Width() int {
	if n, err := strconv.Atoi(os.Getenv("COLUMNS")); err == nil && n > 0 {
		return n
	}
	return 120
}

// Run copies in to out, one formatted event per line.
func Run(in io.Reader, out io.Writer, format config.Harness, width int) error {
	fmtLine := NewFormatter(format, width)
	r := bufio.NewReader(in)
	for {
		line, err := r.ReadString('\n')
		if line != "" {
			if s, ok := fmtLine(strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")); ok {
				if _, werr := io.WriteString(out, s+"\n"); werr != nil {
					return werr
				}
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
