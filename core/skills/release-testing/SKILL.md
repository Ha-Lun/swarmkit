---
name: release-testing
description: Use when running validation commands before a release — test suites, linters, type checkers, and build verification. Includes concrete command patterns for common stacks. Loaded by the release-tester agent.
---

# Release Testing

Standardized test execution and validation for pre-release quality gating.

## Stack detection

Inspect `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `*.csproj`, `CMakeLists.txt`, or `Makefile` to determine the project stack and select appropriate commands.

## Command reference by stack

### Node.js / TypeScript
```bash
npm run lint          # or: npx eslint src/
npx tsc --noEmit      # or: npx vue-tsc --noEmit
npm run typecheck     # if configured
npm test              # or: npx vitest run, npx jest
npm run test:e2e      # if applicable
npm run build         # verify production build
```

### Python
```bash
ruff check .                     # lint
mypy .                           # type check
pytest                           # unit & integration tests
pytest tests/integration/        # integration only
python -m build                  # verify build
```

### Go
```bash
go vet ./...        # lint-like static analysis
go test ./...       # all tests
go build ./...      # verify compilation
```

### Rust
```bash
cargo check                    # type check + borrow check
cargo test                     # all tests
cargo clippy                   # lint
cargo build --release          # verify release build
```

### .NET / C#
```bash
dotnet build          # compile check
dotnet test           # all tests
dotnet format --verify-no-changes  # lint
```

## Required check order

1. **Lint** — catch style and basic logic issues first.
2. **Type check** — catch type errors and contract violations.
3. **Unit tests** — verify individual components work correctly.
4. **Build** — ensure the project compiles for production.
5. **Integration / E2E tests** — verify system works end-to-end.

## Fail-fast rule

If lint or type check fails, report the failure immediately. Do not proceed to run tests or build — those will likely fail too and waste time.

## Reporting

Every check must report:
- **Status**: `pass`, `fail`, or `skip` (with reason for skip).
- **Output**: exact command output for failures. For passes, summary line only.
- **Duration**: time taken for long-running checks (tests, builds).
