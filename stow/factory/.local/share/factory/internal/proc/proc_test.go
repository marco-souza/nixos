package proc

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/marco-souza/nixos/stow/factory/internal/testkit"
)

func TestMain(m *testing.M) {
	testkit.ClearGitEnv()
	os.Exit(m.Run())
}

type fakeRunner struct {
	calls [][]string
	res   Result
	err   error
}

func (f *fakeRunner) Run(_ context.Context, argv []string, _ Opts) (Result, error) {
	f.calls = append(f.calls, argv)
	return f.res, f.err
}

func TestExitError(t *testing.T) {
	var lines []string
	for i := 1; i <= 25; i++ {
		lines = append(lines, fmt.Sprintf("line %d", i), "")
	}
	argv := []string{"git", "push"}
	err := Check(argv, Result{Code: 3, Combined: strings.Join(lines, "\n")})
	var ee *ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("Check = %v, want *ExitError", err)
	}
	var tail []string
	for i := 6; i <= 25; i++ {
		tail = append(tail, fmt.Sprintf("line %d", i))
	}
	want := "git push failed (exit 3): line 25\n\n" + strings.Join(tail, "\n")
	if ee.Error() != want {
		t.Errorf("Error() =\n%s\nwant\n%s", ee.Error(), want)
	}
	if ee.Code != 3 || strings.Count(ee.Tail, "\n") != TailLines-1 {
		t.Errorf("Code=%d, tail lines=%d", ee.Code, strings.Count(ee.Tail, "\n")+1)
	}
	if Check(argv, Result{}) != nil {
		t.Error("exit 0 must not be an error")
	}
	if got := (&ExitError{Cmd: argv, Code: 1}).Error(); got != "git push failed (exit 1)" {
		t.Errorf("no output: %q", got)
	}
}

func TestRealRunnerCombinedOrder(t *testing.T) {
	r, err := RealRunner{}.Run(context.Background(),
		[]string{"bash", "-c", "echo one; sleep 0.1; echo two >&2; sleep 0.1; echo three; exit 4"}, Opts{})
	if err != nil {
		t.Fatal(err)
	}
	if r.Code != 4 || r.Stdout != "one\nthree\n" || r.Stderr != "two\n" || r.Combined != "one\ntwo\nthree\n" {
		t.Errorf("got %+v", r)
	}
	if _, err := (RealRunner{}).Run(context.Background(), []string{"/no/such/binary"}, Opts{}); err == nil {
		t.Error("a missing binary must be an error")
	}
}

func TestNotify(t *testing.T) {
	tests := []struct {
		goos string
		want []string
	}{
		{"darwin", []string{"osascript", "-e", `display notification "say \"hi\"" with title "T"`}},
		{"linux", []string{"notify-send", "--", "T", `say "hi"`}},
	}
	for _, tt := range tests {
		t.Run(tt.goos, func(t *testing.T) {
			f := &fakeRunner{res: Result{Code: 1}, err: errors.New("no notifier")}
			var bell bytes.Buffer
			Notify(context.Background(), f, tt.goos, &bell, "T", `say "hi"`)
			if len(f.calls) != 1 || strings.Join(f.calls[0], "\x00") != strings.Join(tt.want, "\x00") {
				t.Errorf("calls = %q, want %q", f.calls, tt.want)
			}
			if bell.String() != "\x07" {
				t.Errorf("bell = %q", bell.String())
			}
		})
	}
	var bell bytes.Buffer
	f := &fakeRunner{}
	Notify(context.Background(), f, "windows", &bell, "T", "m")
	if len(f.calls) != 0 || bell.String() != "\x07" {
		t.Errorf("windows: calls=%q bell=%q", f.calls, bell.String())
	}
}

func TestWriteRunScript(t *testing.T) {
	f := t.TempDir() + "/a.sh"
	s, err := WriteRunScript("/bin/factory", SpawnRequest{
		Cwd: "/w'x", Command: "echo hi", ScriptFile: f, LogFile: "/l", DoneFile: "/d", Tail: "claude",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "#!/usr/bin/env bash\nset -o pipefail\n" +
		`cd '/w'\''x' || { echo 97 > '/d'; exit 97; }` + "\n" +
		`echo hi 2>&1 | tee -a '/l' | '/bin/factory' tail --format claude` + "\n" +
		`echo "${PIPESTATUS[0]}" > '/d'` + "\n"
	if s != want {
		t.Errorf("script =\n%s\nwant\n%s", s, want)
	}
}

func TestShq(t *testing.T) {
	if got := Shq("it's"); got != `'it'\''s'` {
		t.Errorf("got %s", got)
	}
}
