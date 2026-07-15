export interface Resolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/**
 * `Promise.withResolvers()` shim: the workspace pins Node >= 18 and the native
 * API lands in Node 22, so this helper is the single sanctioned use of the
 * executor form. Everything else in the package uses this.
 */
export function withResolvers<T>(): Resolvers<T> {
  if (typeof (Promise as { withResolvers?: () => Resolvers<T> }).withResolvers === "function") {
    return (Promise as unknown as { withResolvers: () => Resolvers<T> }).withResolvers();
  }
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function delay(ms: number): Promise<void> {
  const { promise, resolve } = withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
