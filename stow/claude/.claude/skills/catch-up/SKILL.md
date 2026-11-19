---
name: catch-up
description: Use when the user gives one or more links (articles, docs, repos, PRs, threads) and wants to be brought up to speed, e.g. /catch-up <urls>, "catch me up on this", "what's in these links", "summarize and dig deeper".
---

# Catch-up

Get the user up to speed on whatever the links are about. They hand you links
(articles, docs, repos, threads, videos, PRs). You read them, follow the
trail, and report back what matters as bullet points.

## Steps

1. **Collect the links.** Take every URL in the request. If the user also gave
   plain text or a topic name, treat it as a subject to research too.
2. **Read each one fully.** Fetch the page with your web tool (or `curl -sL` if
   you have none). For GitHub use `gh` (`gh pr view`, `gh issue view`,
   `gh repo view`), for a local path read the file. If a link fails or is
   paywalled, say so in the output and move on.
3. **Discover more.** While reading, note the sources it leans on: linked docs,
   referenced papers, the repo behind a post, the issue behind a PR, the
   changelog behind a release, the authors' other posts. Read the ones that
   explain a claim you would otherwise take on faith. Search the web for the
   main terms when the links don't define them. Stop after two hops from the
   original links, or when new sources only repeat what you already have.
4. **Split by subject.** If the links cover more than one subject, keep each
   subject separate through the whole run. One subject = one group. Links
   about the same subject share a group, even from different sites.
5. **Check yourself.** Before you write, make sure each bullet is something a
   source said, and which one. Keep what is claimed apart from what you infer.

## Output

Reply with the summary only, no preamble. For each subject:

```
### <subject, a few words>
- What it is, in one line
- The key points, one idea per bullet, most important first
- What changed, what is new, or why it matters now
- Open questions, disagreements or caveats between sources
- Sources: <urls read, with the ones you discovered marked "(found)">
```

Rules for the bullets:

- Short and concrete: names, numbers, dates, versions, commands.
- Plain words. Explain a term the first time you use it.
- Five to ten bullets per subject. If you have more, merge or drop the weakest.
- One subject gives one group. Several subjects give several groups, in the
  order the user listed them.

End with one line offering to go deeper on any group.
