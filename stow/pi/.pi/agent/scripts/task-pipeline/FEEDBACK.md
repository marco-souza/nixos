# task-pipeline — user feedback

From a real session: I generated `tasks.json` following the `prd-to-tasks`
SKILL.md, then ran `validate` against it. Hit one hard crash and several
friction points. Below is what actually happened, ordered by severity, each
with a repro and a concrete fix.

All line references are to this tree at the time of writing.

---

## 🔴 P0 — `validate` crashes instead of validating when `agents` is missing

This is the headline issue. The CLI advertises itself as "production-grade" with
clean exit codes and a documented error format, but the single most common
malformed input — a `tasks.json` built from the `prd-to-tasks` SKILL.md format
(which does **not** document a top-level `agents` key — see P1) — bypasses all
nine checks and hits the catch-all in `src/cli.ts`:

```
✗ All tasks have required fields
✗ T001 missing required field: 'agent'
…
✗ All agent assignments are consistent
  ✗ Unexpected error: Object.entries requires that input parameter not be null or undefined
```

**Repro:**
```bash
printf '{"$schema":"tasks/v1","metadata":{},"phases":{},"tasks":[]}' > /tmp/x.json
bun src/cli.ts validate /tmp/x.json
# → "Unexpected error: Object.entries requires…"  (exit 1, no other checks run after)
```

**Root cause** — `src/lib/tasks-lib.ts:440`:
```ts
export function computeStats(data: TasksData): TaskStats {
  const { tasks, phases, agents } = data;        // agents is undefined
  …
  for (const [name, a] of Object.entries(agents)) {   // 💥 TypeError
```
`loadTasks` only does `as TasksData` — no shape coercion — so `agents: undefined`
passes straight through to `computeStats` / `validateAgents`
(`src/commands/validate.ts:98`), both of which `Object.entries(agents)` without
a guard. Worse, `validateAgents` runs *as one of the nine checks*, so the crash
happens mid-loop and aborts the rest of the report.

**Fix (smallest):** guard `agents` everywhere it's destructured, and make a
missing `agents` a first-class validation error, not a 500.

In `validate.ts`:
```ts
function validateTopLevel(data: TasksData): string[] {
  const errors: string[] = [];
  if (!Array.isArray(data.tasks)) errors.push("Missing or non-array top-level 'tasks'");
  if (!data.phases || typeof data.phases !== "object") errors.push("Missing top-level 'phases'");
  if (!data.agents || typeof data.agents !== "object") errors.push("Missing top-level 'agents'");
  return errors;
}
```
Register it as **check #0**, before anything iterates. Also, in `computeStats`
and `validateAgents`, default `agents ?? {}`.

That alone turns a crash into a one-line actionable error.

---

## 🔴 P0 — the `prd-to-tasks` SKILL and `validate` disagree on the schema

The skill that *produces* `tasks.json` and the tool that *validates* it are out
of sync. I followed the SKILL.md format to the letter and the validator rejected
the output.

The `prd-to-tasks` SKILL.md `tasks.json Format` block documents these per-task
fields: `id, title, description, phase, priority, estimatedHours, dependencies,
acceptanceCriteria`. It shows **no** `agent`, **no** `moeExperts`, and **no**
top-level `agents` map.

But `validate` (`src/commands/validate.ts:45`) requires:
```ts
const required = ["id","title","description","phase","priority",
  "estimatedHours","dependencies","agent","moeExperts","acceptanceCriteria"];
```
and `validateAgents` requires a top-level `agents` map with a `tasks: string[]`
per agent.

So every `tasks.json` produced from the skill's own template fails validation.
The error points the user at the skill; the validator rejects the skill's
output. That's the worst possible loop.

**Fix (pick one, do it once):**

1. **Make `agent` / `moeExperts` / `agents` optional with sensible defaults.**
   `agent` defaults to `"default"`; `moeExperts` defaults to `[]`; a missing
   `agents` map defaults to `{ default: { role: "default", tasks: [...all ids] } }`.
   This matches how people actually use small plans (one agent, no MoE) and
   unblocks the SKILL.md format as-written. Lowest churn, best DX.

2. **Or** update the `prd-to-tasks` SKILL.md format to include `agent`,
   `moeExperts`, and `agents`, and regenerate its example. Either way the two
   documents must agree.

Either fix is small; the point is to **reconcile** them, not pick a winner
silently. I'd ship #1 (defaults) because it's back-compatible and removes
ceremony for the 90% single-agent case.

---

## 🟠 P1 — `moeExperts` is forced ceremony for projects that don't use MoE

