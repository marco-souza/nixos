package cli

import (
	"strings"

	"github.com/spf13/cobra"

	"github.com/marco-souza/nixos/stow/factory/internal/app"
)

func newAnswerCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "answer <id> [--] [<text>…]",
		Short:   "Answer the pending grill question; prints the next one",
		Example: `  factory answer ` + example + ` -- "Count per IP"`,
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
			var answer *string
			if len(args) > 1 {
				text := strings.Join(args[1:], " ")
				answer = &text
			}
			r, err := app.Answer(ctxOf(cmd), repo, args[0], answer, inline, bg)
			if err != nil {
				return err
			}
			printReply(cmd, args[0], r)
			return nil
		},
	}
}
