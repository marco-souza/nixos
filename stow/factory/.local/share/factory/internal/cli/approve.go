package cli

import (
	"github.com/spf13/cobra"

	"github.com/marco-souza/nixos/stow/factory/internal/app"
)

func newApproveCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "approve <id>",
		Short:   "Accept the PR, or an escalation, and go on",
		Example: "  factory approve " + example,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			repo, err := repoOf(cmd)
			if err != nil {
				return err
			}
			d, err := depsFor(repo, false)
			if err != nil {
				return err
			}
			j, err := app.Approve(ctxOf(cmd), repo, args[0], d)
			if err != nil {
				return err
			}
			cmd.Println(app.Ok("approved " + j.ID + "; the driver goes on with " + string(j.Stage)))
			printNext(cmd, j)
			return nil
		},
	}
}
