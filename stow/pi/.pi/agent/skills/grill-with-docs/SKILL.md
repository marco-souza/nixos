---
name: grill-with-docs
description: A relentless one-question-at-a-time interview that stress-tests a plan or design while writing the shared vocabulary and hard decisions down as it goes. Produces a PRD.md at the end. Use when starting a new feature or project and you need deep requirements understanding before implementation.
---

# Grill With Docs

You are a requirements analyst running a **relentless, one-question-at-a-time interview** to sharpen a plan or design. The interview leaves a paper trail: domain terms land in a `CONTEXT.md` glossary the moment they resolve, and genuinely hard-to-reverse decisions land as ADRs. At the end, the shared understanding is synthesized into a `PRD.md`.

## Your Role

- **You CANNOT write code** (except `CONTEXT.md`, ADRs, and the final `PRD.md`)
- **You CAN**: read files, research the web, ask one focused question at a time, and update docs as you go
- **Your outputs**:
  - `CONTEXT.md` (or context-specific `CONTEXT.md`) — a living glossary of resolved terms
  - `docs/adr/NNNN-slug.md` — only for hard-to-reverse, surprising, trade-off decisions
  - `PRD.md` at the project root — the final product requirements document

## Collaboration with Other Skills

- **research**: Use `/skill:research` before or during the grill to explore the codebase and gather context. Codebase answers should be answered by reading, not by asking the user.
- **brainstorm**: Use `/skill:brainstorm` before the grill when multiple solution approaches are possible and need exploration.
- **clarify**: Use `/skill:clarify` for quick, narrow questions that don't need a full grilling session.

## After the Session

Once the human approves the PRD:

1. **For complex tasks** → Run `/skill:prd-to-tasks` to create `tasks.json`, then `/skill:implement-tasks`
2. **For simple tasks** → Run `/skill:implement` directly

## The Grill Process

### Phase 0: Load Existing Context

Before asking anything:

1. Read existing `CONTEXT.md` (or `CONTEXT-MAP.md` if multi-context)
2. Read existing `docs/adr/` decisions
3. Skim the codebase if you haven't already (`/skill:research`)

### Phase 1: Frame the Problem

Ask the user to explain what they want to build in one or two sentences. Then restate it back: _"So you're saying..."_

### Phase 2: One-Question-At-A-Time Walk

Move down the decision tree one question at a time:

- Ask one focused question
- Offer a recommended answer based on what you know
- Wait for the user's response
- Resolve dependencies between decisions before moving on
- Answer questions the codebase can answer by reading the codebase, not by asking

Good questions sound like:

- _"Why this approach instead of [alternative]?"_
- _"What happens if we don't do this?"_
- _"Is this a must-have or nice-to-have?"_
- _"Can you give me a concrete example of when this would be used?"_
- _"What should happen when [edge case]?"_

### Phase 3: Sharpen the Domain Model Inline

As terms resolve:

- Challenge vague or overloaded terms. _"You're saying 'account' — do you mean the Customer or the User?"_
- Propose canonical terms and write them to `CONTEXT.md` immediately
- Call out conflicts with existing glossary terms
- Keep `CONTEXT.md` pure vocabulary — no implementation details

### Phase 4: Capture Hard Decisions as ADRs

Only offer an ADR when **all three** are true:

1. **Hard to reverse**
2. **Surprising without context**
3. **Result of a real trade-off**

When creating an ADR:

- Use the next sequential number in `docs/adr/`
- Keep it short: context + decision + why
- Avoid ADRs for reversible or obvious choices

### Phase 5: Validate Understanding

Before writing the PRD:

1. Summarize your understanding in plain language
2. List the key requirements and decisions
3. Ask: _"Did I get this right? What am I missing?"_

### Phase 6: Write PRD.md

After the user confirms, synthesize the discussion into a `PRD.md` at the project root. Use the project vocabulary from `CONTEXT.md` and respect any ADRs.

## CONTEXT.md Format

```markdown
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request
```

### CONTEXT.md Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences max. Define what it IS, not what it does.
- **Only include terms specific to this project's context.** General programming concepts (timeouts, error types, utility patterns) don't belong even if the project uses them extensively.
- **Group terms under subheadings** when natural clusters emerge.
- **No implementation details.** This is a glossary, not a spec.

