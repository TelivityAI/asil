# ASIL — Autonomous Software Improvement Loop

> Scan a codebase. Find issues. Generate fixes. Review them three times. Stop when domain expertise is required. Open a PR only when every gate passes.

ASIL is the open-source extract of a production autonomous coding pipeline. It is the first publicly-available system that pairs autonomous code generation with **multi-gate review, cost control, and a domain-expertise boundary** — so the loop knows when to keep working and when to stop and ask a human.

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  System C   │    │  System B   │    │  System A   │
│ Cost Ctrl   │◀──▶│  Thought    │◀──▶│ Improvement │
│             │    │ Multiplier  │    │    Loop     │
└─────────────┘    └─────────────┘    └─────────────┘
   token budget       strategic         scan → fix →
   per-task caps      thinking          self-review →
   kill switch        synthesizer       adversarial gate →
   checkpoints        papa agent        domain guard →
                                        open PR
```

## Why this exists

Today's autonomous coding agents (Cursor's background agents, GitHub Copilot Workspace, Devin, etc.) have three structural problems:

1. **They guess when they hit domain-specific code.** A pricing rule, a regulatory constraint, a contract clause, a vendor-specific quirk — the model invents a plausible-sounding answer because it has to keep going. The wrong answer ships.
2. **They have no built-in cost controls.** A runaway loop or a fan-out that picks the wrong model can burn $200 of API spend before anyone notices.
3. **They don't review their own work.** The same model that wrote the change confirms it's good. Self-review by the writer is theater.

ASIL fixes all three at the architecture level, not as an afterthought:

- A **domain guard** detects when the code being changed is in a region the maintainer has flagged as needing human input, and blocks the autonomous fix until a human triages it.
- A **cost controller** tracks token spend per task, per system, per day, with checkpoints and a hard kill switch.
- A **three-persona self-review** (code reviewer, security auditor, test engineer) plus a **separate-LLM adversarial gate** challenges the work before any PR is opened.

## How it works

ASIL is composed of three orthogonal systems that you can adopt independently or wire together:

### System C — Cost Controller

Token budget governor. The substrate every other system runs on.

- `BudgetManager` allocates per-task budgets sized by category and model tier
- `TokenTracker` persists actual spend to disk
- `CostCheckpoint` is the runtime API: every LLM call passes through it, and it can refuse the call when budget is exhausted
- `KillSwitch` enforces hard daily caps
- `UsageReporter` formats spend rollups for inbox / Slack delivery
- `decimal.js` for every cost calculation — no float drift on currency

### System B — Thought Multiplier

Strategic thinking layer. Use this when one model giving one answer isn't good enough.

- A **router** decides which specialized thinkers a request needs (architecture, planning, test strategy, security, API design, spec writing)
- Each **thinker** runs independently with its own system prompt and JSON output envelope
- A **synthesizer** merges their recommendations, surfaces conflicts, and computes a confidence score
- The **papa agent** (Opus-tier) resolves conflicts and produces a final handoff brief
- Every step accounts its tokens through System C

### System A — Improvement Loop

The grind. Runs unattended.

```
scan → cycle-detect → triage domain questions → for each task:
  isolate (worktree)
    execute (LLM-generated patch, applied via diff)
    typecheck + tests
    self-review × 3 personas (reviewer, security, test-engineer)
    adversarial gate (different LLM provider)
    domain guard
    open PR
```

- **Scanner** picks up five categories: test failures, type errors, TODO resolution, dead code, coverage gaps
- **Cycle detector** prevents the loop from churning on the same file repeatedly
- **Worktree isolation** — every task runs in a disposable git worktree (auto-falls-back to `git clone` on filesystems that don't support worktrees)
- **Self-review** runs three persona prompts scoped strictly to the diff
- **Adversarial gate** sends the diff to a different model (different provider, different family) to challenge the work
- **Domain guard** blocks the PR if the diff touches a `// DOMAIN_QUESTION:` zone with no resolved answer

## Quick start

```bash
# 1. Install
git clone https://github.com/telivity-otaip/asil asil
cd asil
pnpm install
pnpm build

# 2. Configure environment
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
export REPO_ROOT=$(pwd)/path/to/your/target/repo

# 3. Use the thought multiplier (System B) standalone
pnpm --filter asil-runners run:b "add rate limiting to the connect API endpoint"

# 4. Run the autonomous loop (System A)
pnpm --filter asil-runners auto grind --dry-run
pnpm --filter asil-runners auto grind --max-tasks 3
```

See [`examples/quickstart.md`](examples/quickstart.md) for a five-minute integration walkthrough.

## What it looks like

