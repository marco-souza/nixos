---
name: review
description: >
  Comprehensive code review after implementation. Analyzes code quality,
  security, performance, and adherence to patterns.
  Use when: code has been implemented and needs review before merging,
  or when the user asks to "review this", "check my code", or "PR review".
  Do NOT use when: no code changes exist, or during initial implementation
  (review happens after).
---

# Code Review

Perform thorough code reviews focusing on quality, security, performance, and maintainability.

## When to Use

- After implementation is complete
- Before merging to main branch
- When user requests code review
- After `implement` or `implement-tasks` completes

## When NOT to Use

- During initial requirements gathering
- Before any code is written
- For syntax errors (use linter instead)

## Review Checklist

### 1. Functionality

- [ ] Does the code do what it's supposed to do?
- [ ] Are edge cases handled?
- [ ] Is error handling appropriate?
- [ ] Are return values consistent?

### 2. Code Quality

- [ ] Is the code readable and well-organized?
- [ ] Are functions small and focused (single responsibility)?
- [ ] Is naming clear and consistent?
- [ ] Are there unnecessary comments or magic numbers?
- [ ] Does it follow project conventions?

### 3. Security

- [ ] Input validation present?
- [ ] No hardcoded secrets or credentials?
- [ ] SQL injection / XSS prevention?
- [ ] Authentication/authorization checks?
- [ ] Safe error messages (no info leakage)?

### 4. Performance

- [ ] No unnecessary database queries?
- [ ] Efficient algorithms (no N+1, no O(n²) where avoidable)?
- [ ] Proper caching where needed?
- [ ] Memory leaks or resource cleanup?

### 5. Maintainability

- [ ] DRY (Don't Repeat Yourself)?
- [ ] SOLID principles followed?
- [ ] Easy to test?
- [ ] Documentation needed?

### 6. Testing

- [ ] Unit tests present?
- [ ] Edge cases covered?
- [ ] Integration tests if needed?
- [ ] Tests are meaningful (not just coverage)?

## Review Output Format

```markdown
# Code Review: [Feature/Branch]

**Date**: YYYY-MM-DD
**Reviewer**: Review Skill
**Status**: ✅ Approved / ⚠️ Changes Requested / ❌ Needs Rework

## Summary

[1-2 sentence overview of what was reviewed]

## Findings

### 🔴 Critical (Must Fix)

1. **[File:Line]** - [Issue description]
   - Impact: [Why this matters]
   - Fix: [How to fix]

### 🟡 Important (Should Fix)

1. **[File:Line]** - [Issue description]
   - Impact: [Why this matters]
   - Suggestion: [How to improve]

### 🟢 Suggestions (Nice to Have)

1. **[File:Line]** - [Improvement idea]

## Positive Observations

- [What was done well]
- [Good patterns used]
- [Clean implementations]

## Security Notes

- [Any security concerns or confirmations]

## Performance Notes

- [Any performance concerns or confirmations]

## Test Coverage

- [Assessment of test quality]

## Recommendation

[Final verdict with clear next steps]
```

## Severity Levels

| Level      | Icon | Action                | When                                          |
| ---------- | ---- | --------------------- | --------------------------------------------- |
| Critical   | 🔴   | Must fix before merge | Bugs, security issues, data loss risk         |
| Important  | 🟡   | Should fix            | Code smell, missing validation, poor patterns |
| Suggestion | 🟢   | Optional              | Style preferences, minor improvements         |

## Workflow

### 1. Gather Context

```bash
/skill:research
```

Understand the codebase patterns before reviewing.

### 2. Review Changes

```bash
git diff main...HEAD  # Or appropriate branch
git log --oneline main..HEAD
```

### 3. Analyze Each File

For each changed file:

- Read the full file (not just diff)
- Check against review checklist
- Note issues with severity

### 4. Generate Report

Create the review output with findings categorized by severity.

### 5. Suggest Fixes

For critical/important issues, provide specific code suggestions.

## Integration

- **After implement**: Review the implementation
- **After implement-tasks**: Review each completed task
- **Before merge**: Final quality gate
- **With quality-assurance**: Review + test validation

## Example

```text
User: Review the auth implementation

Agent:
1. Reads all auth-related changes
2. Checks against security checklist
3. Validates error handling
4. Reviews test coverage
5. Generates review report
6. Suggests fixes for any issues
```
