// Package harness turns a role into an agent run: it loads the role's
// prompt, picks the model and timeout, writes the task prompt and builds the
// claude or pi command line.
package harness

import (
	"fmt"
	"io/fs"
	"regexp"
	"slices"
	"strings"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
)

// Tool is a tool name that is the same on every harness.
type Tool string

// The tools a role can use.
const (
	Read  Tool = "read"
	Grep  Tool = "grep"
	Glob  Tool = "glob"
	Bash  Tool = "bash"
	Edit  Tool = "edit"
	Write Tool = "write"
)

var tools = []Tool{Read, Grep, Glob, Bash, Edit, Write}

// Role is a role file: its frontmatter and its prompt.
type Role struct {
	Name        string
	Description string
	Tools       []Tool
	Browser     bool
	Tier        config.Tier
	Include     []string
	Body        string
}

var (
	frontmatterKeys = []string{"name", "description", "tools", "browser", "tier", "include"}
	frontmatter     = regexp.MustCompile(`(?s)^---\n(.*?)\n---[ \t]*(?:\n(.*))?$`)
)

func trimBlankLines(s string) string {
	lines := strings.Split(s, "\n")
	start, end := 0, len(lines)
	for start < end && strings.TrimSpace(lines[start]) == "" {
		start++
	}
	for end > start && strings.TrimSpace(lines[end-1]) == "" {
		end--
	}
	return strings.Join(lines[start:end], "\n")
}

func inlineList(v, file, key string) ([]string, error) {
	if !strings.HasPrefix(v, "[") || !strings.HasSuffix(v, "]") {
		return nil, fmt.Errorf("%s: %q must be an inline list like [a, b]", file, key)
	}
	var out []string
	for s := range strings.SplitSeq(v[1:len(v)-1], ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out, nil
}

func flag(raw map[string]string, key, file string) (bool, error) {
	switch raw[key] {
	case "", "false":
		return false, nil
	case "true":
		return true, nil
	}
	return false, fmt.Errorf("%s: %q must be true or false", file, key)
}

// ParseRole reads a role file's text. file only names the file in errors.
func ParseRole(text, file string) (Role, error) {
	m := frontmatter.FindStringSubmatch(strings.ReplaceAll(text, "\r\n", "\n"))
	if m == nil {
		return Role{}, fmt.Errorf("%s: missing frontmatter", file)
	}
	raw := map[string]string{}
	for line := range strings.SplitSeq(m[1], "\n") {
		if t := strings.TrimSpace(line); t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			return Role{}, fmt.Errorf("%s: bad frontmatter line %q", file, line)
		}
		key = strings.TrimSpace(key)
		if !slices.Contains(frontmatterKeys, key) {
			return Role{}, fmt.Errorf("%s: unknown frontmatter key %q", file, key)
		}
		raw[key] = strings.TrimSpace(val)
	}
	for _, k := range []string{"name", "description", "tier"} {
		if raw[k] == "" {
			return Role{}, fmt.Errorf("%s: missing %q", file, k)
		}
	}
	tier := config.Tier(raw["tier"])
	if !slices.Contains([]config.Tier{config.High, config.Medium, config.Low}, tier) {
		return Role{}, fmt.Errorf("%s: invalid tier %q (high, medium, low)", file, tier)
	}
	r := Role{Name: raw["name"], Description: raw["description"], Tier: tier, Include: []string{"_common"}, Body: trimBlankLines(m[2])}
	if v, ok := raw["tools"]; ok {
		names, err := inlineList(v, file, "tools")
		if err != nil {
			return Role{}, err
		}
		for _, n := range names {
			if !slices.Contains(tools, Tool(n)) {
				return Role{}, fmt.Errorf("%s: unknown tool %q", file, n)
			}
			r.Tools = append(r.Tools, Tool(n))
		}
	}
	var err error
	if r.Browser, err = flag(raw, "browser", file); err != nil {
		return Role{}, err
	}
	if v, ok := raw["include"]; ok {
		if r.Include, err = inlineList(v, file, "include"); err != nil {
			return Role{}, err
		}
	}
	return r, nil
}

// LoadRole reads roles/<name>.md from roles and prepends the files it
// includes. roles is rooted at the module folder, like factory.Roles.
func LoadRole(roles fs.FS, name string) (Role, error) {
	file := "roles/" + name + ".md"
	data, err := fs.ReadFile(roles, file)
	if err != nil {
		return Role{}, fmt.Errorf("role %q: %w", name, err)
	}
	r, err := ParseRole(string(data), file)
	if err != nil {
		return Role{}, err
	}
	parts := make([]string, 0, len(r.Include)+1)
	for _, inc := range r.Include {
		b, err := fs.ReadFile(roles, "roles/"+inc+".md")
		if err != nil {
			return Role{}, fmt.Errorf("include file roles/%s.md not found (role %q): %w", inc, name, err)
		}
		parts = append(parts, trimBlankLines(string(b)))
	}
	r.Body = strings.Join(append(parts, r.Body), "\n\n")
	return r, nil
}
