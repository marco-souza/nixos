---
name: quality-assurance
description: >
  Quality assurance and testing validation after implementation.
  Runs tests, validates acceptance criteria, checks edge cases,
  and ensures the implementation meets requirements.
  Use when: implementation is complete and needs validation,
  or when the user asks to "test this", "QA check", or "validate implementation".
  Do NOT use when: no implementation exists yet, or for code review (use review skill).
---

# Quality Assurance

Validate that implementations work correctly, meet acceptance criteria, and handle edge cases properly.

## When to Use

- After code implementation is complete
- To validate acceptance criteria from PRD/tasks
- Before deploying to production
- When user requests testing or QA

## When NOT to Use

- During requirements gathering
- Before implementation exists
- For code style review (use `review` skill)

## QA Checklist

### 1. Functional Testing

- [ ] Happy path works correctly
- [ ] All acceptance criteria met
- [ ] Features work as documented
- [ ] Integration points functioning

### 2. Edge Cases

- [ ] Empty/null inputs handled
- [ ] Boundary values tested
- [ ] Error conditions covered
- [ ] Timeout handling
- [ ] Concurrent access (if applicable)

### 3. Integration Testing

- [ ] API contracts satisfied
- [ ] Database operations correct
- [ ] External service mocks work
- [ ] File I/O handled properly

### 4. Regression Testing

- [ ] Existing tests still pass
- [ ] No breaking changes
- [ ] Backward compatibility maintained

### 5. Security Testing

- [ ] Input validation works
- [ ] Authentication required where needed
- [ ] Authorization checks function
- [ ] No injection vulnerabilities

### 6. Performance Testing

- [ ] Response times acceptable
- [ ] No memory leaks
- [ ] Resource cleanup verified
- [ ] Load handling (if applicable)

## QA Output Format

````markdown
# Quality Assurance Report: [Feature]

**Date**: YYYY-MM-DD
**Tester**: Quality Assurance Skill
**Status**: ✅ Passed / ⚠️ Partial / ❌ Failed

## Summary

[1-2 sentence overview of what was tested]

## Acceptance Criteria Validation

| Criterion           | Status | Notes                  |
| ------------------- | ------ | ---------------------- |
| AC-1: [Description] | ✅     | Works as expected      |
| AC-2: [Description] | ❌     | Fails when [condition] |
| AC-3: [Description] | ⚠️     | Partially works        |

## Test Results

### Unit Tests

```text

✅ test_example_1
✅ test_example_2
❌ test_edge_case

```

**Result**: X/Y passed

### Integration Tests

```text

✅ test_api_contract
⚠️ test_db_operation (slow)

```

**Result**: X/Y passed

### Manual Testing

| Scenario     | Steps | Expected   | Actual   | Status |
| ------------ | ----- | ---------- | -------- | ------ |
| [Scenario 1] | 1,2,3 | [Expected] | [Actual] | ✅     |
| [Scenario 2] | 1,2,3 | [Expected] | [Actual] | ❌     |

## Edge Cases Tested

| Case        | Input          | Expected | Actual   | Status |
| ----------- | -------------- | -------- | -------- | ------ |
| Empty input | `""`           | Error    | Error    | ✅     |
| Null input  | `null`         | Error    | Crash    | ❌     |
| Max length  | `[1000 chars]` | Truncate | Truncate | ✅     |

## Security Validation

- [ ] SQL injection: Attempted, blocked ✅
- [ ] XSS: Attempted, blocked ✅
- [ ] Auth bypass: Attempted, blocked ✅

## Performance Metrics

| Operation     | Target | Actual | Status |
| ------------- | ------ | ------ | ------ |
| Response time | <100ms | 45ms   | ✅     |
| Memory usage  | <50MB  | 32MB   | ✅     |

## Bugs Found

### 🔴 Critical

1. **BUG-001**: [Description]
   - Steps to reproduce: [Steps]
   - Expected: [What should happen]
   - Actual: [What actually happened]

### 🟡 Minor

1. **BUG-002**: [Description]

## Recommendations

- [ ] Fix critical bugs before merge
- [ ] Consider adding test for [scenario]
- [ ] Performance optimization for [area]

## Conclusion

[Final assessment of quality and readiness]
````

## Workflow

### 1. Understand Requirements

```bash
/skill:research
```

Read PRD or tasks.json to understand acceptance criteria.

### 2. Run Existing Tests

```bash
# Project-specific test commands
npm test
go test ./...
pytest
```

### 3. Manual Testing

Test edge cases and scenarios not covered by automated tests.

### 4. Validate Acceptance Criteria

Check each criterion from PRD/tasks against actual behavior.

### 5. Generate Report

Document findings with clear pass/fail status.

### 6. Report Bugs

If critical bugs found, document steps to reproduce.

## Integration

- **After review**: QA validates the reviewed code
- **With review**: Both skills work together for complete validation
- **Before deploy**: Final quality gate
- **After implement-tasks**: Validate each completed task

## Bug Severity

| Level       | Icon | Action            | When                            |
| ----------- | ---- | ----------------- | ------------------------------- |
| Critical    | 🔴   | Block merge       | Crash, data loss, security hole |
| Major       | 🟠   | Fix soon          | Feature broken, wrong behavior  |
| Minor       | 🟡   | Fix when possible | Cosmetic, edge case             |
| Enhancement | 🟢   | Optional          | Nice-to-have improvement        |

## Example

```text
User: QA the authentication feature

Agent:
1. Reads PRD acceptance criteria
2. Runs unit tests
3. Tests edge cases (empty password, SQL injection, etc.)
4. Validates each AC
5. Generates QA report
6. Documents any bugs found
```

## QA vs Review

| Aspect | quality-assurance     | review                |
| ------ | --------------------- | --------------------- |
| Focus  | Does it work?         | Is it well-written?   |
| Tests  | Runs tests, validates | Checks code structure |
| Output | QA Report             | Code Review           |
| Bugs   | Functional bugs       | Code quality issues   |
| Timing | After implementation  | After implementation  |
