package cli

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/marco-souza/nixos/stow/factory/internal/app"
	"github.com/marco-souza/nixos/stow/factory/internal/machine"
	"github.com/marco-souza/nixos/stow/factory/internal/ui"
)

func newDiscardCmd() *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:     "discard <id> [--yes]",
		Short:   "Close the PR, delete the branch and worktree",
		Example: "  factory discard " + example,
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
			id := args[0]
			if !yes {
				j, err := app.Find(repo, id)
				if err != nil {
					return err
				}
				// Agents run commands without a terminal: no one there could have said yes.
				if !stdinIsTerminal() {
					return &machine.CommandError{Msg: fmt.Sprintf("refusing to discard %s without --yes (no terminal to confirm)", id)}
				}
				what := "deletes"
				if j.PR != "" {
					what = "closes PR " + ui.PRNumber(j.PR) + " and deletes"
				}
				if !confirm(cmd, fmt.Sprintf("Discard %s? This %s %s and its worktree. [y/N] ", id, what, j.Branch)) {
					cmd.Println("Kept " + id + ".")
					return ErrReported
				}
			}
			_, err = app.Discard(ctxOf(cmd), repo, id, d)
			return err
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "discard without asking")
	return cmd
}

// confirm asks a y/N question on the terminal.
func confirm(cmd *cobra.Command, question string) bool {
	_, _ = fmt.Fprint(cmd.ErrOrStderr(), question)
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true
	}
	return false
}
