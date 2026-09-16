# Engineering workflow

This project is built by a small team of AI engineering agents directed by a lead engineer/orchestrator, following the same discipline a professional team would use. This document exists so that workflow is explicit and auditable rather than implicit.

## Roles

- **Lead engineer (orchestrator).** Owns product intent, architecture sign-off, task decomposition, code review, integration, and release readiness. Does not necessarily write every line of code, but is accountable for everything that merges.
- **Delegated engineering agents.** Receive a tightly scoped brief (objective, required context, file/module ownership, constraints, deliverable, acceptance criteria), execute it, and hand back a reviewable result. Never commit or push on their own authority.

## Decision records (RFCs)

Any decision with real, hard-to-reverse consequences (architecture, core data model, technology choices, security posture) is written down as a decision record under `docs/architecture/` before implementation starts, and tracked as a GitHub issue labeled `rfc`.

Every RFC goes through:
1. **Draft** — produced by a delegated engineering pass.
2. **Independent review** — a separate, adversarial engineering pass that checks the draft against constraints and tries to break it, not a rubber stamp.
3. **Owner sign-off** — the project owner approves before implementation branches are opened against it.

## Branching and review

- `main` is always deployable.
- Work happens on feature branches named `area/short-description` (e.g. `backend/order-service`, `admin/menu-editor`).
- Every change lands through a pull request, even when the lead engineer wrote it. No direct pushes to `main` for anything beyond initial repository bootstrap.
- A PR must state what it does, what it does not do, and how it was verified.
- Concurrent AI-agent work uses isolated git worktrees with explicit file/module ownership to avoid two agents writing the same files at once. Shared files (lockfiles, compose files, schemas, migrations) have a single owner per change.

## Definition of done

A change is not done because the happy path works. Where relevant it must also cover: validation, error handling, security implications, tests, loading/empty/error states, responsive/accessibility behavior, and any documentation impact. See the project's internal bootstrap/release checklist for the full release gate.

## Commits and language

- Commit messages and code comments are written in English.
- Comments explain non-obvious behavior, invariants, or constraints — never conversation between agents or references to who asked for a change.
- Commit messages are focused and explain why a change was made, not just what changed.

## Licensing

This repository is source-available under the PolyForm Strict License 1.0.0 (see `LICENSE`), not open source. Every dependency is checked for license compatibility before it is added; anything AGPL/GPL/LGPL/SSPL/BSL-licensed requires explicit review before use.
