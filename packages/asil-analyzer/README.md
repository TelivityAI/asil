# asil-analyzer

Deterministic reasoning-quality analyzer for ASIL transcripts.

Captures every LLM/Codex call during a grind run, splits the stream by task, and scans for five reasoning failure modes — **zero LLM calls in analysis**. Every detector is regex + lexical math + simple statistics.

## What it detects

| Mode | What it catches | How |
|---|---|---|
| **Sycophancy** | Reviewer echoes the proposer's framing before any independent analysis | Jaccard token overlap ≥ 0.40 between the reviewer's first 3 sentences and the executor response, AND no disagreement marker (`however`, `disagree`, `reject`, …) in those 3 sentences |
| **First-item bias** | When multiple options are enumerated, the first-listed one is chosen disproportionately | Regex on enumeration shape (`1. … 2. … 3. …`, `Option A/B/C`) + selection-phrase regex → distribution of selected indices |
| **Belief-action gap** | Stated confidence doesn't move the recommendation | Confidence regex (`0.3 confidence`, `30%`, `low/medium/high`) paired with valence keywords (`accept/approve/merge` vs `reject/block/fail`). Flags: (a) same confidence yields opposite valences across calls; (b) low confidence with definitive valence and no hedge |
| **Drift** | Within a task, two calls produce opposite valences on the same diff | Structured verdict-flip across the call sequence |
| **Multi-hop decay** | 3+-step conditional chains lose the intermediate condition | **Inconclusive under deterministic-only** — strong form requires an LLM judge. Deterministic fallback catches only the trivial sub-case: explicit self-contradiction (high-Jaccard sentences with flipped negation polarity) |

## Usage

Two layers — capture and analyze. Both run automatically when you pass `--transcripts <dir>` to `pnpm --filter asil-runners run:a`.

### Programmatic API

```ts
import {
  EventSink,
  instrumentLLMCaller,
  instrumentCodexCaller,
  wrapBudgetManager,
  writePerTaskTranscripts,
  readEvents,
  runAnalyzer,
} from 'asil-analyzer';

// 1. Wrap your real callers at deps-construction time.
const sink = new EventSink(join(transcriptsDir, 'events.jsonl'));
const llm = instrumentLLMCaller(realLLM, sink);
const codex = instrumentCodexCaller(realCodex, sink);
const budgetManager = wrapBudgetManager(realBudgetManager, sink);

// 2. Run the loop as usual with the wrapped deps.
await runLoop(config, { llm, codex, budgetManager, ... });

// 3. After the run, split events.jsonl into per-task transcripts +
// produce findings.md. Both are deterministic, zero LLM cost.
writePerTaskTranscripts(readEvents(eventsFile), transcriptsDir);
runAnalyzer({ transcriptsDir, outFile: join(transcriptsDir, 'findings.md') });
```

## Why deterministic

Two reasons:

1. **Cost.** A reasoning audit that costs another ~$30 of LLM time per grind is a tax that won't get paid. Determinism keeps the analyzer free.
2. **Calibration.** Deterministic detectors have known false-positive and false-negative shapes. LLM judges drift. Lexical thresholds (Jaccard ≥ 0.4, character-loss ≥ 50%) are reproducible across runs.

The trade-off is honest: the strong form of multi-hop decay needs semantic judgment we can't perform deterministically. That mode is reported as **Inconclusive — requires LLM judge, deferred** — better than a false negative.

## License

MIT.
