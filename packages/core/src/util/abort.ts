import { MiniBookError } from '../errors.js';

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new MiniBookError('cancelled', 'Operation cancelled');
  }
}

export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new MiniBookError('cancelled', 'Operation cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new MiniBookError('cancelled', 'Operation cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
