/**
 * BudgetManager instrumentation — emits `task-start` events so the
 * EventSink can attribute subsequent LLM/Codex calls to the right
 * taskId. The runner's `budgetManager.allocate(taskId, …)` is the
 * cleanest task-boundary signal in the loop (called exactly once per
 * task, before any work starts).
 *
 * BudgetManager has private fields, so we can't subclass safely.
 * Proxy-wrap and override only `allocate`; everything else falls
 * through to the real instance.
 */
import type { BudgetManager } from 'asil-cost-controller';
import type { EventSink } from './transcript-writer.js';

export function wrapBudgetManager(real: BudgetManager, sink: EventSink): BudgetManager {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'allocate') {
        return function allocate(
          taskId: string,
          systemId: string,
          taskType: string,
          model: string,
          options?: unknown,
        ) {
          const ts = new Date().toISOString();
          sink.setCurrentTask(taskId);
          sink.append({
            kind: 'task-start',
            ts,
            taskId,
            systemId,
            taskType,
            model,
          });
          const result = (target.allocate as (...args: unknown[]) => unknown).call(
            target,
            taskId,
            systemId,
            taskType,
            model,
            options,
          );
          sink.append({
            kind: result === null ? 'budget-allocate-rejected' : 'budget-allocate',
            ts: new Date().toISOString(),
            taskId,
            systemId,
            taskType,
            model,
          });
          return result;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
