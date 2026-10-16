# Lessons from wiring agent skills into an autonomous loop

Notes on what fought unattended execution, and where a skill boundary went fuzzy under load. Grounded in production use and in this repository.

## 1. Personas assumed a human merge step

Review personas written for a human in the loop over-reject when nothing is waiting to discuss the comment.

- A code reviewer that audits the whole file treats pre-existing issues in unchanged lines as blockers.
- A security reviewer that treats a dead-code cleanup as an attack-surface change blocks the task.
- A test reviewer that demands new tests for a pure deletion blocks the task.

The scoping rule that held up: review the diff only, leave pre-existing issues out of scope, and calibrate scrutiny to the risk of the change. The same preamble belongs on the adversarial gate.

## 2. Section titles silently dropped the rationalization tables

Some skill files title the table **Common Rationalizations**. The executor originally looked only for **Anti-Rationalization**. Under automation the tables were never injected, and the model fell through to a generic fallback.

The loader accepts both headings.

## 3. Skill path and name layout

Two layouts show up in the wild:

- `{skillsPath}/{name}.md`
- `{skillsPath}/{name}/SKILL.md`

Older installs also nested another `skills/` directory under the configured path. Several category names do not match upstream folder names (`security-review` vs `security-and-hardening`, `test-coverage-improvement` vs `test-driven-development`). A missing file used to fail open into an inline fallback, so the loop ran while ignoring the skills that were installed.

Resolution order for every name, then again for each alias:

1. `{name}.md`
2. `{name}/SKILL.md`
3. `skills/{name}.md`
4. `skills/{name}/SKILL.md`

The configured path defaults to `<repo>/.asil/skills`.

## 4. Feature-work skills fought cleanup categories

| Skill | Fought when |
|---|---|
| Test-driven development | Applied to dead-code or simplification work and insisted on a red-green cycle for a behavior-preserving change |
| Security hardening | Applied to a one-line visibility change and invented an auth concern |
| Incremental implementation | Asked for a thin slice when the scanner had queued a whole-file TODO cluster |

Skills often describe how a person should build a feature. Several scanner categories are mechanical cleanup. The category-to-skill mapping needs an explicit "no behavior change" delta, not only a file load.

## 5. A strict priority queue let one category monopolize a run

Strict priority meant a noisy test suite could starve every other category for the whole run. Rotating through categories that have eligible work, while still taking the highest-priority task inside a category, fixed the starvation.

## 6. Scanner false positives became confident bad edits

A dead-code skill combined with a shallow "no in-repo references" check proposed deleting public API surface re-exported from package entry points. The skill did what it was asked. The task was wrong. Entry points are exempt, and the task text has to state uncertainty before the skill runs.

## 7. What held up

- Rationalization tables, once they were actually injected.
- Fail-closed JSON from personas and the adversarial gate (unparseable output is a rejection).
- Cost checkpoints around the review fan-out.
- Domain-question markers as the boundary where a skill must stop instead of inventing domain logic.

## Name mapping

| Category or thinker | Primary name | Alias |
|---|---|---|
| vulnerability | `security-review` | `security-and-hardening` |
| test-failure / coverage-gap | `test-coverage-improvement` | `test-driven-development` |
| test strategist | `test-driven-development` | `testing-strategy` |
| security thinker | `security-and-hardening` | `security-review` |
| dead-code | `dead-code-removal` | `code-simplification` |
| dependency-update | `dependency-update` | `deprecation-and-migration` |
| documentation | `documentation-generation` | `documentation-and-adrs` |
| todo-resolution | `todo-resolution` | `incremental-implementation`, `debugging-and-error-recovery` |
| type-error / complexity | `code-simplification` | exact match |
| planner / spec writer | `planning-and-task-breakdown` / `spec-driven-development` | exact match |
