package job

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
)

var t0 = time.Date(2026, 11, 26, 9, 0, 0, 0, time.UTC)

func newJob(repo string) Job {
	return New(NewArgs{ID: "x", Branch: "factory/x", Base: "main", Feature: "f", Repo: repo, Harness: config.Claude, Slot: 1, Now: t0})
}

// busy is a job with something in every slice, map and pointer.
func busy(repo string) Job {
	ready := true
	j := newJob(repo)
	j.Decisions = []string{"/d1.md"}
	j.Running = []string{"builder"}
	j.Discovery = []DiscoveryRecord{{N: 1, Verdict: "PASS"}}
	j.Ready = &ready
	j.Trips = []TripRecord{{
		Cycle: 1, Trip: 1, Reviews: map[string]string{"a": "PASS"}, Validations: map[string]string{"e2e": "PASS"},
		Built: []string{"T1"},
	}}
	return j
}

func TestCloneIsIndependent(t *testing.T) {
	orig := busy("/repo")
	want := busy("/repo")
	c := orig.Clone()
	if !reflect.DeepEqual(c, orig) {
		t.Fatal("clone differs from the original")
	}

	c.Decisions[0] = "x"
	c.Running[0] = "x"
	c.Discovery[0].Verdict = "x"
	c.Trips[0].Reviews["a"] = "x"
	c.Trips[0].Reviews["b"] = "x"
	c.Trips[0].Validations["e2e"] = "x"
	c.Trips[0].Built[0] = "x"
	c.Trips[0].Trip = 9
	*c.Ready = false
	*c.WaitingSince = t0.Add(time.Hour)

	if !reflect.DeepEqual(orig, want) {
		t.Errorf("changing the clone changed the original:\n got %+v\nwant %+v", orig, want)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	repo := t.TempDir()
	file := NewPaths(repo, "x").JobFile
	j := busy(repo)
	j.Deliverable = DeliverPR
	j.WaitingFor = WaitHumanReview
	if err := Save(file, &j, t0.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file + ".tmp"); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the .tmp file is left behind: %v", err)
	}
	got, err := Load(file)
	if err != nil {
		t.Fatal(err)
	}
	if !got.UpdatedAt.Equal(t0.Add(time.Minute)) {
		t.Errorf("updatedAt = %v", got.UpdatedAt)
	}
	if !reflect.DeepEqual(got, j) {
		t.Errorf("round trip changed the job:\n got %+v\nwant %+v", got, j)
	}
	data, _ := os.ReadFile(file)
	if !strings.Contains(string(data), `"harness": "claude"`) || !strings.HasSuffix(string(data), "}\n") {
		t.Errorf("unexpected job.json:\n%s", data)
	}
}

