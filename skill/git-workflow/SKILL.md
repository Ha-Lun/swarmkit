---
name: git-workflow
description: Use when reviewing git state, commit quality, branch hygiene, diff safety, or preparing a release. Covers conventional commits, branch naming, merge strategies, and destructive operation prevention. Loaded by the git-specialist agent.
---

# Git Workflow

Standards for commit hygiene, branch management, and safe Git operations.

## Commit conventions

Format (Conventional Commits):
```
<type>(<scope>): <short summary>

<body (optional)>

<footer (optional)>
```

Types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `perf`, `test`, `ci`, `build`.

Rules:
- One logical change per commit. No "fix typo + refactor + add feature" in one commit.
- Summary under 72 characters, imperative mood ("Add login route", not "Added login route").
- Body wraps at 72 characters and explains *why*, not *what*.
- Breaking changes marked with `BREAKING CHANGE:` in footer or `!` after type (`feat!:`).
- No "fix", "update", "wip", "oops" messages.

## Branch naming

```
<type>/<description>
```

Examples: `feat/user-auth`, `fix/login-crash`, `chore/update-deps`, `docs/api-readme`.

Rules:
- Lowercase, hyphens for spaces.
- Description is brief (2-5 words) and relates to the change.
- No ticket numbers in branch names unless the team convention requires them.

## Branch hygiene

- Feature branches should be short-lived (< 3 days or < 500 lines delta). Long-lived branches should be split.
- Branch is rebased on target base before review (no merge commits in feature branches).
- No random commits from other branches (cherry-pick with caution).
- Stale branches (no activity > 2 weeks) should be flagged.

## Diff safety checklist

- No files committed that are listed in `.gitignore` (`.env`, `node_modules/`, `dist/`, `*.log`, secrets).
- No binary blobs > 100KB unless intentional (assets, generated files).
- No accidental whitespace changes (trailing whitespace, mixed line endings, file mode changes).
- No commented-out code blocks.
- No `console.log` or debug statements (unless intentional in the change).
- No secrets (passwords, tokens, keys) in the diff.
- Changes are limited to the scope described in the commit message.

## Merge strategy

- **Feature branch → main**: squash-merge or rebase-merge for clean history.
- **main → feature branch**: rebase (not merge), to keep linear history.
- **Release branch → main**: merge commit to preserve release boundary.
- No force-push to `main`, `master`, `develop`, `release/*`, or any shared branch.

## Destructive operations — FLAG THESE

| Operation | Rule |
|---|---|
| `git push --force` | Never on shared branches. Only on personal feature branches. |
| `git reset --hard <ref>` | Only if change is entirely local and unpushed. |
| `git commit --amend` | Only if the commit has not been pushed. |
| `git rebase --interactive` | Only on personal feature branches. |
| `git branch -D` | Only if branch is fully merged or confirmed abandoned. |
| `git clean -fd` | Only with explicit user confirmation. |

## Release preparation

1. Version tag exists and follows semver (`v1.2.3`).
2. Changelog is updated (generated or maintained).
3. All changes since last tag are intentional and reviewed.
4. Working tree is clean (`git status` shows nothing).
5. Branch is up to date with target (no divergence).
