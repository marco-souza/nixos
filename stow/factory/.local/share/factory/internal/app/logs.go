package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
	"github.com/marco-souza/nixos/stow/factory/internal/deps"
	"github.com/marco-souza/nixos/stow/factory/internal/job"
	"github.com/marco-souza/nixos/stow/factory/internal/machine"
	"github.com/marco-souza/nixos/stow/factory/internal/tail"
	"github.com/marco-souza/nixos/stow/factory/internal/ui"
)

const (
	lastLines  = 200
	followPoll = 500 * time.Millisecond
)

var (
	logName      = regexp.MustCompile(`^(.+)-(\d+)\.log$`)
	claudeTypes  = []string{"system", "assistant", "user", "result"}
	errNoLogs    = "no logs for %s yet"
	errNoRoleLog = "no %s logs for %s"
)

// pickLog is <role>-<n>.log: the role's highest n, or with no role the latest
// written log. "" when there is none.
func pickLog(logsDir, role string) string {
	entries, _ := os.ReadDir(logsDir)
	best, bestN := "", -1
	var newest string
	var newestAt time.Time
	for _, e := range entries {
		m := logName.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		if role != "" {
			if n, _ := strconv.Atoi(m[2]); m[1] == role && n > bestN {
				best, bestN = e.Name(), n
			}
			continue
		}
		if fi, err := e.Info(); err == nil && (newest == "" || fi.ModTime().After(newestAt)) {
			newest, newestAt = e.Name(), fi.ModTime()
		}
	}
	if role != "" {
		return best
	}
	return newest
}

// detectFormat reads the first JSON line: claude events have a session_id and
// a claude type; anything else is pi.
func detectFormat(text string) config.Harness {
	for line := range strings.SplitSeq(text, "\n") {
		var ev map[string]any
		if json.Unmarshal([]byte(line), &ev) != nil || ev == nil {
			continue
		}
		sid, _ := ev["session_id"].(string)
		typ, _ := ev["type"].(string)
		if sid != "" && slices.Contains(claudeTypes, typ) {
			return config.Claude
		}
		return config.Pi
	}
	return config.Claude
}

// Logs writes the last lines of an agent's log through one formatter of its
// own; follow keeps going until the agent is done.
func Logs(ctx context.Context, repo, id, role string, follow bool, out io.Writer, d deps.Deps) error {
	if _, err := findJob(repo, id); err != nil {
		return err
	}
	paths := job.NewPaths(repo, id)
	name := pickLog(paths.LogsDir, role)
	if name == "" {
		if role != "" {
			return &machine.CommandError{Msg: fmt.Sprintf(errNoRoleLog, role, id)}
		}
		return &machine.CommandError{Msg: fmt.Sprintf(errNoLogs, id)}
	}
	file := filepath.Join(paths.LogsDir, name)
	bytes, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	text := string(bytes)
	fmtLine := tail.NewFormatter(detectFormat(text), tail.Width())
	emit := func(line string) {
		if s, ok := fmtLine(strings.TrimSuffix(line, "\r")); ok {
			_, _ = fmt.Fprintln(out, s)
		}
	}
	// A line still being written is printed whole when following, as it lands.
	end := len(text)
	if follow && !strings.HasSuffix(text, "\n") {
		end = strings.LastIndex(text, "\n") + 1
	}
	_, _ = fmt.Fprintln(out, ui.Paint(ui.Dim, "logs/"+name))
	lines := strings.Split(text[:end], "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	for _, l := range lines[max(0, len(lines)-lastLines):] {
		emit(l)
	}
	if !follow {
		return nil
	}
	done := filepath.Join(paths.DoneDir, strings.TrimSuffix(name, ".log"))
	return followLog(ctx, file, int64(len(bytes)), text[end:], done, emit, d.Sleep)
}

func followLog(ctx context.Context, file string, offset int64, pending, doneFile string, emit func(string), sleep func(context.Context, time.Duration) error) error {
	buf := pending
	for {
		// Checked before reading, so the agent's last write is never missed.
		_, doneErr := os.Stat(doneFile)
		done := doneErr == nil
		fi, err := os.Stat(file)
		if err != nil {
			return err
		}
		if fi.Size() > offset {
			chunk, err := readFrom(file, offset, fi.Size())
			if err != nil {
				return err
			}
			offset = fi.Size()
			buf += chunk
			for {
				nl := strings.IndexByte(buf, '\n')
				if nl < 0 {
					break
				}
				emit(buf[:nl])
				buf = buf[nl+1:]
			}
		}
		if done {
			if buf != "" {
				emit(buf)
			}
			return nil
		}
		if err := sleep(ctx, followPoll); err != nil {
			return err
		}
	}
}

func readFrom(file string, from, to int64) (string, error) {
	f, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	b := make([]byte, to-from)
	n, err := f.ReadAt(b, from)
	if err != nil && err != io.EOF { //nolint:errorlint // io.EOF is returned bare by ReadAt
		return "", err
	}
	return string(b[:n]), nil
}
