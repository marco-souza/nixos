// Package config loads the factory's settings: built-in defaults with the
// repo's .factory.json merged over them.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// Harness is the agent CLI a job runs on.
type Harness string

// The harnesses a job can run on.
const (
	Claude Harness = "claude"
	Pi     Harness = "pi"
)

// Tier is a role's model and timeout class.
type Tier string

// The tiers a role can have.
const (
	High   Tier = "high"
	Medium Tier = "medium"
	Low    Tier = "low"
)

var (
	harnesses = []Harness{Claude, Pi}
	tiers     = []Tier{High, Medium, Low}

	// KnownValidators are the validator roles a config may list.
	KnownValidators = []string{"e2e", "user", "load", "capacity"}
)

// RoleOverride changes one role's tier or timeout.
type RoleOverride struct {
	Tier       Tier `json:"tier,omitempty"`
	TimeoutMin int  `json:"timeoutMin,omitempty"`
}

// Hooks are the repo's shell hooks.
type Hooks struct {
	PROpened string `json:"prOpened,omitempty"`
	QAURL    string `json:"qaUrl,omitempty"`
	QAReady  string `json:"qaReady,omitempty"`
}

// Config is the merged settings. An empty Base means origin's default
// branch; an empty PRTitle means the summarizer follows the repo's PR rules.
type Config struct {
	Base              string                      `json:"base"`
	PRTitle           string                      `json:"prTitle"`
	Setup             []string                    `json:"setup"`
	Hooks             Hooks                       `json:"hooks"`
	Validators        []string                    `json:"validators"`
	Roles             map[string]RoleOverride     `json:"roles"`
	DefaultHarness    Harness                     `json:"defaultHarness"`
	Models            map[Harness]map[Tier]string `json:"models"`
	TimeoutsMin       map[Tier]int                `json:"timeoutsMin"`
	MaxTrips          int                         `json:"maxTrips"`
	MaxDiscoveryLoops int                         `json:"maxDiscoveryLoops"`
	QAReadyTimeoutMin int                         `json:"qaReadyTimeoutMin"`
	QAPollSec         int                         `json:"qaPollSec"`
}

// Defaults is the config of a repo with no .factory.json.
func Defaults() Config {
	return Config{
		Setup:          []string{},
		Validators:     []string{"e2e", "user"},
		Roles:          map[string]RoleOverride{},
		DefaultHarness: Claude,
		Models: map[Harness]map[Tier]string{
			Claude: {High: "opus", Medium: "sonnet", Low: "haiku"},
			Pi:     {},
		},
		TimeoutsMin:       map[Tier]int{High: 45, Medium: 30, Low: 15},
		MaxTrips:          3,
		MaxDiscoveryLoops: 3,
		QAReadyTimeoutMin: 20,
		QAPollSec:         15,
	}
}

// Load merges <repo>/.factory.json over Defaults. Unknown keys and unknown
// values fail, with the file's path in the message.
func Load(repo string) (Config, error) {
	file := filepath.Join(repo, ".factory.json")
	raw, err := json.Marshal(Defaults())
	if err != nil {
		return Config{}, err
	}
	var merged any
	if err := json.Unmarshal(raw, &merged); err != nil {
		return Config{}, err
	}

	data, err := os.ReadFile(file)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return Config{}, fmt.Errorf("%s: %w", file, err)
	default:
		var over any
		if err := json.Unmarshal(data, &over); err != nil {
			return Config{}, fmt.Errorf("%s: %w", file, err)
		}
		if _, ok := over.(map[string]any); !ok {
			return Config{}, fmt.Errorf("%s: expected a JSON object", file)
		}
		merged = merge(merged, over)
	}

	// Merge the raw objects first: decoding the repo file over a filled struct
	// would replace a whole map element instead of merging into it.
	raw, err = json.Marshal(merged)
	if err != nil {
		return Config{}, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var cfg Config
	if err := dec.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("%s: %w", file, err)
	}
	if err := cfg.validate(); err != nil {
		return Config{}, fmt.Errorf("%s: %w", file, err)
	}
	return cfg, nil
}

// merge recurses into objects present on both sides. Anything else from over
// (arrays, scalars, null) replaces base.
func merge(base, over any) any {
	b, bok := base.(map[string]any)
	o, ook := over.(map[string]any)
	if !bok || !ook {
		return over
	}
	out := make(map[string]any, len(b))
	for k, v := range b {
		out[k] = v
	}
	for k, v := range o {
		if bv, ok := b[k]; ok {
			out[k] = merge(bv, v)
		} else {
			out[k] = v
		}
	}
	return out
}

func (c Config) validate() error {
	for _, v := range c.Validators {
		if !slices.Contains(KnownValidators, v) {
			return fmt.Errorf("unknown validator %q (known: %s)", v, strings.Join(KnownValidators, ", "))
		}
	}
	if !slices.Contains(harnesses, c.DefaultHarness) {
		return fmt.Errorf("unknown defaultHarness %q (known: %s)", c.DefaultHarness, joinNames(harnesses))
	}
	for h, byTier := range c.Models {
		if !slices.Contains(harnesses, h) {
			return fmt.Errorf("unknown harness %q in models (known: %s)", h, joinNames(harnesses))
		}
		for t := range byTier {
			if err := checkTier(t); err != nil {
				return err
			}
		}
	}
	for t := range c.TimeoutsMin {
		if err := checkTier(t); err != nil {
			return err
		}
	}
	for _, r := range c.Roles {
		if r.Tier != "" {
			if err := checkTier(r.Tier); err != nil {
				return err
			}
		}
	}
	return nil
}

func checkTier(t Tier) error {
	if !slices.Contains(tiers, t) {
		return fmt.Errorf("unknown tier %q (known: %s)", t, joinNames(tiers))
	}
	return nil
}

func joinNames[T ~string](xs []T) string {
	s := make([]string, len(xs))
	for i, x := range xs {
		s[i] = string(x)
	}
	return strings.Join(s, ", ")
}
