---
name: factory
description: Drive the software factory CLI. Use when the user types /factory <feature>, /factory status, or /factory approve|feedback|run|discard|logs|dashboard <job>. Starts a job that grills the user on requirements, then plans, builds, reviews and validates it into a pull request; PR feedback starts a new cycle.
---

# Factory

The factory is the `factory` CLI. This skill only runs it and reports back.
Run each command with Bash from the repo the user is in, and report the output
in a few lines. Never edit `.factory/` files by hand.

If `factory` is not found, tell the user to run `./stow.sh stow factory` from
their nixos checkout (you never run it).

| User types | Run |
| --- | --- |
| `/factory <feature>` | `factory new --no-attach -- "<feature>"`, then the attach step below |
| `/factory status` | `factory status` |
| `/factory approve <job>` | `factory approve <job>` |
| `/factory feedback <job> [<note>]` | `factory feedback <job> -- "<note>"` |
| `/factory run <job>` | `factory run <job>` |
| `/factory logs <job> [<role>]` | `factory logs <job> [<role>]` |
| `/factory discard <job>` | confirm with the user first, then `factory discard <job> --yes` |
| `/factory dashboard` | `factory dashboard`, in the background; give the user the URL it prints |

Pass the feature or note as one argument. If it contains double quotes,
`$`, backticks or newlines, write it to a temp file and pass `"$(cat <file>)"`
instead of pasting it into the command.

`factory new` prints the job id. The job starts with a requirements grill that
the user answers in the job's tmux session.

Then tell the user to run `! factory attach <id>` to answer the grill.
