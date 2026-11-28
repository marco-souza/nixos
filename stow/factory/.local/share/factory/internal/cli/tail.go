package cli

import (
	"errors"
	"os"

	"github.com/spf13/cobra"

	"github.com/marco-souza/nixos/stow/factory/internal/config"
	"github.com/marco-souza/nixos/stow/factory/internal/tail"
)

// newTailCmd is used by the run scripts, not by humans: it formats an agent's
// JSON stream from stdin.
func newTailCmd() *cobra.Command {
	var format string
	cmd := &cobra.Command{
		Use:    "tail --format claude|pi",
		Short:  "Format an agent's output stream",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			h := config.Harness(format)
			if h != config.Claude && h != config.Pi {
				return errors.New("usage: factory tail --format claude|pi")
			}
			return tail.Run(os.Stdin, cmd.OutOrStdout(), h, tail.Width())
		},
	}
	cmd.Flags().StringVar(&format, "format", "", "claude or pi")
	return cmd
}
