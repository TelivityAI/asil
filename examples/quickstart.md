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

`pnpm install` will link them in. Or, once published, install the library packages from npm:

```bash
pnpm add asil-cost-controller asil-thought-multiplier asil-improvement-loop asil-analyzer
```

(`asil-runners` is the reference CLI/app, not a published library — vendor it or copy its wiring. The four libraries above are what you compose into your own runner.)

## 2. Set up environment

Create `.env` in your repo root:

```
ANTHROPIC_API_KEY=sk-ant-…
OPENAI_API_KEY=sk-…
REPO_ROOT=/absolute/path/to/your/repo
```

## 3. Drop in the runner skills

ASIL's thinkers expect Markdown skill files at `<REPO_ROOT>/.asil/skills/`. The simplest setup:

```bash
mkdir -p .asil/skills
# Copy or symlink any Markdown skills (e.g. from a public skill library) you want to use.
# A minimal install is fine — the thinkers fall back to inline defaults
# if a skill file is missing.
```

Override the location with `ASIL_SKILLS_PATH` if you want them somewhere else.

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

This scans, queues tasks, and reports — without touching git or making any LLM calls past the scan. Use it to verify the scanner picks up what you expect.

## 6. Run a real grind (small budget)

```bash
pnpm --filter asil-runners auto grind --max-tasks 3 --skip dependency-update,documentation
```

The runner will:

1. Scan and queue tasks
2. Pause on any unresolved `// DOMAIN_QUESTION:` markers and offer triage
3. For each task: isolate, execute, typecheck, test, self-review × 3, adversarial gate, domain guard, open PR
4. Print a summary with cost spent and PRs opened

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
| `git worktree add` fails | Filesystem doesn't support worktrees (Google Drive, some FUSE mounts) | The runner auto-falls-back to `git clone`. If both fail, check `git status` in `REPO_ROOT`. |
| `pnpm install` fails inside worktree | Worktree lacks `node_modules` symlinks | The loop runs `pnpm install` in each worktree by design. Ensure the worktree path is writable. |
| Adversarial gate keeps blocking | Diff is genuinely contradictory or oversized | Check the gate's reason string; usually the LLM has a real point. Lower `maxAttempts` to fail faster. |
| Cost cap hit immediately | Budget too low for selected models | Either bump `dailyBudgetUSD` or downgrade `executionModel` from `opus` to `sonnet`. |
