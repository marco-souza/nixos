package harness

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
)

// Files are the prompt files a command reads. Prompt text is read from
// files, never interpolated into the command line.
type Files struct{ System, Task string }

var claudeTools = map[Tool]string{
	Read: "Read", Grep: "Grep", Glob: "Glob", Bash: "Bash", Edit: "Edit", Write: "Write",
}

var piTools = map[Tool][]string{
	Read: {"read"}, Grep: {"grep"}, Glob: {"find", "ls"}, Bash: {"bash"}, Edit: {"edit"}, Write: {"write"},
}

// shq single-quotes s for bash.
func shq(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// writeRunFile writes a generated file into the job's run folder, outside
// the worktree, readable by the owner only.
func writeRunFile(jobDir, name string, data []byte) (string, error) {
	dir := filepath.Join(jobDir, "run")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", err
	}
	file := filepath.Join(dir, name)
	if err := os.WriteFile(file, data, 0o600); err != nil {
		return "", err
	}
	// WriteFile keeps the mode of a file that already exists.
	return file, os.Chmod(file, 0o600)
}

// Command is the bash command line that runs role on r.Harness. jobDir holds
// the role's inputs and outputs, outside its working directory (the
// worktree). A browser role also gets the Playwright MCP server, as a file
// written to <jobDir>/run.
func Command(role Role, r Resolved, f Files, jobDir string) (string, error) {
	task := `"$(cat ` + shq(f.Task) + `)"`
	if r.Harness == config.Claude {
		allowed := make([]string, 0, len(role.Tools))
		for _, t := range role.Tools {
			allowed = append(allowed, claudeTools[t])
		}
		var denied []string
		for _, t := range tools {
			if !slices.Contains(role.Tools, t) {
				denied = append(denied, claudeTools[t])
			}
		}
		denied = append(denied, "Agent")
		args := []string{"claude", "-p", task, "--append-system-prompt-file", shq(f.System)}
		if r.Model != "" {
			args = append(args, "--model", shq(r.Model))
		}
		args = append(args, "--permission-mode", "auto",
			// Variadic like --mcp-config: each must be followed by another option, never by the prompt.
			"--add-dir", shq(jobDir))
		// No --strict-mcp-config: agents get the user's MCP servers (tickets, Slack, docs). Auto mode gates risky calls.
		if role.Browser {
			cfg, err := claudeMCPConfig(Playwright)
			if err != nil {
				return "", err
			}
			file, err := writeRunFile(jobDir, "playwright.mcp.json", cfg)
			if err != nil {
				return "", fmt.Errorf("write playwright config: %w", err)
			}
			args = append(args, "--mcp-config", shq(file))
			allowed = append(allowed, PlaywrightTools...)
		}
		args = append(args,
			"--allowedTools", shq(strings.Join(allowed, ",")),
			"--disallowedTools", shq(strings.Join(denied, ",")),
			"--output-format", "stream-json", "--verbose")
		return strings.Join(args, " "), nil
	}

	var allowed []string
	for _, t := range role.Tools {
		allowed = append(allowed, piTools[t]...)
	}
	args := []string{"pi", "-p", "--append-system-prompt", shq(f.System)}
	if r.Model != "" {
		args = append(args, "--model", shq(r.Model))
	}
	if role.Browser {
		ext, err := piExtension(Playwright)
		if err != nil {
			return "", err
		}
		file, err := writeRunFile(jobDir, "playwright.pi.js", ext)
		if err != nil {
			return "", fmt.Errorf("write playwright extension: %w", err)
		}
		args = append(args, "-e", shq(file))
		allowed = append(allowed, PlaywrightTools...)
	}
	args = append(args, "--tools", shq(strings.Join(allowed, ",")), "--mode", "json", task)
	return strings.Join(args, " "), nil
}
