package cli

import (
	"strings"

	"github.com/spf13/cobra"

	"github.com/marco-souza/nixos/stow/factory/internal/app"
	"github.com/marco-souza/nixos/stow/factory/internal/config"
)

func newNewCmd() *cobra.Command {
	var base, stack, harness string
	cmd := &cobra.Command{
		Use:     `new [--base <branch> | --stack <PR#>] [--harness claude|pi] [--] <feature>…`,
		Short:   "Start a job; prints the first grill question",
		Example: `  factory new --stack 123 -- "Rate limit the signup form"`,
		Args:    cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			repo, err := repoOf(cmd)
			if err != nil {
				return err
			}
			inline, err := depsFor(repo, true)
			if err != nil {
				return err
			}
			bg, err := depsFor(repo, false)
			if err != nil {
				return err
			}
			o := app.NewOptions{Base: base, Stack: stack, Harness: config.Harness(harness)}
			r, err := app.New(ctxOf(cmd), repo, strings.Join(args, " "), o, inline, bg)
			if err != nil {
				return err
			}
			printReply(cmd, r.Job.ID, r)
			return nil
		},
	}
	cmd.Flags().StringVar(&base, "base", "", "the branch to start from and open the PR against")
	cmd.Flags().StringVar(&stack, "stack", "", "an open PR (number or URL) whose branch is the base")
	cmd.Flags().StringVar(&harness, "harness", "", "the harness every role runs on: claude or pi (default: the config's)")
	cmd.MarkFlagsMutuallyExclusive("base", "stack")
	return cmd
}
