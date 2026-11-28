package testkit

import (
	"encoding/json"
	"os"
	"strconv"
	"syscall"
)

// Scenario is what the fake agents answer: verdicts per role, one per visit
// (`"build-judge": ["CHANGES", "APPROVE"]`). A role without one, or past its
// last, gives its passing verdict. A few keys are settings, not verdicts:
// `deliverable`, `access`, `sleepMs` and `noCommit`.
type Scenario map[string][]string

// Write saves the scenario as JSON.
func (s Scenario) Write(file string) error {
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return os.WriteFile(file, data, 0o600)
}

// ReadScenario loads a scenario file.
func ReadScenario(file string) (Scenario, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var s Scenario
	return s, json.Unmarshal(data, &s)
}

// Setting is the first value of a settings key, or "".
func (s Scenario) Setting(key string) string {
	if v := s[key]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// Verdict is role's verdict for this visit, or fallback. Visits are counted
// in <file>.<role>.count, under a lock: agents run as separate processes.
func (s Scenario) Verdict(file, role, fallback string) (string, error) {
	f, err := os.OpenFile(file+"."+role+".count", os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return "", err
	}
	data := make([]byte, 16)
	n, _ := f.ReadAt(data, 0)
	visits, _ := strconv.Atoi(string(data[:n]))
	visits++
	if err := f.Truncate(0); err != nil {
		return "", err
	}
	if _, err := f.WriteAt([]byte(strconv.Itoa(visits)), 0); err != nil {
		return "", err
	}
	if v := s[role]; visits <= len(v) {
		return v[visits-1], nil
	}
	return fallback, nil
}
