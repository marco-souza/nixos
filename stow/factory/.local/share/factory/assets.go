// Package factory holds the files compiled into the binary.
package factory

import (
	"embed"
	"io/fs"
)

//go:embed roles/*.md
var rolesFS embed.FS

// Roles is the role prompts, rooted at the module folder: "roles/<name>.md".
// The *.md pattern is needed: a bare directory pattern skips _common.md.
var Roles fs.FS = rolesFS
