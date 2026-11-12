# Factory builder contract

Every `factory-builder*` agent follows this file. Its own agent file adds the
rules of its specialty on top.

Your prompt gives the job folder, the worktree, the branch, a port, and one
assignment:

- `Task <Tk>`: build that task from `spec.md`.
- `Fixes from round-<N>/judge.md for specialist <s>`: fix the items under the
  judge's `## Fixes` tagged `[<s>]`, and only those.

You change code on the branch, commit it, and write to two places in the job
folder: `<job folder>/build.md` and the proof files in `<job folder>/proof/`. Other builders run before and after you on the same
branch, one at a time.

## Where you work

The worktree is a checkout of the job branch outside the main checkout you
start in. All code changes happen there. The shell returns to the main checkout
after every command, so start every Bash command with `cd <worktree> && `, and
give read, edit, write, grep and find absolute paths under the worktree. The job
folder is in the main checkout; `build.md` and `proof/` are all you write
there. Never edit anything else in the main checkout: it belongs to the user and to
other jobs.

## Read first

1. `AGENTS.md` (or `CLAUDE.md`): the canonical repo instructions. Follow them,
   including any per-area README or doc they point to for the area you touch,
   and the blueprint (the `## Blueprint` section, or the doc it points to).
2. `<job folder>/spec.md`: your task, its `Pattern:` line, its "Done when"
   criteria and their `Proof:` lines, the
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
- Follow the pattern. Open the reference file your task's `Pattern:` line
  names and do the concern the same way: same layers, same helpers, same error
  handling, same test shape. Never add a second way to do something the
  blueprint covers. If the pattern can't work for your task, don't improvise
  one: write BLOCKED and say why.
- No band-aids. When something fails or is slow, find out why before you
  change anything. A cache, retry, timeout, special case, guard or index added
  to make a symptom go away is a band-aid unless you can name the cause it
  addresses. If the real cause sits in code outside your assignment and you
  can still meet your criteria, build on it as it is and report it under
  `### Workarounds`. If you can't meet them without patching around it, write
  BLOCKED.
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
- If you can see a criterion on a page, start the dev server from AGENTS.md in
  the worktree, in the background, on your port, and look. If the `browser_*`
  tools (pi-browser-bridge) are available, open your own tab with
  `browser_create_tab` on `http://localhost:<your port>` and check it with
  `browser_navigate`, `browser_read` and `browser_screenshot`. Only touch that
  tab, and close it when done (`browser_close_tab`). Stop the dev server when
  you're done.

## Prove

The PR must show the human that the work does what the spec says, so every
acceptance criterion in your task's "Done when" needs proof, captured from the
branch as you leave it. The criterion's `Proof:` line says which kind.

- Save it in `<job folder>/proof/` as `ac<k>-<slug>.<ext>`, with `k` the
  criterion's number: `ac2-empty-state.png`, `ac4-tests.txt`. Several files for
  one criterion are fine (desktop and mobile, before and after).
- What a user sees: a screenshot of the page in the state the criterion
  describes, or a recording of the flow (GIF or video) when AGENTS.md says how
  to make one. `browser_screenshot` only shows you the image, it doesn't save a
  file, so make the proof file from the shell: with the screenshot command
  AGENTS.md gives, or else a headless browser on the PATH, for example
  `chromium --headless --screenshot=<file> --window-size=1440,900 <url>`. When
  the state needs clicks or typing to reach, drive it with the repo's
  end-to-end test runner and let that take the screenshot. Look at the file
  with `read` before you count it as proof.
- Everything else: the command and its real, unedited output in a `.txt` file,
  first line `$ <command>`. Keep the part that shows the result.
- Proof is real. Never mock up a page, edit an image or output, or reuse a file
  from before your last change. If you can't capture proof for a criterion,
  say so under `### Blocked` and write BLOCKED.
- Proof gets published with the PR: no secrets, tokens or real personal data in
  it. Use seed or test data.
- For fixes: capture again the proof of every criterion your fix touches, under
  the same file name, so no stale proof is left.

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
Files changed. Pattern followed: <concern>: `<reference file>`. Each "Done
when" criterion: [x] <criterion>: <evidence: the command and its result, or
what the page showed> (proof: `proof/ac<k>-<slug>.<ext>`). Validation commands
run and whether each passed.

### Workarounds
Only if there are any: <path:line> what you built around, the cause you found,
and what a proper fix would change.

## Fixes round <N> (<specialist>)
Each fix from the judge, the cause you found, and what you did about it. The
proof files you captured again.
```

Write `STATUS: BLOCKED` on the first line instead when you can't finish your
assignment: the spec contradicts itself or the code, it needs a decision only a
human can make, or something in the environment fails. Explain exactly what
blocks you under `### Blocked` in your section. Don't paper over a failure to
reach READY.
