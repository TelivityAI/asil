# ASIL Quickstart — Wire It Into Any TypeScript Repo

This walks through wiring ASIL into an existing TypeScript codebase. End-to-end in five minutes if you already have a target repo.

## Prerequisites

- Node ≥ 20, pnpm ≥ 9
- Target repo uses pnpm and has working `pnpm install`, `pnpm test`, `pnpm typecheck` scripts
- Anthropic API key (primary LLM)
- OpenAI API key (adversarial gate)

## 1. Add ASIL to your workspace

Clone or vendor the four packages alongside your code, then add them to your `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "asil/packages/*"   # add this line
```

`pnpm install` will link them in. The library packages are not on npm yet, so install them from this git repository rather than with `pnpm add`.

(`asil-runners` is the reference CLI, not a library — vendor it or copy its wiring. The four libraries above are what you compose into your own runner.)

## 2. Set up environment

Create `.env` next to `pnpm-workspace.yaml` in the ASIL checkout. The CLI loads that file and no other. `auto grind` refuses to start unless `REPO_ROOT` is set. Grind copies that repository under the system temp directory and does not run commands or git writes in the checkout you have open. Target-repository commands run inside bubblewrap (`bwrap` on `PATH`). Set `ASIL_SANDBOX=off` only when you accept unsandboxed execution.

```
ANTHROPIC_API_KEY=sk-ant-…
OPENAI_API_KEY=sk-…
REPO_ROOT=/absolute/path/to/your/repo
```

## 3. Drop in the runner skills

Thinkers and the executor load Markdown from `ASIL_SKILLS_PATH` (default `<REPO_ROOT>/.asil/skills`). Both of these layouts work, with the flat file tried first:

```bash
# Flat file
.asil/skills/planning-and-task-breakdown.md

# Directory layout used by many public skill libraries
.asil/skills/planning-and-task-breakdown/SKILL.md
```

Historical names such as `security-review` also resolve to `security-and-hardening`. A missing file falls back to the inline instructions.

```bash
mkdir -p .asil/skills
# Copy or symlink the skill files you want. A minimal install is fine.
```

Override the location with `ASIL_SKILLS_PATH`. A relative value must stay inside the repository. An absolute value is used as given, unless it contains `..` and resolves outside the repository.

## 4. Run System B (Thought Multiplier) standalone

This is the lowest-risk way to try ASIL — no code mutations, just generates a build brief.

```bash
pnpm --filter asil-runners run:b "add rate limiting to the connect API endpoint"
```

You'll get a Markdown brief with merged recommendations, conflict resolutions, and acceptance criteria. Use it as a prompt to your editor agent of choice.

## 5. Run System A (Improvement Loop) in dry-run mode

```bash
pnpm --filter asil-runners auto grind --dry-run
```

This scans and reports without executing tasks, calling a model, or changing git. Grind copies the repository under the system temp directory first. The default scan runs typecheck and a TODO search on that copy, so it is not a no-op, and it does not run commands in the checkout you have open. Pass `--full` to add tests, coverage, and dead code.

## 6. Run a real grind (small budget)

```bash
pnpm --filter asil-runners auto grind --skip dependency-update,documentation --apply
```

The runner will:

1. Print whether each scanned category loaded a skill file. Pass `--require-skills` to stop before scanning when one is missing.
2. Scan and queue tasks. Scanner commands run inside the jail.
3. Pause on any unresolved `// DOMAIN_QUESTION:` markers and offer triage
4. For the one task this run takes (pass `--max-tasks` for more, `--full` to scan tests, coverage, and dead code): execute, typecheck, test, self-review × 3, adversarial gate, domain guard. `--apply` then commits, pushes a new `auto/*` branch, and opens a draft pull request. It does not overwrite a branch that is already on the remote. Without `--apply` the task stays queued.
5. Print a summary with cost spent and PRs opened

## 7. Inspect the spend

```bash
pnpm --filter asil-runners auto report
pnpm --filter asil-runners auto report weekly
```

Reports come out as Markdown tables with per-task, per-system, and per-day cost rollups.

## Going further

- **Customize project rules.** Pass `projectName` and `projectDoNotChange` via `ThoughtMultiplierConfig` to inject your house rules into every brief.
- **Plug in a different provider.** Replace `createAnthropicCaller` / `createCodexCaller` in `asil-runners/src/wiring.ts` with a wrapper around any LLM that returns `{content, inputTokens, outputTokens}`.
- **Tighten the budget.** Configure `BudgetManager` with per-category caps and a daily ceiling; the kill switch will halt the loop if either is breached.
- **Mark unresolved domain logic.** Sprinkle `// DOMAIN_QUESTION: <one-line question>` comments in code paths that need human input. The loop will block on them until you triage.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `git clone` into the temp directory fails | The source repository cannot be read, or the temp directory is not writable | Check `git status` in `REPO_ROOT` and that the system temp directory is writable. Grind does not create a worktree in the checkout you have open. |
| `pnpm install` fails in the scratch clone | The clone has no `node_modules` yet, or the lockfile does not match | The loop runs `pnpm install --frozen-lockfile` once in the clone. Install scripts stay off unless `ASIL_ALLOW_INSTALL_SCRIPTS=1`. |
| Adversarial gate keeps blocking | Diff is genuinely contradictory or oversized | Check the gate's reason string; usually the LLM has a real point. Lower `maxAttempts` to fail faster. |
| Cost cap hit immediately | Budget too low for selected models | Either bump `dailyBudgetUSD` or downgrade `executionModel` from `opus` to `sonnet`. |
