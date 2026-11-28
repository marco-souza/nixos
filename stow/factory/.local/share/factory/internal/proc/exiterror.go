package proc

import (
	"fmt"
	"strings"
)

// TailLines is how many output lines an ExitError keeps.
const TailLines = 20

// ExitError is a command that exited non-zero.
type ExitError struct {
	Cmd  []string
	Code int
	// Tail is the last TailLines non-empty lines of the output.
	Tail string
}

// Error is the summary line, a blank line, then the tail.
func (e *ExitError) Error() string {
	summary := fmt.Sprintf("%s failed (exit %d)", strings.Join(e.Cmd, " "), e.Code)
	if e.Tail == "" {
		return summary
	}
	lines := strings.Split(e.Tail, "\n")
	summary += ": " + lines[len(lines)-1]
	return summary + "\n\n" + e.Tail
}

// tail keeps the last TailLines non-empty lines of out.
func tail(out string) string {
	var lines []string
	for l := range strings.SplitSeq(out, "\n") {
		if t := strings.TrimRight(l, " \t\r"); strings.TrimSpace(t) != "" {
			lines = append(lines, t)
		}
	}
	if len(lines) > TailLines {
		lines = lines[len(lines)-TailLines:]
	}
	return strings.Join(lines, "\n")
}
