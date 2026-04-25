#!/usr/bin/env node
/**
 * System B runner — takes a sentence of user intent, runs the thought
 * multiplier against real LLM APIs, and writes a production-ready
 * Claude Code handoff brief to HANDOFF-AUTO-<id>.md.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG, runPapa } from 'asil-thought-multiplier';
import type { UserRequest } from 'asil-thought-multiplier';
import {
  createAnthropicCaller,
  createCostInfra,
  loadEnv,
} from './wiring.js';

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: pnpm run:b "your build request here"');
    console.error(
      'Example: pnpm run:b "add rate limiting to the connect API endpoints"',
    );
    process.exit(1);
  }

  const input = args.join(' ');
  const env = loadEnv();
  const llm = createAnthropicCaller(env.ANTHROPIC_API_KEY);
  const costInfra = createCostInfra(env.REPO_ROOT);

  const requestId = randomUUID().slice(0, 8);
  const request: UserRequest = {
    id: requestId,
    input,
    timestamp: new Date(),
  };

  const budget = costInfra.budgetManager.allocate(
    `b-${requestId}`,
    'B',
    'thought-multiplier',
    DEFAULT_CONFIG.thinkerModel,
  );
  if (!budget) {
    console.error('❌ Could not allocate budget — daily or system cap reached.');
    process.exit(2);
  }

  const checkpoint = costInfra.createCheckpoint(
    `b-${requestId}`,
    'B',
    'papa',
  );

  console.log('\n🧠 System B — Thought Multiplier');
  console.log(`Request: "${input}"`);
  console.log(`Request ID: ${requestId}\n`);

  const config = {
    ...DEFAULT_CONFIG,
    markdownSkillsPath:
      process.env.ASIL_SKILLS_PATH ?? resolve(env.REPO_ROOT, '.asil', 'skills'),
  };

  const result = await runPapa(request, llm, checkpoint, config);

  console.log(
    `📡 Router activated: ${result.routing.activatedThinkers.join(', ')}`,
  );
  console.log(`   Reasoning: ${result.routing.reasoning}\n`);

  for (const output of result.thinkerOutputs) {
    console.log(
      `   ${output.role}: ${output.recommendations.length} recs, ${output.concerns.length} concerns (${
        output.costUsed.inputTokens + output.costUsed.outputTokens
      } tokens)`,
    );
  }

  console.log(
    `\n💰 Total tokens: ${result.totalCost.inputTokens} in / ${result.totalCost.outputTokens} out`,
  );

  if (result.escalated) {
    console.log('\n⚠️  ESCALATED TO HUMAN');
    console.log(`   Reason: ${result.escalationReason ?? 'unknown'}`);
    for (const c of result.synthesis.unresolvedConcerns) {
      console.log(`   - [${c.source}] ${c.description}`);
    }
    return;
  }

  if (result.brief) {
    const filename = `HANDOFF-AUTO-${requestId}.md`;
    const outputPath = resolve(env.REPO_ROOT, filename);
    writeFileSync(outputPath, result.brief.markdown, 'utf8');

    console.log(`\n✅ Brief written to: ${filename}`);
    console.log(
      `   Acceptance criteria: ${result.brief.acceptanceCriteria.length} items`,
    );
    console.log(`   Build steps: ${result.brief.steps.length}`);

    if (result.brief.domainQuestions.length > 0) {
      console.log('\n❓ Domain questions (need Dušan):');
      for (const q of result.brief.domainQuestions) {
        console.log(`   - ${q}`);
      }
    }

    if (result.synthesis.resolvedConflicts.length > 0) {
      console.log(
        `\n⚔️  Conflicts resolved: ${result.synthesis.resolvedConflicts.length}`,
      );
      for (const c of result.synthesis.resolvedConflicts) {
        console.log(
          `   - ${c.thinkerA} vs ${c.thinkerB}: ${c.resolution?.reasoning ?? 'unresolved'}`,
        );
      }
    }
  }
}

