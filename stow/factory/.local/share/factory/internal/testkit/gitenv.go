// Package testkit helps tests that run git.
package testkit

import "os"

// GitEnv is the list `git rev-parse --local-env-vars` prints: every variable
// that points git at a repository. Git exports some of them to hooks when a
// push comes from a linked worktree, and with them set a test's `git init`
// would reinitialize the real repo.
var GitEnv = []string{
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
	"GIT_OBJECT_DIRECTORY",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_GRAFT_FILE",
	"GIT_INDEX_FILE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_REPLACE_REF_BASE",
	"GIT_PREFIX",
	"GIT_SHALLOW_FILE",
	"GIT_COMMON_DIR",
}

// ClearGitEnv unsets GitEnv. Call it first in TestMain, before any test: it
// uses os.Unsetenv, which tests may not use once they run in parallel.
func ClearGitEnv() {
	for _, k := range GitEnv {
		_ = os.Unsetenv(k)
	}
}
