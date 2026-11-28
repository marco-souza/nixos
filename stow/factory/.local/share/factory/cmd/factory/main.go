// Command factory turns a feature request into a reviewed pull request.
package main

import (
	"context"
	"os"

	"github.com/marco-souza/nixos/stow/factory/internal/cli"
)

func main() {
	os.Exit(cli.Execute(context.Background(), os.Args[1:], os.Stdout, os.Stderr))
}
