# AGENTS.md - Pi Agent Guidelines

## Pi Skills Collaboration (Feynman Technique)

### Philosophy

All skills follow the **Feynman Technique**: if you can't explain it simply, you don't understand it yet. This ensures deep understanding before implementation.

### Available Skills

| Skill                 | Command                    | Purpose                                       | Output          |
| --------------------- | -------------------------- | --------------------------------------------- | --------------- |
| **research**          | `/skill:research`          | Explore codebases, search web, gather context | `RESEARCH.md`   |
| **brainstorm**        | `/skill:brainstorm`        | Generate creative ideas, explore alternatives | `BRAINSTORM.md` |
| **grill-with-docs**   | `/skill:grill-with-docs`   | Relentless interview + docs (CONTEXT.md, ADRs, PRD.md) | `PRD.md` |
| **clarify**           | `/skill:clarify`           | Quick clarifications on specific points       | Inline answers  |
| **prd-to-tasks**      | `/skill:prd-to-tasks`      | Break PRD into executable tasks               | `tasks.json`    |
| **implement**         | `/skill:implement`         | Direct implementation for simple tasks        | Code            |
| **implement-tasks**   | `/skill:implement-tasks`   | Execute tasks.json respecting dependencies    | Code            |
| **review**            | `/skill:review`            | Code review for quality and security          | Review Report   |
| **quality-assurance** | `/skill:quality-assurance` | Testing and validation                        | QA Report       |

### Recommended Workflow

```text
┌─────────────────────────────────────────────────────────────────┐
│ 1. /skill:research     →  Understand codebase & context         │
│           ↓                                                     │
│ 2. /skill:brainstorm   →  Generate solution ideas               │
│           ↓                                                     │
│ 3. /skill:grill-with-docs →  Deep requirements discovery + docs │
│           ↓                                                     │
│ 4. /skill:clarify      →  Resolve specific questions            │
│           ↓                                                     │
│ 5. Human approves PRD                                        │
│           ↓                                                     │
│ 6. /skill:prd-to-tasks →  Create tasks.json (complex projects)  │
│           ↓                                                     │
│ 7. /skill:implement    →  Code directly (simple tasks)          │
│   OR /skill:implement-tasks → Execute tasks.json (complex)      │
│           ↓                                                     │
│ 8. /skill:review       →  Code review                          │
│ 9. /skill:quality-assurance → Testing & validation              │
└─────────────────────────────────────────────────────────────────┘
```

### Skill Details

#### `/skill:research`

- Explores project structure and patterns
- Searches web for documentation and best practices
- Uses Feynman check: "Can you explain it simply?"
- **Use before**: Any implementation to gather context

#### `/skill:brainstorm`

- Structured ideation using SCAMPER, Six Thinking Hats, Mind Mapping
- Generates multiple solution approaches
- Analyzes effort vs impact
- **Use when**: Exploring new features or solving creative problems

#### `/skill:grill-with-docs`

- Runs a relentless, one-question-at-a-time interview
- Captures resolved terms in `CONTEXT.md` and hard decisions as ADRs as it goes
- Synthesizes the shared understanding into a comprehensive `PRD.md`
- **Use when**: Starting a new feature/project with unclear requirements or unsettled domain language

#### `/skill:clarify`

- Quick clarifications on specific ambiguous points
- Prevents assumptions before implementation
- **Use when**: Requirements are vague or open to interpretation

#### `/skill:prd-to-tasks`

- Breaks PRD into structured `tasks.json` with phases and dependencies
- Assigns priorities and effort estimates
- **Use when**: PRD is approved and ready for implementation

#### `/skill:implement-tasks`

- Implements tasks from `tasks.json` in dependency order
- One wave at a time (parallel-ready tasks together)
- Verifies acceptance criteria after each task
- **Use when**: `tasks.json` exists and should be executed

#### `/skill:review`

- Comprehensive code review after implementation
- Checks functionality, security, performance, maintainability
- Categorizes issues by severity (Critical/Important/Suggestion)
- **Use when**: Code is implemented and needs review before merge

#### `/skill:quality-assurance`

- Validates implementations against acceptance criteria
- Runs tests, checks edge cases, validates security
- Documents bugs with reproduction steps
- **Use when**: Implementation complete and needs validation

#### `/skill:markdown-format`

- Same as Auto-Execution rule (see below)
- Also available as explicit command when needed

### Collaboration Rules

1. **Research first** - Always gather context before asking questions
2. **Brainstorm before deciding** - Explore multiple approaches
3. **Grill with docs before building** - Ensure crystal-clear requirements and a shared paper trail
4. **Human approves PRD** - Never skip this step
5. **Tasks before code** - Use `prd-to-tasks` for complex projects
6. **Delegate implementation** - Use `implement-tasks` to spawn subagents
7. **Review after code** - Always review before merging
8. **QA validates** - Ensure acceptance criteria are met

### Auto-Execution Rules

These rules execute automatically, not as workflow steps:

| Rule                | Trigger                        | Action                               |
| ------------------- | ------------------------------ | ------------------------------------ |
| **markdown-format** | Any `.md` file created/updated | Apply consistent Markdown formatting |
| **feynman-check**   | Complex concepts               | Explain simply before proceeding     |

### Documentation Outputs

All skills generate files at project root for human review:

- `RESEARCH.md` - Findings and recommendations
- `BRAINSTORM.md` - Ideas and analysis
- `PRD.md` - Product Requirements Document
- `tasks.json` - Executable task plan

**Human must review all outputs before proceeding to implementation.**

### Simple vs Complex Projects

| Project Type                                 | Workflow                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| **Simple** (single file, config change)      | research → clarify → implement                                          |
| **Medium** (new feature, few files)          | research → grill-with-docs → PRD → implement                            |
| **Complex** (multi-component, multiple devs) | research → brainstorm → grill-with-docs → PRD → prd-to-tasks → implement-tasks |
