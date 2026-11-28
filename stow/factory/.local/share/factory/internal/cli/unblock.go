package cli

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/marco-souza/nixos/stow/factory/internal/app"
)

func newUnblockCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "unblock <id> [--] <decision>…",
		Short:   "Settle what a failed step stopped on; reruns that step",
		Example: `  factory unblock ` + example + ` -- "Use the staging account"`,
		Args:    cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			repo, err := repoOf(cmd)
			if err != nil {
				return err
			}
			d, err := depsFor(repo, false)
			if err != nil {
				return err
			}
			j, err := app.Unblock(ctxOf(cmd), repo, args[0], strings.Join(args[1:], " "), d)
			if err != nil {
				return err
			}
			last := j.Decisions[len(j.Decisions)-1]
			cmd.Println(app.Ok(fmt.Sprintf("sent %s; %s resumes at %s", rel(repo, last), j.ID, j.Stage)))
			printNext(cmd, j)
			return nil
		},
	}
}
