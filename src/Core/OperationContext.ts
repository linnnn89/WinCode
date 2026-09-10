import { AbortError, TimeoutError, type QueueObserver } from './ResourceManager.js';

/** Internal request lifetime; never part of the public JSON tool arguments. */
export interface OperationContext { signal?: AbortSignal; deadline?: number; queue?: QueueObserver }

export function checkOperation(operation?: OperationContext): void {
  if (operation?.signal?.aborted) {
    if (operation.signal.reason instanceof TimeoutError) throw operation.signal.reason;
    throw new AbortError('Tool call cancelled.');
  }
  if (operation?.deadline !== undefined && Date.now() >= operation.deadline) {
    const error = new TimeoutError('operation', 0);
    error.message = 'Operation timed out: deadline exceeded.';
    throw error;
  }
}

export function rethrowOperationError(error: unknown, operation?: OperationContext): void {
  checkOperation(operation);
  if (error instanceof AbortError || (error instanceof Error && error.name === 'AbortError')) throw error;
}
