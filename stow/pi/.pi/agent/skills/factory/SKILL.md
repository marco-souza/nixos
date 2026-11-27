---
name: factory
description: Drive the software factory CLI. Use when the user types /factory <feature>, /factory status, or /factory approve|feedback|unblock|run|discard|logs|dashboard <job>. Starts a job that grills the user on requirements, then plans, builds, reviews and validates it into a pull request, or does the work and writes a report when no code is needed; PR feedback starts a new cycle.
---

# Factory

The factory is the `factory` CLI. This skill only runs it and reports back.
Run each command with Bash from the repo the user is in, and report the output
in a few lines. Never edit `.factory/` files by hand.

If `factory` is not found, tell the user to run `./stow.sh stow factory` from
their nixos checkout (you never run it).

| User types | Run |
| --- | --- |
| `/factory <feature>` | `factory new -- "<feature>"`, then the grill below. Add `--base <branch>` or `--stack <PR#>` when the user names a branch or PR to start from |
| `/factory answer <job> [<text>]` | `factory answer <job> -- "<text>"`: resumes a grill (no text shows the pending question) |
| `/factory status` | `factory status` |
| `/factory approve <job>` | `factory approve <job>` |
| `/factory feedback <job> [<note>]` | `factory feedback <job> -- "<note>"` |
| `/factory unblock <job> <decision>` | `factory unblock <job> -- "<decision>"`: settles what a failed or blocked step stopped on, and reruns that step |
| `/factory run <job>` | `factory run <job>` |
| `/factory logs <job> [<role>]` | `factory logs <job> [<role>]` |
| `/factory discard <job>` | confirm with the user first, then `factory discard <job> --yes` |
| `/factory dashboard` | `factory dashboard`, in the background; give the user the URL it prints |

Pass the feature or note as one argument. If it contains double quotes,
`$`, backticks or newlines, write it to a temp file and pass `"$(cat <file>)"`
instead of pasting it into the command.

Never edit `.factory.json` to change one job's base. Lines that start with `!`
or `✗` are warnings and errors: always pass them on, word for word.

## The grill

`factory new` creates the job and prints the first requirements question; each
`factory answer` prints the next. **You relay: the user answers here, in this
chat, and never opens another session.** Never tell them to attach to anything.

1. Run `factory new` (or `factory answer`) with a 15 minute timeout: a turn
   is a model run and takes 1 to 12 minutes. While it runs it prints a
   heartbeat every 30 s (`… <job>: requirements running 2m30s, last: <tool>`).
2. The output ends with `QUESTION for <job>:` and a question (`Why:` and
   numbered `Options:`). Show it to the user word for word, with its `Why:`
   and options, and wait for their reply. Never shorten a playback.
3. Run `factory answer <job> -- "<answer>"`. Repeat from step 2 until the
   output says `requirements written`.
4. Tell the user the job id and that you'll report when it needs them
   (`factory status`).

The answer is the user's, verbatim. Never answer a question yourself. If a turn
fails, report the error line and stop. `factory answer <job>` (no text) shows the
pending question again.

When `factory status` shows a job waiting on `grill` (a design question or PR
feedback sent it back), start the same loop with `factory answer <job>`.

When a job stopped on a failure (a blocked step, a missing access), show the
user the reason. Their decision goes to `factory unblock <job> -- "<decision>"`,
which reruns only that step; `factory feedback` would start a whole new cycle.
