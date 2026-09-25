/**
 * A log- and client-safe description of an error: its name and its code (a
 * database SQLSTATE, or a Node or driver code such as ECONNREFUSED). Never the
 * message: drizzle's query errors carry the SQL and its parameters (preview
 * ids, whole previews, salts), and connection errors can carry the connection
 * string.
 */
export function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = errorCode(error);
  return code === undefined ? name : `${name} ${code}`;
}

/** SQLSTATEs (5 characters) and Node or postgres.js codes (ECONNREFUSED, CONNECT_TIMEOUT); neither carries secrets. */
const SAFE_CODE = /^(?:[0-9A-Z]{5}|[A-Z][A-Z0-9_]{2,31})$/;

/** The first safe code on the error or its causes. */
export function errorCode(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e !== undefined && e !== null && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && SAFE_CODE.test(code)) return code;
  }
  return undefined;
}

/** Whether a connection error means the connection string itself could not be parsed. */
export function isUnparseableUrl(error: unknown): boolean {
  return errorCode(error) === "ERR_INVALID_URL" || error instanceof URIError;
}

/**
 * A store failure with nothing but its description and code: the original
 * error (and its SQL, parameters or connection string) is dropped, so it can
 * reach logs, the payment work or a client without leaking anything.
 */
export class StoreError extends Error {
  override name = "StoreError";
  readonly code: string | undefined;

  constructor(original: unknown) {
    super(`store operation failed (${describeError(original)})`);
    this.code = errorCode(original);
  }
}

/**
 * Wraps every method of a store so that a failure rejects with a StoreError.
 * The server wraps the Postgres store once, so no caller (routes, the
 * ResolutionService and the payment work that calls it, housekeeping) ever
 * sees a driver error.
 */
export function safeStore<T extends object>(store: T): T {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          const result: unknown = (value as (...a: unknown[]) => unknown).apply(target, args);
          return result instanceof Promise
            ? result.catch((error: unknown) => {
                throw error instanceof StoreError ? error : new StoreError(error);
              })
            : result;
        } catch (error) {
          throw error instanceof StoreError ? error : new StoreError(error);
        }
      };
    },
  });
}