func TestLoadRejectsOtherVersions(t *testing.T) {
	repo := t.TempDir()
	for _, v := range []int{1, 2, 4} {
		j := newJob(repo)
		j.Version = v
		file := NewPaths(repo, "v").JobFile
		data, _ := json.Marshal(j)
		if err := os.MkdirAll(filepath.Dir(file), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(file); err == nil || !strings.Contains(err.Error(), "not a factory v3 job") {
			t.Errorf("version %d: err = %v", v, err)
		}
	}
}

func TestListSkipsOtherVersionsAndBrokenFiles(t *testing.T) {
	repo := t.TempDir()
	for _, id := range []string{"old", "new"} {
		j := newJob(repo)
		j.ID = id
		j.CreatedAt = t0.Add(map[string]time.Duration{"old": 0, "new": time.Hour}[id])
		if err := Save(NewPaths(repo, id).JobFile, &j, t0); err != nil {
			t.Fatal(err)
		}
	}
	v2 := NewPaths(repo, "v2").JobFile
	if err := os.MkdirAll(filepath.Dir(v2), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(v2, []byte(`{"version":2,"id":"v2"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	bad := NewPaths(repo, "bad").JobFile
	if err := os.MkdirAll(filepath.Dir(bad), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bad, []byte(`{`), 0o600); err != nil {
		t.Fatal(err)
	}

	var ids []string
	for _, j := range List(repo) {
		ids = append(ids, j.ID)
	}
	if want := []string{"new", "old"}; !reflect.DeepEqual(ids, want) {
		t.Errorf("ids = %v, want %v (newest first)", ids, want)
	}
}

func TestNextSlotSkipsLiveJobs(t *testing.T) {
	repo := t.TempDir()
	for id, slot := range map[string]int{"a": 1, "b": 2, "c": 3} {
		j := newJob(repo)
		j.ID, j.Slot = id, slot
		if id == "b" {
			j.Stage = StageDone
		}
		if err := Save(NewPaths(repo, id).JobFile, &j, t0); err != nil {
			t.Fatal(err)
		}
	}
	if got := NextSlot(repo); got != 2 {
		t.Errorf("NextSlot = %d, want 2 (a done job frees its slot)", got)
	}
}

func TestTakenIDs(t *testing.T) {
	repo := t.TempDir()
	if err := os.MkdirAll(NewPaths(repo, "mine").JobDir, 0o750); err != nil {
		t.Fatal(err)
	}
	got := TakenIDs(repo)
	for _, id := range []string{"mine", "jobs", "archive"} {
		if !got[id] {
			t.Errorf("%q should be taken", id)
		}
	}
	if got["other"] {
		t.Error(`"other" should be free`)
	}
}

func TestIDs(t *testing.T) {
	tests := []struct{ in, want string }{
		{"Add the dark mode toggle to settings", "add-dark-mode-toggle"},
		{"Café São Paulo", "cafe-sao-paulo"},
		{"the a of", "job"},
	}
	for _, tc := range tests {
		if got := Slugify(tc.in); got != tc.want {
			t.Errorf("Slugify(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	if got := TicketOf("see https://x/browse/ABC-123 and DEF-4"); got != "ABC-123" {
		t.Errorf("TicketOf = %q", got)
	}
	if got := TicketOf("nothing here"); got != "" {
		t.Errorf("TicketOf = %q", got)
	}
	if got := CaseBranch("Fix/abc-2/Raise-Timeout"); got != "fix/ABC-2/raise-timeout" {
		t.Errorf("CaseBranch = %q", got)
	}
	if got := CaseBranch("fix/abc-2"); got != "fix/abc-2" {
		t.Errorf("CaseBranch keeps a last part: %q", got)
	}
	if got := IDFor("fix/ABC-123/raise-timeout"); got != "abc-123-raise-timeout" {
		t.Errorf("IDFor = %q", got)
	}
	if got := IDFor("feature"); got != "feature" {
		t.Errorf("IDFor = %q", got)
	}
	if got := IDFor("fix/"); got != "job" {
		t.Errorf("IDFor = %q", got)
	}
}

// deadPID is the pid of a process that has exited.
func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), "true")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	return cmd.Process.Pid
}

func TestLock(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "driver.lock")

	release, err := Acquire(dir, os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	var le *LockError
	if _, err := Acquire(dir, os.Getpid()+1); !errors.As(err, &le) || !strings.Contains(err.Error(), "driver already running") {
		t.Errorf("a live holder should refuse: %v", err)
	}
	release()
	if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("release should remove the lock: %v", err)
	}

	// A dead pid's lock is taken over.
	if err := os.WriteFile(file, []byte(strconv.Itoa(deadPID(t))+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	release, err = Acquire(dir, os.Getpid())
	if err != nil {
		t.Fatalf("takeover failed: %v", err)
	}
	if got := holder(file); got != os.Getpid() {
		t.Errorf("holder = %d, want %d", got, os.Getpid())
	}
	release()
}

func TestLockReleaseKeepsAnotherHoldersLock(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "driver.lock")
	release, err := Acquire(dir, os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	release()
	if _, err := os.Stat(file); err != nil {
		t.Errorf("release removed a lock it no longer holds: %v", err)
	}
}