`moeExperts: string[]` is required on every task. My plan has no mixture-of-
experts phase, so I wrote `"moeExperts": []` nine times. That's nine lines of
boilerplate satisfying a field coupled to one specific skill's workflow.

**Fix:** make it optional (default `[]`). The `prompts` command already handles
the "no experts" case gracefully (it only emits the "EXPERT PERSPECTIVES" block
when the array is non-empty — `src/commands/prompts.ts`), so the validator is
stricter than the consumer. Align them.

---

## 🟠 P1 — `--json` can't report errors

`--json` is advertised for scripting, but `validate` exits 1 *before* reaching
`printJson` when any check fails (`src/commands/validate.ts:194`):
```ts
if (!allPassed) process.exit(1);
if (flags["--json"]) printJson(data);
```
So a script calling `task-pipeline validate --json` gets human-readable stderr
and no machine-readable error document on the failure path — exactly the path
where a script most needs structured output.

**Fix:**
```ts
if (!allPassed) {
  if (flags["--json"]) {
    console.log(JSON.stringify({ valid: false, errors: allErrors }, null, 2));
  }
  process.exit(1);
}
```
Collect `allErrors` as the checks run. Now `--json` round-trips both ways.

---

## 🟡 P2 — no JSON Schema, so the `$schema` field is decorative

My file opened with `"$schema": "tasks/v1"`, which resolves to nothing. There's
no `tasks.schema.json` in the package and no `"tasks/v1"` URI. The TS interface
in `tasks-lib.ts` is the de-facto schema, but it can drift from `validate` (and
has — see P0 #2).

**Fix:** ship a real `schema/tasks.schema.json` and have `validate` optionally
load it. Better: generate it from the TS types (e.g. `ts-json-schema-generator`
or hand-rolled) so `Task`, `TasksData`, and the validator can't diverge. Then
`$schema` becomes meaningful and editors can autocomplete `tasks.json`.

---

## 🟡 P2 — no `init` / `--fix` to recover from drift

When the validator rejected my file, the only path forward was to read the
fixtures and source to reverse-engineer the required shape. A `validate --fix`
that fills `agent: "default"`, `moeExperts: []`, and a default `agents` map
would have unblocked me in one command — and would *also* be the natural
release valve the next time the schema and the skill drift apart.

**Fix:** add a `--fix` flag to `validate` (or an `init` command) that applies
the defaults from P0 #1 / P1 in place. Trivial to implement once defaults exist.

---

## 🟢 P3 — nits

- **`findTasksJson` walks up 10 dirs silently.** Fine, but a `--verbose` line
  ("found tasks.json at /path/…") would save a confused user one `strace`.
- **`criticalPath` uses `best!` (`tasks-lib.ts:351`).** Non-null assertion after
  a loop that can leave `best` null only if a task has `dependencies` all
  referring to non-existent IDs — which `validateDependencies` already catches
  upstream. Safe today, but the `!` is load-bearing on an invariant enforced
  elsewhere; a one-line guard `best ?? { hours: task.estimatedHours, path: [tid] }`
  makes it local and survives reordering of checks.
- **README "Data Model" already shows `agent` / `moeExperts` / `agents`** — so
  the README is correct, but the *skill that generates the file* isn't. The
  README and the validator agree; the generator is the odd one out. Worth a
  cross-link from the skill to the README's Data Model section.

---

## What was good

Credit where due — the stuff that worked, so the fixes above are targeted:

- **`parseArgs` is genuinely nice.** `--flag=value` and `--flag value` both
  work, `-h/--help` is implicit, unknown flags die with a clear message. Clean.
- **`--summary` / `--topo` / `--waves`** output is exactly the feedback loop a
  planner wants; once my file validated, the three flags together gave me the
  whole plan shape in one command.
- **`detectCycles` + `topologicalSort` + `computeWaves`** are well-factored
  pure functions in `tasks-lib.ts`; easy to reuse, easy to test. The library
  API separation (pure logic vs. CLI) is clean.
- **Exit codes + `--quiet`** work correctly on the happy path — scriptable.

---

## TL;DR / suggested order

1. Guard `agents` and add a "missing top-level key" check *(P0, ~10 lines —
   stops the crash).*
2. Reconcile `prd-to-tasks` SKILL.md with `validate` — make `agent`/
   `moeExperts`/`agents` optional with defaults *(P0, unblocks the documented
   workflow).*
3. Make `--json` emit errors *(P1).*
4. Ship a real JSON Schema + optional `--fix` *(P2, prevents future drift).*

(1) and (2) are each under an hour and remove the worst papercuts I hit.