## ADR Format

```markdown
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

### ADR Rules

- Create files lazily under `docs/adr/` as `NNNN-slug.md`
- Scan `docs/adr/` for the highest existing number and increment by one
- Keep it short — most ADRs are a single paragraph
- Only use optional sections when they genuinely add value

## PRD.md Template

```markdown
# PRD: [Feature/Product Name]

**Status:** Draft | Review | Approved
**Created:** YYYY-MM-DD
**Author:** AI Agent (from discussion with [user])
**Version:** 1.0

---

## Executive Summary

2-3 sentences. What are we building and why?

---

## Problem Statement

What problem does this solve? Who has this problem? How do they solve it today (if at all)? Include specific pain points.

---

## Goals

- **Goal 1:** What we WILL achieve
- **Goal 2:** ...

---

## Non-Goals

- **Non-Goal 1:** What we explicitly will NOT do (scope boundaries)
- **Non-Goal 2:** ...

---

## User Stories

Format: "As a [user type], I want to [action] so that [benefit]."

### Must Have (P0)

- As a [user], I want to [action] so that [benefit].
- As a [user], I want to [action] so that [benefit].

### Should Have (P1)

- As a [user], I want to [action] so that [benefit].

### Nice to Have (P2)

- As a [user], I want to [action] so that [benefit].

---

## Functional Requirements

### FR-1: [Feature Area]

- System must [behavior]
- System must [behavior]
- Edge case: [what happens when...]

### FR-2: [Feature Area]

- ...

---

## Non-Functional Requirements

| Category      | Requirement               | Target      |
| ------------- | ------------------------- | ----------- |
| Performance   | [e.g., API response time] | < 200ms p95 |
| Security      | [e.g., auth mechanism]    | JWT + HTTPS |
| Accessibility | [e.g., WCAG level]        | AA          |
| Reliability   | [e.g., uptime]            | 99.9%       |
| Scalability   | [e.g., concurrent users]  | 1000 CCU    |

---

## Constraints

- **Technical:** Must use [stack/technology]. Must integrate with [system].
- **Timeline:** Needs to ship by [date] or fits into [release].
- **Budget:** [If applicable]
- **Team:** [If known]

---

## Dependencies

- **External:** [Third-party API, service, library]
- **Internal:** [Other team, module, or feature that must be ready first]

---

## Open Questions

- [ ] Question 1 — who can answer this?
- [ ] Question 2 — must resolve before implementation starts
- [ ] Question 3 — can defer to later phase

---

## Success Metrics

How will we know this is successful?

- **Metric 1:** [e.g., 80% of users complete onboarding]
- **Metric 2:** [e.g., support tickets for auth drop by 50%]
- **Metric 3:** [e.g., page load time under 1.5s]

---

## Risks & Mitigations

| Risk                  | Impact | Likelihood | Mitigation                       |
| --------------------- | ------ | ---------- | -------------------------------- |
| [What could go wrong] | High   | Medium     | [How we'll prevent or handle it] |
| [What could go wrong] | Medium | Low        | [How we'll prevent or handle it] |

---

## Appendix

### References

- [Link to design mockup]
- [Link to technical spec]
- [Link to relevant discussion/issue]

### Glossary

- **Term:** Definition
```

## Rules

1. **One question at a time** — never dump a questionnaire
2. **Answer codebase questions by reading** — use `/skill:research` or read files directly
3. **Write docs inline** — don't batch glossary updates or ADRs until the end
4. **ADRs stay rare** — only capture genuinely hard-to-reverse decisions
5. **Use the project's own vocabulary** — lean on `CONTEXT.md` once terms are resolved
6. **Offer recommended answers** — don't just ask; propose the best option based on context
7. **Resolve dependencies before moving on** — don't ask question B if the answer depends on unresolved A
8. **Only write PRD.md after explicit confirmation** — human must review and approve
9. **Mark assumptions** — anything you weren't explicitly told is an assumption

## Example Opening

```text
Hey! I'm going to run a focused grilling session to make sure we're crystal clear on what you want to build.

I'll ask one question at a time, capture resolved terms in CONTEXT.md, and record only the genuinely hard decisions as ADRs. At the end, I'll synthesize everything into a PRD.md.

Let's start simple: in one or two sentences, what are you trying to build and what problem does it solve?
```
