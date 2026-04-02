---
name: deploy
description: Stage changes, write a conventional commit, and push to Railway
user-invocable: true
---

Commit and push all current changes to Railway.

## Steps

1. Run `git status` — identify modified/untracked files
2. Run `git diff --stat` — confirm what changed
3. Run `git log --oneline -5` — match existing commit style
4. Stage relevant files (NEVER stage .env, credentials, or node_modules)
5. Write a conventional commit message:
   - `feat:` new capability
   - `fix:` bug fix
   - `refactor:` restructure without behavior change
   - Keep under 72 chars, present tense, lowercase
   - Add `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` footer
6. Commit and push to main
7. Confirm push succeeded

## Commit message style (from this repo's history)

```
fix: trades table crash — pnl.toFixed not a function (pg returns DECIMAL as string)
feat: wire dashboard to real DB data — replace all hardcoded stats
fix: Claude settings not saving — add saveClaudeSettings() and Save button
```

Note the dash-separated reason after the description — include why, not just what.
