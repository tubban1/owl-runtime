import { AsyncLocalStorage } from "node:async_hooks";

const cancellationStorage = new AsyncLocalStorage<AbortSignal>();

export class OperationCancelledError extends Error {
  readonly code = "OPERATION_CANCELLED";

  constructor(reason?: unknown) {
    const detail =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : "The Runtime operation was cancelled.";
    super(`OPERATION_CANCELLED: ${detail}`);
    this.name = "OperationCancelledError";
  }
}

export function currentCancellationSignal(): AbortSignal | undefined {
  return cancellationStorage.getStore();
}

export async function withCancellationSignal<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) {
    throw new OperationCancelledError(signal.reason);
  }
  return await cancellationStorage.run(signal, operation);
}

export function throwIfCancelled(
  signal: AbortSignal | undefined = currentCancellationSignal(),
): void {
  if (signal?.aborted) {
    throw new OperationCancelledError(signal.reason);
  }
}

export async function cancellableSleep(
  ms: number,
  signal: AbortSignal | undefined = currentCancellationSignal(),
): Promise<void> {
  throwIfCancelled(signal);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));

    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new OperationCancelledError(signal?.reason));
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
