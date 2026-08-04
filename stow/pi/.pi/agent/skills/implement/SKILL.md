---
name: implement
description: >
  Directly implement a feature or fix without tasks.json orchestration.
  Use when: the task is simple (single file, config change, straightforward feature),
  or when there is no tasks.json and the user wants to start coding immediately.
  Do NOT use when: there is a tasks.json (use implement-tasks instead),
  or when requirements are unclear (use grill-with-docs first).
---

# Implement (Direct)

Implement code directly without orchestrator subagents. For simple tasks that don't need the full `implement-tasks` pipeline.

## When to Use

- Simple, self-contained changes (single file, config, script)
- No `tasks.json` exists and the user wants to code now
- Quick fixes or straightforward features
- Prototyping or experimentation

## When NOT to Use

- Complex multi-file features → Use `implement-tasks` with `tasks.json`
- Requirements unclear → Use `grill-with-docs` first
- Multiple interdependent tasks → Use `prd-to-tasks` then `implement-tasks`

## Workflow

### 1. Understand the Task

- What exactly needs to be implemented?
- What files are affected?
- Are there dependencies or constraints?

### 2. Research (Optional but Recommended)

```bash
/skill:research
```

Gather context before coding:

- Existing patterns in the codebase
- Related implementations
- Documentation or examples

### 3. Clarify if Needed

```bash
/skill:clarify
```

If anything is ambiguous, ask before coding.

### 4. Implement

Write the code directly:

- Follow existing code style and patterns
- Keep changes minimal and focused
- Add comments where complex logic exists
- Update documentation if needed

### 5. Verify

- Test the implementation
- Check for edge cases
- Ensure no regressions
- Run linters/tests if available

### 6. Commit

Use appropriate commit format:

```bash
git add .
git commit -m "feat: implement [description]"
```

## Example

```text
User: Add a helper function to parse CLI arguments

Agent:
1. Reads existing CLI parsing code
2. Understands the pattern used
3. Implements the function
4. Adds tests
5. Commits
```

## vs implement-tasks

| Aspect        | implement    | implement-tasks     |
| ------------- | ------------ | ------------------- |
| Complexity    | Simple tasks | Complex projects    |
| Orchestration | Direct       | Subagent-based      |
| Planning      | Ad-hoc       | tasks.json required |
| Parallelism   | Sequential   | Wave-based parallel |
| Monitoring    | Manual       | Status tracking     |
| Best for      | Quick fixes  | Multi-day projects  |

## Collaboration

- **grill-with-docs** → Requirements (before this skill)
- **prd-to-tasks** → Planning (for complex projects)
- **implement-tasks** → Orchestration (for complex projects)
- **research** → Context gathering (optional, before coding)
