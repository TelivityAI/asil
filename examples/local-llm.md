# Running ASIL against a local LLM

ASIL's primary LLM adapter targets Anthropic by default, but the cost-controller, scanner, executor, and gate pipeline don't care which backend produces text. Any HTTP server that speaks the OpenAI-compatible `/v1/chat/completions` API can drop in: **Ollama, LM Studio, vLLM, llama.cpp server, OpenRouter, Azure OpenAI**, etc. One adapter, many backends.

This unlocks:
- Air-gapped deployments (regulated industries, gov, defense)
- Self-hosted inference on a GPU server inside your VPC
- Mixed deployments — local for execution, cloud for the adversarial gate (or vice versa)

## Env vars

| Variable | Purpose |
|---|---|
| `ASIL_LLM_BASE_URL` | Base URL of the OpenAI-compatible server (e.g. `http://localhost:11434/v1`). When set, `loadEnv` skips the `ANTHROPIC_API_KEY` requirement. |
| `ASIL_LLM_MODEL` | Model id passed verbatim to the server (e.g. `llama3.1:8b-instruct-q4_K_M`). Default `sonnet` (used only when `ASIL_LLM_BASE_URL` is unset — i.e. cloud mode). |
| `ASIL_LLM_API_KEY` | Optional bearer token sent as `Authorization: Bearer …`. Omit for servers that don't check auth (most local). |
| `ASIL_CODEX_BASE_URL` | Same shape as `ASIL_LLM_BASE_URL`, but for the adversarial gate (System A's separate-model challenger). When unset, the gate falls back to OpenAI cloud via `OPENAI_API_KEY`. |
| `ASIL_CODEX_API_KEY` | Bearer for the codex endpoint. Optional. |

## Recipes

### Ollama

```bash
ollama serve &
ollama pull llama3.1:8b-instruct-q4_K_M
ollama pull mistral-nemo  # for the adversarial gate

export ASIL_LLM_BASE_URL=http://localhost:11434/v1
export ASIL_LLM_MODEL=llama3.1:8b-instruct-q4_K_M
export ASIL_CODEX_BASE_URL=http://localhost:11434/v1
export ASIL_CODEX_API_KEY=ollama  # placeholder; Ollama ignores it
export REPO_ROOT=$(pwd)

pnpm --filter asil-runners run:a --max-tasks 2 --transcripts ./asil-transcripts/
```

### LM Studio

LM Studio serves an OpenAI-compatible endpoint on port 1234 by default:

```bash
export ASIL_LLM_BASE_URL=http://localhost:1234/v1
export ASIL_LLM_MODEL=$(your-loaded-model-id)   # e.g. "meta-llama-3.1-8b-instruct"
export REPO_ROOT=$(pwd)

pnpm --filter asil-runners run:a --max-tasks 2
```

### vLLM (GPU server)

```bash
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Meta-Llama-3.1-8B-Instruct \
  --port 8000

export ASIL_LLM_BASE_URL=http://10.0.1.42:8000/v1
export ASIL_LLM_MODEL=meta-llama/Meta-Llama-3.1-8B-Instruct
export REPO_ROOT=$(pwd)
```

### Mixed: cloud execution + local adversarial gate

Privacy-sensitive code can still leverage Anthropic's strongest model for the patch-writing step while running the adversarial review locally so the diff never leaves the VPC for the review path:

```bash
# Anthropic for execution (primary LLM)
export ANTHROPIC_API_KEY=sk-ant-…
# Local Llama for the adversarial gate
export ASIL_CODEX_BASE_URL=http://localhost:11434/v1
unset OPENAI_API_KEY
```

The reverse (local execution + cloud adversarial) also works — just swap the env vars.

## Cost accounting in local mode

The cost-controller tracks token spend per call. For known cloud tiers (`opus`/`sonnet`/`haiku`), pricing lookup is straightforward. For **local model ids**, the cost-estimator's pricing table has no entry; the estimator returns **$0** for those calls. Token counts are still recorded:

- If the local server reports `usage.prompt_tokens` / `usage.completion_tokens` in its response (Ollama via `/v1` does, vLLM does), those values flow through unchanged.
- If `usage` is absent (some llama.cpp builds, some lightweight servers), the adapter estimates via `ceil(chars / 4)` so the cost-controller's per-task and daily token caps still bite. Override via `OpenAICompatibleOptions.estimateTokens`.

The dollar number in the spend report will be \$0 in local mode. That's honest — wire cost is zero. If you want to model an internal chargeback rate, wrap the adapter and inject a custom pricing table.

## Token-cap behavior

The cost-controller's `BudgetManager` allocates a per-task token budget and triggers the kill switch when exceeded. **Token caps work in local mode** — the budget enforces the same `daily_token_limit` regardless of whether tokens cost money. Local inference is free at the wire but not at the GPU; capping tokens still bounds runtime.

## When NOT to use local mode

- **Production grinds against high-value codebases.** Local models trail Claude Sonnet by enough on tool-use accuracy that destructive-diff false negatives become more likely. The Guard A/B safety guards still protect you (PR #3), but you'll spend more time triaging.
- **The adversarial gate, on a model from the same family as the executor.** The whole point of the gate is cross-family review. Same-family runs are theater. If you have only one local model, leave the cloud adversarial in place.

## Quick smoke test

```bash
export ASIL_LLM_BASE_URL=http://localhost:11434/v1
export ASIL_LLM_MODEL=llama3.1
export REPO_ROOT=$(pwd)

# System B is the lowest-risk way to verify your local server works.
pnpm --filter asil-runners run:b "add rate limiting to the connect endpoint"
```

If you see a Markdown brief, the adapter is wired correctly.
