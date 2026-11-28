package cli

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/marco-souza/nixos/stow/factory/internal/app"
)

func newFeedbackCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "feedback <id> [--] [<note>…]",
		Short:   "Send new PR comments and a note; new cycle",
		Example: `  factory feedback ` + example + ` -- "Count per IP"`,
		Args:    cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			repo, err := repoOf(cmd)
			if err != nil {
				return err
			}
			d, err := depsFor(repo, false)
			if err != nil {
				return err
			}
			j, err := app.Feedback(ctxOf(cmd), repo, args[0], strings.Join(args[1:], " "), d)
			if err != nil {
				return err
			}
			cmd.Println(app.Ok(fmt.Sprintf("sent %s; cycle %d starts at %s", rel(repo, j.ReasonFile), j.Cycle, j.Stage)))
			printNext(cmd, j)
			return nil
		},
	}
}
