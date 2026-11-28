// Package cli holds the cobra commands: parse flags, call the app, print.
package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"
)

// ErrReported means the error was already printed: exit 1 without printing.
var ErrReported = errors.New("reported")

// Execute runs the CLI and returns the process exit code.
func Execute(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	root := newRoot(stdout, stderr)
	root.SetArgs(args)
	if err := root.ExecuteContext(ctx); err != nil {
		if !errors.Is(err, ErrReported) {
			_, _ = fmt.Fprintln(stderr, paint(stderr, "31", "factory: "+err.Error()))
		}
		return 1
	}
	return 0
}

func newRoot(stdout, stderr io.Writer) *cobra.Command {
	// Help lists the commands in the order they are used, not A to Z.
	cobra.EnableCommandSorting = false
	root := &cobra.Command{
		Use:           "factory",
		Short:         "Turn a feature request into a reviewed pull request",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.SetOut(stdout)
	root.SetErr(stderr)
	root.PersistentFlags().String("repo", "", "the repo to work on (default: the current one)")
	root.AddCommand(
		newNewCmd(), newAnswerCmd(), newStatusCmd(), newLogsCmd(), newApproveCmd(), newFeedbackCmd(),
		newUnblockCmd(), newRunCmd(), newDiscardCmd(), newTailCmd(),
	)
	return root
}

// paint wraps s in an ANSI color, unless NO_COLOR is set or w is not a terminal.
func paint(w io.Writer, code, s string) string {
	if !useColor(w) {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func useColor(w io.Writer) bool {
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	if os.Getenv("FORCE_COLOR") != "" {
		return true
	}
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}
