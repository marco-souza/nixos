package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func write(t *testing.T, content string) string {
	t.Helper()
	repo := t.TempDir()
	if err := os.WriteFile(filepath.Join(repo, ".factory.json"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return repo
}

func TestLoad(t *testing.T) {
	t.Run("no file gives the defaults", func(t *testing.T) {
		got, err := Load(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, Defaults()) {
			t.Errorf("got %+v, want defaults", got)
		}
	})

	t.Run("a partial models key keeps the other defaults", func(t *testing.T) {
		got, err := Load(write(t, `{"models":{"claude":{"low":"x"}}}`))
		if err != nil {
			t.Fatal(err)
		}
		want := map[Tier]string{Low: "x", Medium: "sonnet", High: "opus"}
		if !reflect.DeepEqual(got.Models[Claude], want) {
			t.Errorf("claude models = %v, want %v", got.Models[Claude], want)
		}
	})

	t.Run("a partial timeoutsMin and one hook keep the rest", func(t *testing.T) {
		got, err := Load(write(t, `{"timeoutsMin":{"high":99},"hooks":{"qaUrl":"echo url"}}`))
		if err != nil {
			t.Fatal(err)
		}
		if want := (map[Tier]int{High: 99, Medium: 30, Low: 15}); !reflect.DeepEqual(got.TimeoutsMin, want) {
			t.Errorf("timeoutsMin = %v, want %v", got.TimeoutsMin, want)
		}
		if want := (Hooks{QAURL: "echo url"}); got.Hooks != want {
			t.Errorf("hooks = %+v, want %+v", got.Hooks, want)
		}
	})

	t.Run("validators replaces the array", func(t *testing.T) {
		got, err := Load(write(t, `{"validators":["load"]}`))
		if err != nil {
			t.Fatal(err)
		}
		if want := []string{"load"}; !reflect.DeepEqual(got.Validators, want) {
			t.Errorf("validators = %v, want %v", got.Validators, want)
		}
	})

	t.Run("a null base gives an empty base", func(t *testing.T) {
		got, err := Load(write(t, `{"base":"develop"}`))
		if err != nil || got.Base != "develop" {
			t.Fatalf("base = %q, err = %v", got.Base, err)
		}
		got, err = Load(write(t, `{"base":null}`))
		if err != nil || got.Base != "" {
			t.Fatalf("base = %q, err = %v", got.Base, err)
		}
	})

	t.Run("role overrides load", func(t *testing.T) {
		got, err := Load(write(t, `{"roles":{"designer":{"tier":"low","timeoutMin":5}}}`))
		if err != nil {
			t.Fatal(err)
		}
		if want := (RoleOverride{Tier: Low, TimeoutMin: 5}); got.Roles["designer"] != want {
			t.Errorf("designer = %+v, want %+v", got.Roles["designer"], want)
		}
	})

	failures := []struct {
		name, json, want string
	}{
		{"docs is an unknown field", `{"docs":{}}`, `unknown field "docs"`},
		{"docsCommitType is an unknown field", `{"docsCommitType":"docs"}`, `unknown field "docsCommitType"`},
		{"a role harness is an unknown field", `{"roles":{"designer":{"harness":"pi"}}}`, `unknown field "harness"`},
		{"an unknown validator", `{"validators":["e2e","nope"]}`, `unknown validator "nope" (known: e2e, user, load, capacity)`},
		{"a bad defaultHarness", `{"defaultHarness":"gpt"}`, `unknown defaultHarness "gpt" (known: claude, pi)`},
		{"a bad role tier", `{"roles":{"designer":{"tier":"huge"}}}`, `unknown tier "huge"`},
		{"a non-object file", `[]`, `expected a JSON object`},
		{"invalid JSON", `{`, `unexpected end of JSON input`},
	}
	for _, tc := range failures {
		t.Run(tc.name, func(t *testing.T) {
			repo := write(t, tc.json)
			_, err := Load(repo)
			if err == nil {
				t.Fatal("want an error")
			}
			if file := filepath.Join(repo, ".factory.json"); !strings.HasPrefix(err.Error(), file+": ") {
				t.Errorf("error %q does not start with the file path", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not contain %q", err, tc.want)
			}
		})
	}
}
