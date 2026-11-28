package cli

import (
	"github.com/spf13/cobra"

	"github.com/marco-souza/nixos/stow/factory/internal/app"
)

func newLogsCmd() *cobra.Command {
	var follow bool
	cmd := &cobra.Command{
		Use:     "logs <id> [<role>] [-f]",
		Short:   "An agent's log (default: the latest)",
		Example: "  factory logs " + example + " planner -f",
		Args:    cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			repo, err := repoOf(cmd)
			if err != nil {
				return err
			}
			d, err := depsFor(repo, false)
			if err != nil {
				return err
			}
			role := ""
			if len(args) == 2 {
				role = args[1]
			}
			return app.Logs(ctxOf(cmd), repo, args[0], role, follow, cmd.OutOrStdout(), d)
		},
	}
	cmd.Flags().BoolVarP(&follow, "follow", "f", false, "keep printing until the agent is done")
	return cmd
}
