---
name: clarify
description: When requirements are ambiguous, incomplete, or the agent is not 100% sure about what to implement — stop and ask clarifying questions before writing code or making changes.
---

# Clarify

Before jumping into implementation, make sure the requirements are crystal clear.

## When to use

- The user's request is vague or open to interpretation
- There are multiple valid approaches and the best one isn't obvious
- You're making assumptions about the user's intent, environment, or preferences
- You're unsure about file paths, naming conventions, or code style
- The task touches areas you haven't explored yet (read relevant files first!)
- You're about to suggest a solution that might not match what the user actually wants

## How to clarify

1. **Summarize your understanding** of the request in your own words
2. **List the open questions** — specific things you're unsure about
3. **Suggest options** — propose 2-3 approaches when there's ambiguity
4. **Wait for the user's response** before proceeding

## Collaboration with Other Skills

- **research**: Use `/skill:research` to explore the codebase and gather context before asking questions. Research reduces the number of clarifications needed.
- **grill-with-docs**: For deep requirements discovery, use `/skill:grill-with-docs` to systematically uncover all requirements
- **brainstorm**: For exploring multiple solution approaches, use `/skill:brainstorm`

## Remember

- It's faster to ask now than to redo work later
- Reading files first reduces ambiguity — always check before assuming
- "When in doubt, ask" — this skill exists because past me forgot this too often
- **Research first, ask second**: Use `/skill:research` to gather context, then ask targeted questions
