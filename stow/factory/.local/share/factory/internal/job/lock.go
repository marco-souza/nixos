//go:build unix

package job

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// LockError means another driver holds the job's lock.
type LockError struct{ Msg string }

func (e *LockError) Error() string { return e.Msg }

func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	// EPERM: the process exists but belongs to someone else.
	return err == nil || errors.Is(err, syscall.EPERM)
}

func holder(file string) int {
	data, err := os.ReadFile(file)
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}

// Acquire takes <jobDir>/driver.lock for pid and returns its release. A lock
// whose pid is dead is taken over.
func Acquire(jobDir string, pid int) (release func(), err error) {
	file, err := filepath.Abs(filepath.Join(jobDir, "driver.lock"))
	if err != nil {
		return nil, err
	}
	id := filepath.Base(jobDir)
	for range 2 {
		f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			_, werr := fmt.Fprintf(f, "%d\n", pid)
			if cerr := f.Close(); werr == nil {
				werr = cerr
			}
			if werr != nil {
				_ = os.Remove(file)
				return nil, werr
			}
			return func() {
				if holder(file) == pid {
					_ = os.Remove(file)
				}
			}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		// A reboot can hand the dead driver's pid to another process: say how to get out.
		if other := holder(file); other != 0 && alive(other) {
			return nil, &LockError{fmt.Sprintf("driver already running for %s (pid %d). If it isn't (e.g. after a reboot), delete %s", id, other, file)}
		}
		_ = os.Remove(file)
	}
	return nil, &LockError{"could not take the driver lock for " + id}
}
