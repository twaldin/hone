/**
 * `Promise.withResolvers()` ponyfill. Node 18 (the workspace engine floor)
 * has no native implementation, so this is the one place the Promise
 * executor form is permitted — the constructor API requires it to obtain the
 * resolver functions.
 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
