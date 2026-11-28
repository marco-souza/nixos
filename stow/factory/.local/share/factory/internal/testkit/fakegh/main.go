// Command fakegh stands in for `gh` in the end-to-end tests and the demo. Its
// state lives in $FAKE_GH_DIR (the open PR and its body); every call is
// appended to $FAKE_GH_DIR/calls.jsonl as a JSON array of arguments. A call it
// does not know exits 1 and names itself.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

const owner = "acme/repo"

func main() {
	dir := os.Getenv("FAKE_GH_DIR")
	if dir == "" {
		fmt.Fprintln(os.Stderr, "fakegh: FAKE_GH_DIR is not set")
		os.Exit(1)
	}
	args := os.Args[1:]
	if err := record(dir, args); err != nil {
		fmt.Fprintln(os.Stderr, "fakegh:", err)
		os.Exit(1)
	}
	out, ok := (&gh{dir: dir, args: args}).answer()
	if !ok {
		fmt.Fprintln(os.Stderr, "fakegh: unexpected call: gh "+strings.Join(args, " "))
		os.Exit(1)
	}
	fmt.Print(out)
}

func record(dir string, args []string) error {
	line, err := json.Marshal(args)
	if err != nil {
		return err
	}
	//nolint:gosec // $FAKE_GH_DIR is the test's own folder
	f, err := os.OpenFile(filepath.Join(dir, "calls.jsonl"), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.Write(append(line, '\n'))
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	return werr
}

type gh struct {
	dir  string
	args []string
}

func (g *gh) file(name string) string { return filepath.Join(g.dir, name) }

func (g *gh) read(name string) string {
	data, _ := os.ReadFile(g.file(name))
	return string(data)
}

func (g *gh) write(name, text string) { _ = os.WriteFile(g.file(name), []byte(text), 0o600) }

// flag is the value after name, "" when it is absent.
func (g *gh) flag(name string) string {
	if i := slices.Index(g.args, name); i >= 0 && i+1 < len(g.args) {
		return g.args[i+1]
	}
	return ""
}

func (g *gh) has(arg string) bool { return slices.Contains(g.args, arg) }

// pr is the URL of the open PR, "" when there is none.
func (g *gh) pr() string { return strings.TrimSpace(g.read("pr")) }

// answer is the call's stdout; ok is false for a call it does not know.
func (g *gh) answer() (out string, ok bool) {
	if len(g.args) < 2 {
		return "", false
	}
	a, b := g.args[0], g.args[1]
	switch {
	case a == "auth" && b == "status":
		return "", true
	case a == "repo" && b == "view":
		if g.has(".defaultBranchRef.name") {
			return "main\n", true
		}
		return owner + "\n", g.has(".nameWithOwner")
	case a == "api" && strings.HasPrefix(b, "repos/{owner}/{repo}/pulls/") && g.has("--paginate"):
		return "[]", true
	case a == "pr" && b == "list" && g.flag("--head") != "":
		if pr := g.pr(); pr != "" {
			return `[{"url":"` + pr + `"}]`, true
		}
		return "[]", true
	case a == "pr" && b == "create" && g.has("--draft"):
		n, _ := strconv.Atoi(g.read("count"))
		n++
		g.write("count", strconv.Itoa(n))
		url := fmt.Sprintf("https://github.com/%s/pull/%d", owner, n)
		g.write("pr", url)
		g.write("body", g.readBody(g.flag("--body-file")))
		return url + "\n", true
	case a == "pr" && b == "view":
		switch g.flag("--json") {
		// The base a stacked job starts from.
		case "headRefName":
			return "develop\n", true
		case "body":
			return g.read("body"), true
		case "comments,reviews":
			return `{"comments":[],"reviews":[]}`, true
		}
	case a == "pr" && b == "edit" && g.has("--body-file"):
		g.write("body", g.readBody(g.flag("--body-file")))
		return "", true
	case a == "pr" && b == "edit" && g.has("--title"), a == "pr" && b == "ready":
		return "", true
	case a == "pr" && b == "close":
		_ = os.Remove(g.file("pr"))
		return "", true
	}
	return "", false
}

func (g *gh) readBody(file string) string {
	data, _ := os.ReadFile(file)
	return string(data)
}