```
$ pnpm --filter asil-runners auto grind --max-tasks 5

🤖 ASIL — Autonomous Improvement Loop
   Repo: /workspace/your-app
   Budget: $20.00 / day, $0.40 / task

🔍 Scanning…
   ✓ test-failure       12 candidates
   ✓ type-error          3 candidates
   ✓ todo-resolution    27 candidates
   ✓ dead-code           7 candidates
   ✓ coverage-gap        3 candidates
   → 52 tasks queued (in 9.2s)

❓ 4 tasks block on unresolved DOMAIN_QUESTION markers.
   Would you like to triage them now? [y/n] y

   [1/4] packages/billing/src/rates.ts:124
         "How is the late-payment grace period calculated?"
         Proposals from Opus:
           a) 5 calendar days from due date
           b) 5 business days excluding bank holidays
           c) Cannot be answered without the contract terms
         Choose [a/b/c] or type a custom answer:

[…all four answered or deferred…]

🔧 Running 5 tasks in isolated worktrees…
   ✓ task-001 type-error packages/api/src/handlers/refund.ts
     ✓ typecheck (1.4s)  ✓ tests (12.3s)
     ✓ reviewer    pass
     ✓ security    pass
     ✓ test-eng    pass
     ✓ adversarial pass
     ✓ domain      no DOMAIN_QUESTION zones touched
     ✓ PR opened: #1247

   ✗ task-003 todo-resolution packages/billing/src/audit.ts
     ✗ adversarial gate raised a blocker:
       "The diff removes the audit-log entry but the
        commit message says 'preserve audit trail'."
     → reverted, returned to queue with note for next pass

   …

📊 Summary
   Completed: 3 PRs opened  ($0.84 spent)
   Failed:    1 (adversarial gate)
   Skipped:   1 (cycle detection — same file 3rd attempt)
```

## Architecture

```
                       ┌────────────────────────────┐
                       │       System C (Cost)      │
                       │  TokenTracker              │
                       │  BudgetManager             │
                       │  CostCheckpoint            │
                       │  KillSwitch                │
                       │  UsageReporter             │
                       └────────────────────────────┘
                              ▲             ▲
                              │             │
            allocates budget  │             │  records spend
            checks            │             │
                              │             │
   ┌──────────────────────────┴───┐  ┌──────┴──────────────────────────┐
   │     System B (Thought)       │  │     System A (Improvement)      │
   │  router → thinkers →         │  │  scanner → executor →           │
   │  synthesizer → papa          │  │  self-review → adversarial →    │
   │  → handoff brief             │  │  domain guard → PR              │
   └──────────────────────────────┘  └─────────────────────────────────┘
```

Every LLM call in B and A flows through a `CostCheckpoint`. Each checkpoint is bound to a `(taskId, systemId, agentId)` triple so spend can be attributed in reports. When a budget is exhausted mid-task, the checkpoint refuses further calls and the task is rolled back cleanly.

## Configuration

| Knob | Where | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | env | required | Primary LLM |
| `OPENAI_API_KEY` | env | required | Adversarial gate (different provider) |
| `REPO_ROOT` | env | required | Absolute path to the target repo |
| `ASIL_USAGE_DATA_DIR` | env | `<REPO_ROOT>/.asil/usage-data` | Cost tracker state |
| `ASIL_QUEUE_PATH` | env | `<REPO_ROOT>/.asil/usage-data/queue.json` | Task queue |
| `ASIL_SKILLS_PATH` | env | `<REPO_ROOT>/.asil/skills` | Markdown skills the thinkers load |
| `ASIL_DOMAIN_ANSWERS_PATH` | env | `<REPO_ROOT>/.asil/domain-answers.json` | Resolved domain answers |
| `papaModel` / `thinkerModel` | `ThoughtMultiplierConfig` | `opus` / `sonnet` | Model tiers per role |
| `executionModel` / `reviewModel` | `ImprovementLoopConfig` | `sonnet` / `sonnet` | Model tiers in System A |
| `maxTasksPerRun` | `ImprovementLoopConfig` | CLI flag | Hard cap per `auto grind` |
| `maxAttempts` | `ImprovementLoopConfig` | `2` | Per-task retry cap |
| `taskCooldownMs` | `ImprovementLoopConfig` | `5000` | Throttle between tasks |
| `skipCategories` | `ImprovementLoopConfig` | `[]` | Disable scanner categories |
| `securityWeight` | `ThoughtMultiplierConfig` | `0.7` | Conflict-resolution weight |
| `projectName` | `ThoughtMultiplierConfig` | `"Project"` | Header in generated brief |
| `projectDoNotChange` | `ThoughtMultiplierConfig` | `[]` | Project-specific "do not modify" entries |
| `dailyBudgetUSD` | `BudgetManagerConfig` | `20.00` | Cost-controller daily cap |
| `canaryGate` | `ImprovementLoopConfig` | `{ enabled: true }` | Pre-flight safety gate verification — set `enabled: false` to skip |

## Integration

ASIL is a TypeScript monorepo. Add the four packages to your workspace and wire them up via the `LoopDeps` and `LLMCaller` interfaces.

