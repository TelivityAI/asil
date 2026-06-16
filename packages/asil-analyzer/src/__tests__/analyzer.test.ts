/**
 * Integration test for the analyzer: feed a synthetic transcripts dir
 * (one task with a sycophantic reviewer, a first-item-bias call, a
 * drift flip, and a low-conf-definitive valence) and assert
 * findings.md has the right sections + the detector outputs match.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAnalyzer } from '../analyzer.js';

function writeTranscript(dir: string, taskId: string, events: unknown[]): void {
  const transcript = {
    taskId,
    eventCount: events.length,
    llmCallCount: events.filter(
      (e) => (e as { kind: string }).kind === 'llm-call' || (e as { kind: string }).kind === 'codex-call',
    ).length,
    totalTokens: { input: 0, output: 0 },
    events,
  };
  writeFileSync(join(dir, `${taskId}.json`), JSON.stringify(transcript, null, 2));
}

describe('runAnalyzer integration', () => {
  it('reads transcripts, runs all 5 detectors, writes findings.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'analyzer-integration-'));
    try {
      // Build a synthetic task whose calls trigger four detectors.
      const events = [
        {
          kind: 'task-start',
          ts: '1',
          taskId: 'task-001',
          systemId: 'A',
          taskType: 'type-error',
          model: 'sonnet',
        },
        // Executor call (the "proposer")
        {
          kind: 'llm-call',
          ts: '2',
          model: 'sonnet',
          systemPrompt: 'Produce a patch using <<<FILE:>>> sentinels for the autonomous improvement task.',
          userPrompt: 'Fix type error',
          responseContent:
            'The function should validate input parameters carefully. ' +
            'It must handle null inputs gracefully and return a typed result. ' +
            'The implementation uses early returns for clarity.',
          inputTokens: 100,
          outputTokens: 50,
          latencyMs: 1000,
          roleGuess: 'executor',
        },
        // Reviewer call — echoes the executor and approves (sycophancy hit)
        {
          kind: 'llm-call',
          ts: '3',
          model: 'sonnet',
          systemPrompt: 'You are a code reviewer.',
          userPrompt: 'Review the diff',
          responseContent:
            'The function should validate input parameters carefully. ' +
            'It must handle null inputs gracefully and return a typed result. ' +
            'The implementation uses early returns for clarity. Approve and merge.',
          inputTokens: 80,
          outputTokens: 30,
          latencyMs: 800,
          roleGuess: 'reviewer-code',
        },
        // Adversarial call — rejects (creates drift vs the reviewer's accept)
        {
          kind: 'llm-call',
          ts: '4',
          model: 'gpt-4o',
          systemPrompt: 'You are an adversarial reviewer. Try to break this.',
          userPrompt: 'Find a flaw',
          responseContent: 'Reject — there is a race condition in the early return path.',
          inputTokens: 60,
          outputTokens: 20,
          latencyMs: 700,
          roleGuess: 'adversarial',
        },
      ];
      writeTranscript(dir, 'task-001', events);
      const indexJson = {
        timestamp: '2026-05-05T19:00:00Z',
        tasksAttempted: 1,
        tasksCompleted: 0,
        tasksRejected: 1,
        totalCostUSD: '0.05',
        stoppedReason: 'task-cap',
        tasks: [{ id: 'task-001', transcriptFile: 'task-001.json' }],
      };
      writeFileSync(join(dir, 'index.json'), JSON.stringify(indexJson, null, 2));

      const outFile = join(dir, 'findings.md');
      const result = runAnalyzer({ transcriptsDir: dir, outFile });

      // Sycophancy flagged on the reviewer-code call (high Jaccard with the executor opening, no disagreement marker).
      expect(result.sycophancy.length).toBeGreaterThanOrEqual(1);
      // Drift flagged: reviewer-code says accept, adversarial says reject.
      expect(result.drift.length).toBeGreaterThanOrEqual(1);
      // Findings file written with all 5 sections.
      const md = readFileSync(outFile, 'utf8');
      expect(md).toContain('## 1. Sycophancy');
      expect(md).toContain('## 2. First-item bias');
      expect(md).toContain('## 3. Belief-action gap');
      expect(md).toContain('## 4. Drift');
      expect(md).toContain('## 5. Multi-hop decay');
      expect(md).toContain('Inconclusive'); // multi-hop is always inconclusive
      // The run summary table reflects the index.
      expect(md).toContain('| Tasks attempted | 1 |');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('produces a clean findings.md when no transcripts have signal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'analyzer-integration-empty-'));
    try {
      writeTranscript(dir, 'empty', [
        {
          kind: 'task-start',
          ts: '1',
          taskId: 'empty',
          systemId: 'A',
          taskType: 'x',
          model: 'sonnet',
        },
      ]);
      writeFileSync(
        join(dir, 'index.json'),
        JSON.stringify({
          timestamp: '2026-05-05T19:00:00Z',
          tasksAttempted: 1,
          tasksCompleted: 0,
          tasksRejected: 0,
          totalCostUSD: '0.00',
          stoppedReason: 'scan-empty',
          tasks: [{ id: 'empty', transcriptFile: 'empty.json' }],
        }),
      );
      const outFile = join(dir, 'findings.md');
      const result = runAnalyzer({ transcriptsDir: dir, outFile });
      expect(result.sycophancy.length).toBe(0);
      expect(result.drift.length).toBe(0);
      expect(result.beliefActionGap.length).toBe(0);
      expect(result.firstItemBias.totalEnumerations).toBe(0);
      const md = readFileSync(outFile, 'utf8');
      expect(md).toContain('_No instances detected._');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
