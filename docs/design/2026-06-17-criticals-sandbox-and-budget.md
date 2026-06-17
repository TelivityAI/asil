# Design — Critical fixes #1 (execution sandbox) + #2 (budget coverage)

Status: **proposed** — awaiting decision on sandbox depth before implementation.
Source: Codex whole-repo review (`CODEX_REVIEW.md`), findings #1 and #2 (both `critical`).

---

## Critical #2 — Full budget-checkpoint coverage

### Problem (grounded in code)

`loop.ts` creates one `CostCheckpoint` per task and records spend **only** for `executeTask()` (`loop.ts:~273`). The two downstream LLM stages are unaccounted:

- **`selfReview()`** (`self-review.ts:73`) runs three persona calls and returns per-persona `tokenUsage`, but the loop never records it against the checkpoint. Spend is invisible to the budget.
- **`adversarialReview()`** (`adversarial-gate.ts:16`) is worse: `CodexCaller.call()` returns `{ content }` **only — no token fields at all** (`wiring.ts` `createCodexCaller`). The adversarial gate's spend is untracked *at the source*, not merely unrecorded.

System B has the same shape: `papa.ts:83` records an aggregate **after** the thinker fan-out completes, with no `forceCheck()` before fanning out — so a budget already near its ceiling still launches N parallel thinker calls.

Net effect: System A can spend ~3× (executor + 3 personas + adversarial) what the budget sees, and the kill switch can't fire mid-task. The cost-controller's headline guarantee is partially fictional.

### Fix

1. **`selfReview(execution, llm, model, checkpoint?)`** — thread the checkpoint in. After each persona call, `checkpoint.recordAndCheck(inTok, outTok, model)`; if it returns `recommendation: 'kill'`, stop the remaining personas and return a partial result flagged `budget-exhausted`. Add a `forceCheck()` *before* the persona fan-out so a task already over budget never starts review.

2. **`CodexCaller` gains a token surface.** Change the contract from `{ content }` to `{ content; inputTokens; outputTokens }`. `createCodexCaller` parses OpenAI's `usage` block; `createOpenAICompatibleCodexCaller` reuses the chars/4 estimate the LLM adapter already has. Then `adversarialReview` returns token usage and the loop records it. (This is the one interface change — small, additive, and the OpenAI-compatible side already has the estimator.)

3. **`papa.ts`** — `forceCheck()` before the fan-out; record each thinker call individually rather than one aggregate after. The plumbing already passes a checkpoint in, so this is a record-placement change.

4. **Loop records every stage.** After self-review and after adversarial, `recordAndCheck`; on `kill`, mark the task `budget-exceeded` and break (same path the executor stage already uses).

### Risk / blast radius

Low. `selfReview` and `adversarialReview` gain an optional/required param; the analyzer and canary tests that call them with mocks need the extra arg. The `CodexCaller` contract change touches `wiring.ts` (2 factories), `adversarial-gate.ts`, the loop, and their tests. No algorithm changes. ~1 day including tests. This is **implementation-ready** — no open design questions.

---

## Critical #1 — Execution sandbox hardening

### Problem (grounded in code)

ASIL runs untrusted code with trusted credentials:

- `loop.ts:~217` runs `pnpm install --frozen-lockfile`, then `pnpm -r build`, then (in the executor) `pnpm typecheck` / `pnpm test`, all inside a worktree of the **target** repo.
- `wiring.ts:~298` (`createCommandRunner`) uses `execFile` with **no `env` option → full parent-process environment inheritance**.

So any `postinstall`/`prepare` script, any build step, any test in the target repo runs with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`/gh creds, and the user's entire env in scope — and (until PR #8) with `pnpm install` running lifecycle scripts by default. This is remote-code-execution-with-secret-exfiltration by design for any repo ASIL is pointed at. For a tool whose pitch is "point it at a repo and walk away," that's the headline risk.

### Design — layered, choose a depth for v1

Four levels, increasing isolation and cost. They compose — each builds on the prior.

| Level | What | Stops | Cost to build | New runtime dep |
|---|---|---|---|---|
| **0** (today) | worktree isolation only | nothing env-level | — | — |
| **1 — Process hardening** | `--ignore-scripts` on install; **env allowlist** (pass only PATH, HOME, a scrubbed minimal set — never the API keys) to the CommandRunner for target-repo commands; separate the PR-creation credential (gh token) from the execution environment so it's never in scope during install/build/test | secret exfil via scripts; lifecycle-script RCE on install | ~1 day, pure code | none |
| **2 — Containerized exec** | run install/build/test inside a container (Docker/Podman) with `--network=none` for the install+build+test phases, a read-only mount of the worktree except the work dir, and an empty env save the allowlist | network exfil; most filesystem escape; persistent host effects | ~3–5 days | container runtime |
| **3 — microVM / gVisor** | same as 2 but with a VM/syscall-filtering boundary | kernel-level escapes | weeks | firecracker/gVisor |

### Recommendation

**Ship Level 1 as v1**, document Level 2 as an opt-in (`ASIL_SANDBOX=container`) follow-on, leave Level 3 as a note for adopters with hostile-input threat models.

Rationale: Level 1 is pure code, no infra, and removes the **highest-severity, highest-likelihood** vector — credential exfiltration. `--ignore-scripts` already half-landed culturally (PR #8 made install-failure fatal). An env allowlist on the CommandRunner is a contained change. Level 2 is the right *eventual* default for running against genuinely untrusted repos, but forcing a container runtime as a hard dependency now would hurt adoption for the common case (a team running ASIL on its own repo), and it's a clean opt-in later.

### Level 1 specifics

1. **CommandRunner env allowlist.** `createCommandRunner({ envAllowlist?: string[] })`. When set, `execFile(..., { env: pick(process.env, allowlist) })`. Default allowlist: `PATH`, `HOME`, `LANG`, `TMPDIR`, `npm_config_*` as needed for pnpm. **Never** `*_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN`. The LLM callers keep their keys because they read them at construction time in the runner *parent* process — the keys never need to be in the *child* (pnpm/git) env.
2. **`--ignore-scripts` on install** by default; `ASIL_ALLOW_INSTALL_SCRIPTS=1` to opt back in for repos that genuinely need them (rare, and the operator is then explicitly accepting the risk).
3. **Credential separation for PR creation.** `gh pr create` needs the GitHub token; install/build/test do not. Scope the gh token to only the `createPR` step's env, never the execution steps'. (The git operations that need auth — push — also only need it at push time, not during build.)
4. **Docs:** a "Running ASIL against untrusted repos" hardening section in the README + `examples/local-llm.md` sibling, stating plainly what Level 1 does and does not protect against, and pointing hostile-input users to Level 2 when it lands.

### Risk / blast radius

Medium. The env-allowlist change is the sensitive part: strip too much and pnpm/tsc/vitest break in the target repo (e.g., a repo that needs a registry token in `.npmrc` via env). Mitigation: the allowlist is configurable, and we ship a generous-but-secret-free default, with a clear error path when a build fails for missing-env reasons. ~1–1.5 days for Level 1 including tests + docs.

---

## Sequencing

1. **#2 budget coverage** first — implementation-ready, no open questions, and it's a correctness/honesty fix for the cost-controller's core promise.
2. **#1 Level 1** second — pending the depth decision below.

Each ships as its own PR against `main` (branch protection requires PRs).

## Open decision (for the user)

**How deep should the v1 sandbox go?** Level 1 (process hardening, ships now, no infra) is the recommendation; Level 2 (containerized) is the eventual default for untrusted input but adds a container-runtime dependency. This doc proceeds with Level 1 unless directed otherwise.
