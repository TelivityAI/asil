#!/usr/bin/env node
/**
 * System A runner — wires real API clients into the improvement loop
 * and runs it once (process up to --max-tasks tasks). Supports
 * --dry-run to scan and report without executing.
 */
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  EventSink,
  instrumentCodexCaller,
  instrumentLLMCaller,
  readEvents,
  runAnalyzer,
  wrapBudgetManager,
  writePerTaskTranscripts,
} from 'asil-analyzer';
import {
  createDomainAnswerStore,
  findDomainQuestions,
  pythonProfile,
  runLoop,
  scanCodebase,
  typescriptProfile,
  type ImprovementLoopConfig,
  type LanguageProfile,
  type LoopDeps,
  type Severity,
  type TaskCategory,
} from 'asil-improvement-loop';
import {
  createAnthropicCaller,
  createCodexCaller,
  createCommandRunner,
  createCostInfra,
  scrubbedEnv,
  createDiffApplier,
  createFileFetcher,
  createFileReader,
  createGitOps,
  createOpenAICompatibleCaller,
  createOpenAICompatibleCodexCaller,
  loadEnv,
} from './wiring.js';
import { triageDomainQuestions } from './triage.js';

interface Flags {
  maxTasks: number;
  skipCategories: TaskCategory[];
  dryRun: boolean;
  skipQuestions: boolean;
  /** Directory to write per-task transcripts + findings.md. When set, the
   *  LLM/Codex callers and budget manager are wrapped to capture every
   *  conversational turn for the deterministic analyzer to scan. */
  transcriptsDir: string | null;
  /** Language profile selector. Default: ts. */
  profile: 'ts' | 'python';
  /** Severity floor — tasks below this are never enqueued or run. Default: low. */
  minSeverity: Severity;
}

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

function resolveProfile(name: 'ts' | 'python'): LanguageProfile {
  return name === 'python' ? pythonProfile : typescriptProfile;
}

function parseFlags(argv: readonly string[]): Flags | null {
  const flags: Flags = {
    maxTasks: 5,
    skipCategories: [],
    dryRun: false,
    skipQuestions: false,
    transcriptsDir: null,
    profile: 'ts',
    minSeverity: 'low',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--max-tasks' && argv[i + 1]) {
      flags.maxTasks = Number.parseInt(argv[i + 1]!, 10);
      i += 1;
    } else if (a === '--skip' && argv[i + 1]) {
      flags.skipCategories = argv[i + 1]!
        .split(',')
        .map((s) => s.trim()) as TaskCategory[];
      i += 1;
    } else if (a === '--dry-run') {
      flags.dryRun = true;
    } else if (a === '--skip-questions') {
      flags.skipQuestions = true;
    } else if (a === '--transcripts' && argv[i + 1]) {
      const raw = argv[i + 1]!;
      flags.transcriptsDir = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
      i += 1;
    } else if (a === '--profile' && argv[i + 1]) {
      const v = argv[i + 1]!;
      if (v !== 'ts' && v !== 'python') {
        console.error(`Unknown --profile value: ${v} (expected 'ts' or 'python')`);
        return null;
      }
      flags.profile = v;
      i += 1;
    } else if (a === '--min-severity' && argv[i + 1]) {
      const v = argv[i + 1]!;
      if (!SEVERITIES.includes(v as Severity)) {
        console.error(
          `Unknown --min-severity value: ${v} (expected one of: ${SEVERITIES.join(', ')})`,
        );
        return null;
      }
      flags.minSeverity = v as Severity;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      return null;
    }
  }
  return flags;
}

const HELP = `Usage: pnpm run:a [options]

Options:
  --max-tasks N       Max tasks per run (default: 5)
  --skip cat1,cat2    Skip categories (e.g. dependency-update,documentation)
  --dry-run           Scan and report tasks without executing
  --skip-questions    Bypass interactive triage of DOMAIN_QUESTION markers
                      (still excludes their files from the run)
  --transcripts DIR   Capture per-task LLM transcripts to DIR and run the
                      deterministic 5-failure-mode analyzer at the end
                      (writes findings.md alongside the per-task JSON files).
                      Zero extra LLM cost; analyzer is purely deterministic.
  --profile NAME      Language profile for the scanner. One of: ts, python.
                      Defaults to ts. Python requires pytest-json-report
                      and mypy on PATH.
  --min-severity SEV  Severity floor. Tasks below SEV are never enqueued or
                      run. One of: critical, high, medium, low (default: low).
  --help, -h          Show this help`;

