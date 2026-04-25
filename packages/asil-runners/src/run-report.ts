#!/usr/bin/env node
/**
 * System C runner — prints a daily / weekly / monthly usage report
 * from the persisted tracker state.
 */
import { createCostInfra, loadEnv } from './wiring.js';

type Period = 'daily' | 'weekly' | 'monthly';

function parsePeriod(arg: string | undefined): Period | null {
  if (!arg || arg === 'daily') return 'daily';
  if (arg === 'weekly' || arg === 'monthly') return arg;
  return null;
}

export async function main(): Promise<void> {
  const period = parsePeriod(process.argv[2]);
  if (!period) {
    console.error('Usage: pnpm run:report [daily|weekly|monthly]');
    process.exit(1);
  }

  const env = loadEnv();
  const costInfra = createCostInfra(env.REPO_ROOT);

  const report =
    period === 'daily'
      ? costInfra.reporter.daily()
      : period === 'weekly'
        ? costInfra.reporter.weekly()
        : costInfra.reporter.monthly();

  console.log(costInfra.reporter.formatMarkdown(report));
}

