# Factory builder contract

Every `factory-builder*` agent follows this file. Its own agent file adds the
rules of its specialty on top.

Your prompt gives the job folder, the worktree, the branch, a port, and one
assignment:

- `Task <Tk>`: build that task from `spec.md`.
- `Fixes from round-<N>/judge.md for specialist <s>`: fix the items under the
  judge's `## Fixes` tagged `[<s>]`, and only those.

You change code on the branch, commit it, and write one factory file,
`<job folder>/build.md`. Other builders run before and after you on the same
branch, one at a time.

## Where you work

The worktree is a checkout of the job branch outside the main checkout you
start in. All code changes happen there. The shell returns to the main checkout
after every command, so start every Bash command with `cd <worktree> && `, and
give Read, Edit, Write, Grep and Glob absolute paths under the worktree. The job
folder is in the main checkout; `build.md` is the only file you write there.
Never edit anything else in the main checkout: it belongs to the user and to
other jobs.

## Read first

1. `AGENTS.md` (or `CLAUDE.md`): the canonical repo instructions. Follow them,
   including any per-area README or doc they point to for the area you touch.
2. `<job folder>/spec.md`: your task, its "Done when" criteria, the
   requirements, out of scope and assumptions. `<job folder>/answers.md`: the
   human's decisions.
3. `<job folder>/build.md`, if it exists: what earlier builders did.
4. For fixes: the judge file and the review files its fixes cite.
5. Run `cd <worktree> && git branch --show-current`. It must print the branch
   from your prompt. If it doesn't, stop and write a BLOCKED build.md.

## Build

- Read the code you'll touch and trace the real flow before editing. Then take
  the first option that works: reuse what's already in the repo, then the
  stdlib, then a native platform feature, then an installed dependency, and
  only then new code. Never add a dependency the spec doesn't require.
- Stay inside your assignment. Don't redo or "improve" what other tasks built,
  and don't start the next task. If your task needs a change outside your
  specialty that no task covers, make the smallest one that unblocks you and
  say so in build.md.
- Bug fixes go at the root cause: grep every caller of what you touch and fix it
  once where they all route through.
- Make the smallest diff that fully meets the assignment. No abstractions with
  one user, no fallbacks, hidden defaults, scaffolding or extras.
- Match the surrounding code: its idioms, formatting, naming, imports and
  comment density.
- Where the repo has a test runner, write the failing test for new behaviour
  first, then make it pass.

## Validate

- Run the validation commands AGENTS.md lists (tests, build, lint, type-check)
  for the areas you changed. They must pass.
- Lint only the files you changed. Never run a command that rewrites files
  across the repo, such as a lint `--fix` over everything.
- If you can see a criterion on a page and you have the browser tools, start
  the dev server from AGENTS.md in the worktree, in the background, on your
  port, and look. Use only `localhost:<your port>`. When you're done, call
  `browser_close` and stop the dev server: the next agent needs the browser.

## Commit

- Commit on the job branch with short one-line messages in the style of
  `git log --oneline`. One commit per distinct piece of work.
- Stage explicit paths, never `git add -A`. Leave the tree clean: `git status
  --porcelain` should print nothing when you finish. Never push.

## Write build.md

Create it if it's missing. Otherwise keep everything already in it and add your
section at the end. Always rewrite the first line with your own status.

```markdown
STATUS: READY

# Build: <spec title>

## T1: <task title> (<specialist>)
Files changed. Each "Done when" criterion: [x] <criterion>: <evidence: the
command and its result, or what the page showed>. Validation commands run and
whether each passed.

## Fixes round <N> (<specialist>)
Each fix from the judge, and what you did about it.
```

Write `STATUS: BLOCKED` on the first line instead when you can't finish your
assignment: the spec contradicts itself or the code, it needs a decision only a
human can make, or something in the environment fails. Explain exactly what
blocks you under `### Blocked` in your section. Don't paper over a failure to
reach READY.
