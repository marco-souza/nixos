package proc

import (
	"context"
	"fmt"
	"io"
	"strings"
)

var osascriptEscaper = strings.NewReplacer(`\`, `\\`, `"`, `\"`)

// Notify tells the human a job needs them: the OS notifier, then the
// terminal bell. Every channel is best effort and Notify never errors.
func Notify(ctx context.Context, run Runner, goos string, bell io.Writer, title, msg string) {
	switch goos {
	case "darwin":
		script := fmt.Sprintf(`display notification "%s" with title "%s"`,
			osascriptEscaper.Replace(msg), osascriptEscaper.Replace(title))
		_, _ = run.Run(ctx, []string{"osascript", "-e", script}, Opts{})
	case "linux":
		_, _ = run.Run(ctx, []string{"notify-send", "--", title, msg}, Opts{})
	}
	_, _ = io.WriteString(bell, "\x07")
}
