package testkit

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// Bins are the binaries the end-to-end tests run, built once by BuildBins.
type Bins struct {
	// Dir holds them all; put it first on PATH so `gh` is the fake.
	Dir       string
	Factory   string
	FakeAgent string
	GH        string
}

// moduleRoot is the folder with go.mod, found from the working directory up.
func moduleRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("no go.mod above %s", dir)
		}
		dir = parent
	}
}

// BuildBins builds the factory, the fake agent and the fake gh (as `gh`)
// into <dir>/bin. Call it once, from TestMain.
func BuildBins(dir string) (Bins, error) {
	root, err := moduleRoot()
	if err != nil {
		return Bins{}, err
	}
	bin := filepath.Join(dir, "bin")
	b := Bins{
		Dir:       bin,
		Factory:   filepath.Join(bin, "factory"),
		FakeAgent: filepath.Join(bin, "fake-agent"),
		GH:        filepath.Join(bin, "gh"),
	}
	for out, pkg := range map[string]string{
		b.Factory:   "./cmd/factory",
		b.FakeAgent: "./internal/testkit/fakeagent",
		b.GH:        "./internal/testkit/fakegh",
	} {
		cmd := exec.Command("go", "build", "-o", out, pkg) //nolint:noctx // TestMain has no context
		cmd.Dir = root
		if msg, err := cmd.CombinedOutput(); err != nil {
			return Bins{}, fmt.Errorf("go build %s: %w\n%s", pkg, err, msg)
		}
	}
	return b, nil
}
