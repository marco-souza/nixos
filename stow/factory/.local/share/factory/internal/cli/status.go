package cli

import (
	"time"

	"github.com/spf13/cobra"

	"github.com/marco-souza/nixos/stow/factory/internal/app"
)

func newStatusCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:     "status [<id>] [--json]",
		Short:   "Every job and what it needs; or one job",
		Example: "  factory status " + example,
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			repo, err := repoOf(cmd)
			if err != nil {
				return err
			}
			id := ""
			if len(args) == 1 {
				id = args[0]
			}
			out, err := app.Status(repo, id, asJSON, time.Now())
			if err != nil {
				return err
			}
			cmd.Println(out)
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print the jobs as JSON, with hint and whatFor")
	return cmd
}