export async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags) {
    console.log(HELP);
    process.exit(0);
  }

  const env = loadEnv();

  // pnpm --filter changes cwd to the package dir (autonomous/runners/).
  // Resolve the actual git repo root so scanner paths, config paths, and
  // worktree paths all agree on what "relative to repo root" means.
  try {
    env.REPO_ROOT = execSync('git rev-parse --show-toplevel', {
      cwd: env.REPO_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    // Not a git repo — keep whatever loadEnv returned.
  }

  if (!env.OPENAI_API_KEY && !flags.dryRun) {
    console.error('❌ OPENAI_API_KEY required for System A (adversarial gate).');
    console.error('   Set it in your environment or .env file.');
    process.exit(1);
  }

  // The loop's runner executes UNTRUSTED target-repo code (pnpm
  // install/build/test, tsc, grep) inside worktrees. Strip secrets from
  // its environment so a malicious postinstall/build/test script can't
  // exfiltrate ANTHROPIC_API_KEY / OPENAI_API_KEY / git tokens. The LLM
  // callers hold their keys in THIS process (read at construction), so
  // they're unaffected. GitOps (push / gh pr create) uses its own
  // full-env runner — credential separation. (Codex review #1, Level 1.)
  const runner = createCommandRunner({ env: scrubbedEnv() });
  const fileReader = createFileReader();

  console.log('\n🔄 System A — Autonomous Improvement Loop');
  console.log(`   Max tasks: ${flags.maxTasks}`);
  console.log(
    `   Skip: ${flags.skipCategories.length > 0 ? flags.skipCategories.join(', ') : 'none'}`,
  );
  console.log(`   Min severity: ${flags.minSeverity}`);
  console.log(`   Dry run: ${flags.dryRun}\n`);

  const profile = resolveProfile(flags.profile);

  if (flags.dryRun) {
    const scan = await scanCodebase(
      env.REPO_ROOT,
      { runner, fs: fileReader },
      profile,
    );
    console.log(
      `📋 Scan found ${scan.tasks.length} tasks (${scan.scanDurationMs}ms):\n`,
    );

    const byCategory = new Map<string, number>();
    for (const task of scan.tasks) {
      byCategory.set(task.category, (byCategory.get(task.category) ?? 0) + 1);
    }
    for (const [cat, count] of [...byCategory.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`   ${cat}: ${count}`);
    }

    console.log('\nTop 10 by discovery order:');
    for (const task of scan.tasks.slice(0, 10)) {
      console.log(
        `   [${task.severity}] ${task.category}: ${task.title}`,
      );
      console.log(`          ${task.filePaths.join(', ')}`);
    }
    return;
  }

  // Informational — worktree isolation means uncommitted changes in
  // the main checkout are safe from the loop. We still surface a note
  // so the user knows their in-flight work wasn't forgotten about.
  const gitStatus = await runner.run('git', ['status', '--porcelain'], {
    cwd: env.REPO_ROOT,
  });
  if (gitStatus.exitCode === 0 && gitStatus.stdout.trim()) {
    console.log(
      "⚠️  Working tree has uncommitted changes. The autonomous loop runs in isolated git worktrees, so your changes are safe.\n",
    );
  }

  // When --transcripts is set, wrap every LLM/Codex call and the
  // BudgetManager.allocate boundary so the analyzer can attribute each
  // conversational turn to its task. The wrapping is transparent — the
  // returned LLMCaller/CodexCaller match the same shape as the real
  // ones — so the rest of the runner is unchanged.
  let sink: EventSink | null = null;
  if (flags.transcriptsDir) {
    mkdirSync(flags.transcriptsDir, { recursive: true });
    sink = new EventSink(join(flags.transcriptsDir, 'events.jsonl'));
    sink.append({
      kind: 'run-start',
      ts: new Date().toISOString(),
      extra: {
        repoRoot: env.REPO_ROOT,
        maxTasks: flags.maxTasks,
        skipCategories: flags.skipCategories,
      },
    });
  }

  // Pick the LLM adapter based on env. ASIL_LLM_BASE_URL → local-mode
  // (Ollama, LM Studio, vLLM, llama.cpp server, OpenRouter, Azure
  // OpenAI). Otherwise use the cloud Anthropic adapter. Same for the
  // adversarial gate via ASIL_CODEX_BASE_URL.
  const llmBaseUrl = process.env.ASIL_LLM_BASE_URL ?? '';
  const llmModelId = process.env.ASIL_LLM_MODEL ?? 'sonnet';
  const realLLM = llmBaseUrl
    ? createOpenAICompatibleCaller({
        baseUrl: llmBaseUrl,
        apiKey: process.env.ASIL_LLM_API_KEY,
      })
    : createAnthropicCaller(env.ANTHROPIC_API_KEY);

  const codexBaseUrl = process.env.ASIL_CODEX_BASE_URL ?? '';
  const realCodex = codexBaseUrl
    ? createOpenAICompatibleCodexCaller({
        baseUrl: codexBaseUrl,
        apiKey: process.env.ASIL_CODEX_API_KEY,
      })
    : createCodexCaller(env.OPENAI_API_KEY);
  const llm = sink ? instrumentLLMCaller(realLLM, sink) : realLLM;
  const codex = sink ? instrumentCodexCaller(realCodex, sink) : realCodex;
  const git = createGitOps(env.REPO_ROOT);
  const costInfra = createCostInfra(env.REPO_ROOT);
  const budgetManager = sink
    ? wrapBudgetManager(costInfra.budgetManager, sink)
    : costInfra.budgetManager;
  const diff = createDiffApplier();
  const fileFetcher = createFileFetcher();

  const config: ImprovementLoopConfig = {
    // Cloud default: Sonnet for both. Local mode: caller can override
    // via ASIL_LLM_MODEL (e.g. 'llama3.1:8b-instruct-q4_K_M') which the
    // OpenAI-compatible adapter passes verbatim to the local server.
    // Cast: ModelTier is opus|sonnet|haiku for cloud pricing; local
    // ids fall through cost-estimator's unknown-model branch as $0.
    executionModel: llmModelId as 'opus' | 'sonnet' | 'haiku',
    reviewModel: llmModelId as 'opus' | 'sonnet' | 'haiku',
    maxTasksPerRun: flags.maxTasks,
    maxAttempts: 2,
    taskCooldownMs: 5000,
    markdownSkillsPath:
      process.env.ASIL_SKILLS_PATH ?? resolve(env.REPO_ROOT, '.asil', 'skills'),
    repoRoot: env.REPO_ROOT,
    queuePath:
      process.env.ASIL_QUEUE_PATH ??
      resolve(env.REPO_ROOT, '.asil', 'usage-data', 'queue.json'),
    skipCategories: flags.skipCategories,
    minSeverity: flags.minSeverity,
    codexConfig: {
      apiKey: 'OPENAI_API_KEY',
      model: 'gpt-4o',
    },
  };

  // Domain-question triage. Block the loop on any unresolved
  // `// DOMAIN_QUESTION:` markers — present each with Opus-generated
  // proposed answers, accept a numeric pick / free-text / skip / abort.
  // `--skip-questions` bypasses the prompt but still excludes blocked
  // files from the run (so the loop never silently makes decisions in
  // code Dušan hasn't decided about).
  const domainStore = createDomainAnswerStore(env.REPO_ROOT);
  let blockedFiles = new Set<string>();

  if (flags.skipQuestions) {
    const questions = await findDomainQuestions({
      repoRoot: env.REPO_ROOT,
      runner,
    });
    for (const q of questions) {
      if (!domainStore.getAnswer(q.hash)) blockedFiles.add(q.filePath);
    }
    if (blockedFiles.size > 0) {
      console.log(
        `⏩ --skip-questions: ${blockedFiles.size} file(s) with unresolved domain questions excluded from this run.\n`,
      );
    }
  } else {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const triage = await triageDomainQuestions({
        repoRoot: env.REPO_ROOT,
        runner,
        llm,
        store: domainStore,
        io: {
          print: (msg) => console.log(msg),
          ask: (prompt) => rl.question(prompt),
        },
      });
      blockedFiles = triage.blockedFiles;
      if (triage.aborted) {
        console.log('Aborted before grind started. No tasks were executed.');
        return;
      }
      if (triage.newAnswers.length > 0) {
        console.log(
          `📝 Recorded ${triage.newAnswers.length} new domain answer(s) → ${domainStore.filePath}\n`,
        );
      }
    } finally {
      rl.close();
    }
  }

  console.log('🔍 Scanning codebase and processing queue...\n');

  const deps: LoopDeps = {
    llm,
    codex,
    git,
    tracker: costInfra.tracker,
    budgetManager,
    runner,
    fileReader,
    fileFetcher,
    diff,
    blockedFiles,
    domainAnswerStore: domainStore,
    profile,
  };

  const result = await runLoop(config, deps);

  if (result.canaryGateAborted) {
    console.error('\n🚨 Canary gate FAILED — loop aborted before processing tasks.');
    console.error(`   Failed canary: ${result.canaryGateResult?.failedCanary}`);
    console.error(`   Reason: ${result.canaryGateResult?.failureReason}`);
    console.error('   A safety guard may have regressed. Investigate before re-running.');
    process.exitCode = 1;
    return;
  }

  console.log('\n📊 Results:');
  console.log(`   Tasks processed: ${result.tasksProcessed}`);
  console.log(`   PRs opened: ${result.prsOpened}`);
  console.log(
    `   Rejected (self-review): ${result.outcomes.filter((o) => o.status === 'rejected-self-review').length}`,
  );
  console.log(
    `   Rejected (adversarial): ${result.outcomes.filter((o) => o.status === 'rejected-adversarial').length}`,
  );
  console.log(
    `   Execution failures: ${result.outcomes.filter((o) => o.status === 'execution-failed').length}`,
  );
  console.log(`   Budget exhausted: ${result.budgetExhausted}`);
  console.log(`   Cycles detected: ${result.cyclesDetected}`);

  const prs = result.outcomes.filter((o) => o.status === 'pr-opened');
  if (prs.length > 0) {
    console.log('\n🎉 PRs opened:');
    for (const outcome of prs) {
      if (outcome.prUrl) console.log(`   ${outcome.prUrl}`);
    }
  }

  // Pending domain questions count — re-scan post-run since some may
  // have been answered during triage. If any are still unresolved
  // (i.e. operator skipped them this run), nudge so they don't get
  // forgotten.
  const postRunQuestions = await findDomainQuestions({
    repoRoot: env.REPO_ROOT,
    runner,
  });
  const stillUnresolved = postRunQuestions.filter(
    (q) => !domainStore.getAnswer(q.hash),
  );
  if (stillUnresolved.length > 0) {
    console.log(
      `\n📋 ${stillUnresolved.length} domain question${stillUnresolved.length === 1 ? '' : 's'} still pending — answer them on the next \`pnpm auto grind\` to unblock the affected files.`,
    );
  }

  // Per-task failure detail — if the loop recorded any non-PR outcomes,
  // print the stored queue reason so the operator can see WHY each task
  // failed rather than just a count. The verbose executor + loop
  // logging prints the full error at the moment it happens; this is
  // the end-of-run summary view.
  const failed = result.outcomes.filter((o) => o.status !== 'pr-opened' && o.status !== 'cycle-skipped');
  if (failed.length > 0) {
    console.log('\n⚠️  Failure detail:');
    const { TaskQueue } = await import('asil-improvement-loop');
    const queue = new TaskQueue(config.queuePath);
    for (const outcome of failed) {
      const item = queue.snapshot().find((i) => i.task.id === outcome.taskId);
      // Prefer the outcome's failureReason (set by pr-builder/executor
      // with the actual git/gh/llm error), then the queue's stored
      // reason, then a placeholder.
      const reason =
        outcome.failureReason ??
        item?.lastFailureReason ??
        '(no reason recorded)';
      console.log(`   [${outcome.status}] ${outcome.taskId}`);
      console.log(`      ${reason}`);
    }
  }

  // When --transcripts was set, split the events stream into per-task
  // JSON files and run the deterministic 5-failure-mode analyzer.
  // Zero LLM calls; purely lexical scans over the captured transcripts.
  if (sink && flags.transcriptsDir) {
    const eventsFile = join(flags.transcriptsDir, 'events.jsonl');
    sink.append({
      kind: 'note',
      ts: new Date().toISOString(),
      text: 'run-completed',
      details: {
        tasksProcessed: result.tasksProcessed,
        prsOpened: result.prsOpened,
      },
    });
    const split = writePerTaskTranscripts(readEvents(eventsFile), flags.transcriptsDir);
    const findingsPath = join(flags.transcriptsDir, 'findings.md');
    runAnalyzer({ transcriptsDir: flags.transcriptsDir, outFile: findingsPath });
    console.log(`\n📝 Transcripts: ${split.tasksWritten} task file(s) written.`);
    console.log(`📊 Analyzer findings: ${findingsPath}`);
  }
}

