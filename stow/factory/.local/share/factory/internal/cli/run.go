package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/marco-souza/nixos/stow/factory/internal/app"
	"github.com/marco-souza/nixos/stow/factory/internal/driver"
)

func newRunCmd() *cobra.Command {
	var o app.RunOptions
	cmd := &cobra.Command{
		Use:     "run <id> [--inline]",
		Short:   "(Re)start the driver; retries a failed step",
		Example: "  factory run " + example,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			repo, err := repoOf(cmd)
			if err != nil {
				return err
			}
			// --here is the background driver itself: its agents run in the background.
			d, err := depsFor(repo, o.Inline && !o.Here)
			if err != nil {
				return err
			}
			id := args[0]
			out, err := app.Run(ctxOf(cmd), repo, id, o, d)
			if err != nil {
				if isCommandError(err) && out.Job.ID != "" {
					// A refused retry: say why, then what to type.
					_, _ = fmt.Fprintln(cmd.ErrOrStderr(), paint(cmd.ErrOrStderr(), "31", "factory: "+err.Error()))
					printNext(cmd, out.Job)
					return ErrReported
				}
				return err
			}
			switch {
			case out.Driven && out.Result == driver.Discarded:
				cmd.Println(id + ": discarded")
			case out.Driven:
			default:
				if out.Retried {
					cmd.Println(fmt.Sprintf("%s: retrying from %s", id, out.Job.Stage))
				}
				if out.Started {
					cmd.Println(app.Ok("driver started in the background (log: .factory/jobs/" + id + "/logs/driver.log)"))
				}
				printNext(cmd, out.Job)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&o.Inline, "inline", false, "drive the job in this process, agents included")
	cmd.Flags().BoolVar(&o.Here, "here", false, "the background driver's own command")
	_ = cmd.Flags().MarkHidden("here")
	return cmd
}