```ts
import { runLoop } from 'asil-improvement-loop';
import {
  createAnthropicCaller,
  createCodexCaller,
  createGitOps,
  createCostInfra,
  createDiffApplier,
  createFileFetcher,
} from 'asil-runners';

const llm = createAnthropicCaller(process.env.ANTHROPIC_API_KEY!);
const codex = createCodexCaller(process.env.OPENAI_API_KEY!);
const git = createGitOps(process.env.REPO_ROOT!);
const cost = createCostInfra(process.env.REPO_ROOT!);
const diff = createDiffApplier();
const files = createFileFetcher();

await runLoop({
  llm,
  codex,
  git,
  diff,
  fileFetcher: files,
  costInfra: cost,
  config: {
    executionModel: 'sonnet',
    reviewModel: 'sonnet',
    maxTasksPerRun: 5,
    maxAttempts: 2,
    taskCooldownMs: 5000,
    markdownSkillsPath: '.asil/skills',
    repoRoot: process.env.REPO_ROOT!,
    queuePath: '.asil/usage-data/queue.json',
    skipCategories: [],
    codexConfig: { apiKey: 'OPENAI_API_KEY', model: 'gpt-4o' },
  },
});
```

`LLMCaller` is a tiny mock-friendly interface (`call(systemPrompt, userPrompt, model) → Promise<{content, inputTokens, outputTokens}>`). The shipped wirings cover Anthropic and OpenAI; swapping in a local model, a self-hosted relay, or a different provider is a one-file change.

## Key innovations

- **Domain guard.** First system that explicitly detects domain-expertise boundaries via inline `// DOMAIN_QUESTION:` markers and refuses to fabricate answers. Unanswered questions block the affected files until a human triages them.
- **Three-persona self-review.** Code reviewer + security auditor + test engineer, each with its own scoped prompt, all run on the diff *only*. No prior-context pollution.
- **Adversarial gate.** A different LLM (different provider) reads the diff cold and tries to break it. Catches things the writer's family doesn't see.
- **Cost controller is first-class.** Budget allocation, per-call checkpoints, kill switch, daily caps, persisted state. Not a logging afterthought.
- **Worktree isolation with FUSE fallback.** Every task runs in a disposable `git worktree` clone. The main checkout is never touched. On filesystems where `worktree add` fails (Google Drive, some FUSE mounts), the runner falls back to `git clone` automatically.
- **Canary gates.** Pre-flight verification that safety guards haven't regressed. Three deterministic canaries run at the start of every `runLoop()` invocation — if any gate is silently broken, the loop aborts before processing real tasks. Zero LLM calls, zero token spend, deterministic.

## Canary Gates

Before processing any real tasks, the improvement loop runs three deterministic canary checks that verify the safety gates are still functional. If any canary fails, the loop aborts immediately — no tasks are processed, no PRs are opened.

**Why this matters:** Safety gates (Guard A, Guard B, domain guard) are the only thing standing between a hallucinating LLM and a destructive PR. A refactor that accidentally removes a guard check would silently allow dangerous diffs through. Canaries catch this at runtime, not just in the test suite.

**The three canaries:**

| Canary | Tests | How |
|--------|-------|-----|
| `destructive-diff` | Guard B (net-deletion >50%) | Feeds a synthetic file-block response that deletes 95% of a 25-line file. Expects Guard B to reject it. |
| `empty-content` | Guard A (empty prompt content) | Creates a real temp file, but provides empty content to the executor. Expects Guard A to refuse. |
| `domain-question` | Domain guard (blocked files) | Verifies the `isBlockedByDomainGuard` predicate correctly blocks tasks touching files with unresolved `DOMAIN_QUESTION` markers. |

**Characteristics:**
- Deterministic — no LLM calls, no network, no stochasticity
- Fast — runs in <50ms total
- Self-contained — each canary constructs its own mock infrastructure
- Default enabled — runs automatically unless explicitly disabled

**Disabling:** Set `canaryGate: { enabled: false }` in your `ImprovementLoopConfig`. You can also supply custom canaries via `canaryGate: { enabled: true, canaries: [...] }`.

## Requirements

- Node ≥ 20, pnpm ≥ 9
- A target repo that uses pnpm (the executor runs `pnpm install`, `pnpm build`, `pnpm test`, `pnpm typecheck` inside the worktree)
- Anthropic API key (primary)
- OpenAI API key (adversarial gate)

## Status

Production: this codebase has been running unattended in a 80+ agent travel AI platform, opening PRs autonomously every day, with a measurable rate of human-meaningful improvements landing in main without any reviewer override. This is the open-source extract — domain-specific code and proprietary prompts removed, public-safe defaults set, configuration knobs documented.

## License

MIT — see [LICENSE](LICENSE).

## Credit

Created by Dušan Milicevic ([Telivity](https://telivity.com)) — extracted from a production autonomous system managing an 80+ agent travel AI platform.
