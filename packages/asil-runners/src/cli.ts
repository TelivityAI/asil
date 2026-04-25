#!/usr/bin/env node
/**
 * Unified `pnpm auto` entry point for all three autonomous systems.
 *
 * Loads env from autonomous/.env on startup so nothing else has to
 * `export ANTHROPIC_API_KEY=...` by hand, dispatches to the matching
 * runner's `main()`, and surfaces a concise budget `status` view.
 */
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// autonomous/.env — one dir up from src/, then one more up from runners/.
const envPath = resolve(here, '..', '..', '.env');
if (existsSync(envPath)) {
  loadDotenv({ path: envPath });
}

const HELP = `
  ASIL — Autonomous Improvement Loop

  Usage: pnpm auto <command> [options]

  Commands:
    think "..."           Turn a sentence into a handoff brief (System B)
    grind                 Run autonomous codebase improvement (System A)
    questions             List unresolved DOMAIN_QUESTION markers
    report [period]       Show token spend report (System C)
    status                Show budget remaining and active tasks
    help                  Show this help

  Examples:
    pnpm auto think "add rate limiting to the connect API endpoints"
    pnpm auto grind --dry-run
    pnpm auto grind --max-tasks 3
    pnpm auto grind --skip dependency-update,documentation
    pnpm auto grind --skip-questions
    pnpm auto questions
    pnpm auto report
    pnpm auto report weekly
    pnpm auto status

  Environment:
    Set ANTHROPIC_API_KEY and OPENAI_API_KEY in autonomous/.env
    OPENAI_API_KEY only needed for grind (adversarial gate)
`.trimStart();

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  io: { log: (msg?: string) => void; error: (msg?: string) => void } = {
    log: (msg) => console.log(msg ?? ''),
    error: (msg) => console.error(msg ?? ''),
  },
): Promise<number> {
  const [command, ...args] = argv;

  switch (command) {
    case 'think': {
      const input = args.join(' ');
      if (!input) {
        io.error('Usage: pnpm auto think "your build request"');
        return 1;
      }
      // Forward args to the run-b main() through process.argv (the runner
      // reads from process.argv.slice(2) — same pattern as the standalone
      // bin). Using the already-imported module avoids a subprocess spawn.
      process.argv = [process.argv[0] ?? 'node', 'run-b', ...args];
      const { main } = await import('./run-b.js');
      await main();
      return 0;
    }

    case 'grind': {
      process.argv = [process.argv[0] ?? 'node', 'run-a', ...args];
      const { main } = await import('./run-a.js');
      await main();
      return 0;
    }

    case 'report': {
      process.argv = [process.argv[0] ?? 'node', 'run-report', ...args];
      const { main } = await import('./run-report.js');
      await main();
      return 0;
    }

    case 'questions': {
      // Read-only listing of every DOMAIN_QUESTION marker. Useful for
      // ad-hoc review without starting a grind.
      const { loadEnv } = await import('./wiring.js');
      const { createCommandRunner } = await import('./wiring.js');
      const {
        findDomainQuestions,
        createDomainAnswerStore,
      } = await import('asil-improvement-loop');
      const env = loadEnv();
      const repoRoot = env.REPO_ROOT;
      const runner = createCommandRunner();
      const store = createDomainAnswerStore(repoRoot);
      const questions = await findDomainQuestions({ repoRoot, runner });
      const unresolved = questions.filter((q) => !store.getAnswer(q.hash));
      const answered = questions.length - unresolved.length;

      io.log('');
      io.log(
        `📋 ${questions.length} domain question(s) total — ${answered} answered, ${unresolved.length} pending`,
      );
      io.log('');
      if (unresolved.length === 0) {
        io.log('No pending questions. ✅');
        return 0;
      }
      for (const q of unresolved) {
        io.log(`   ${q.filePath}:${q.line}`);
        io.log(`     ${q.text}`);
        io.log('');
      }
      io.log(
        `Run \`pnpm auto grind\` to triage them interactively (or \`--skip-questions\` to bypass).`,
      );
      return 0;
    }

    case 'status': {
      const { loadEnv, createCostInfra } = await import('./wiring.js');
      const env = loadEnv();
      const infra = createCostInfra(env.REPO_ROOT);
      const util = infra.budgetManager.getUtilization();
      const remaining = util.dailyLimit.minus(util.dailySpend);

      io.log('');
      io.log('📊 Autonomous System Status');
      io.log('');
      io.log(`  Daily budget:  $${util.dailyLimit.toFixed(2)}`);
      io.log(
        `  Spent today:   $${util.dailySpend.toFixed(2)} (${(util.utilization * 100).toFixed(1)}%)`,
      );
      io.log(`  Active tasks:  ${util.activeTasks} / ${util.maxTasks}`);
      io.log(`  Remaining:     $${remaining.toFixed(2)}`);
      io.log('');
      return 0;
    }

    case undefined:
    case 'help':
    case '--help':
    case '-h': {
      io.log(HELP);
      return 0;
    }

    default: {
      io.error(`Unknown command: ${command}`);
      io.error('');
      io.log(HELP);
      return 1;
    }
  }
}

// Only auto-execute when invoked directly — importing from tests must not
// run the CLI as a side-effect.
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  runCli().then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
