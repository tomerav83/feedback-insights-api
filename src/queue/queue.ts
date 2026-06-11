import type { Logger } from '../lib/logger';

export interface AnalysisQueue {
  /** Add a feedback id to the work set and kick the pump. */
  enqueue(feedbackId: string): void;
  /** Begin draining the pending set (idempotent). */
  start(): void;
  /**
   * Stop accepting new work and await in-flight tasks to settle. Pending (not-yet-started)
   * items are intentionally dropped: the in-process queue is not durable, and boot recovery
   * re-enqueues anything left mid-flight (rows stuck in ANALYZING). Resolves once drained.
   */
  stop(): Promise<void>;
  /** Number of items waiting to start (observability / test synchronization). */
  readonly size: number;
  /** Number of items currently being processed. */
  readonly active: number;
}

export interface CreateQueueDeps {
  /** Max items processed concurrently. */
  concurrency: number;
  /** Per-item worker. Must resolve on terminal state and should not throw (it is guarded). */
  process: (feedbackId: string) => Promise<void>;
  logger?: Logger;
}

/**
 * Minimal in-process work queue with bounded concurrency — ~40 lines we fully own, which is
 * the point: the retry/backoff and state transitions this feeds are bespoke, and a broker
 * (BullMQ/Redis) would be overbuild for a single-process 3h exercise.
 *
 * Scheduling is a self-rescheduling pump: each completed task frees a slot and re-pumps, so
 * up to `concurrency` tasks run at once and the next pending item starts the instant a slot
 * opens — no polling, no timers. The queue is deliberately generic over `process`; it knows
 * nothing about feedback or the DB, which keeps the state machine entirely in the worker.
 */
export function createQueue(deps: CreateQueueDeps): AnalysisQueue {
  const { concurrency, process: processItem, logger } = deps;
  const pending: string[] = [];
  const inFlight = new Set<Promise<void>>();
  let running = false;

  function pump(): void {
    if (!running) return;
    while (inFlight.size < concurrency && pending.length > 0) {
      const id = pending.shift() as string;
      const task = processItem(id)
        .catch((err: unknown) => {
          // The worker is supposed to swallow its own failures into FAILED rows; this is a
          // last-resort guard so one unexpected throw can't wedge the whole queue.
          logger?.error({ err, feedbackId: id }, 'queue: task threw unexpectedly');
        })
        .finally(() => {
          inFlight.delete(task);
          pump();
        });
      inFlight.add(task);
    }
  }

  return {
    get size(): number {
      return pending.length;
    },
    get active(): number {
      return inFlight.size;
    },
    enqueue(feedbackId: string): void {
      pending.push(feedbackId);
      pump();
    },
    start(): void {
      running = true;
      pump();
    },
    async stop(): Promise<void> {
      running = false;
      await Promise.allSettled([...inFlight]);
    },
  };
}
