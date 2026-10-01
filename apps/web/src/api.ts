import { useEffect, useState } from "react";

/** Any core read-model schema: the dashboard parses every response before it renders anything from it. */
export interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** A read model as a view sees it. An error keeps the HTTP status it came with, if any, so a poll can back off on 429. */
export type Loaded<T> =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly data: T }
  | { readonly state: "error"; readonly message: string; readonly status?: number | undefined };

/**
 * Fetches a read model from this origin's API and validates it. Anything that
 * does not match the schema is an error, never rendered: API text is untrusted.
 */
export async function fetchView<T>(path: string, schema: Parser<T>, fetchImpl: typeof fetch = fetch): Promise<Loaded<T>> {
  let response: Response;
  try {
    response = await fetchImpl(path, { headers: { accept: "application/json" }, credentials: "omit" });
  } catch {
    return { state: "error", message: "The Lemma server could not be reached." };
  }
  if (response.status === 404) return { state: "error", message: "Not found.", status: 404 };
  if (response.status === 429) return { state: "error", message: "Too many requests; try again shortly.", status: 429 };
  if (!response.ok) return { state: "error", message: `The server answered ${response.status}.`, status: response.status };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { state: "error", message: "The server's answer was not JSON." };
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? { state: "ready", data: parsed.data } : { state: "error", message: "The server's answer did not match the expected shape." };
}

/**
 * Loads a read model when `path` changes. What was loaded is kept with the
 * path it came from, so switching views never hands one view's data to
 * another's renderer while the new request is in flight.
 */
export function useView<T>(path: string, schema: Parser<T>): Loaded<T> {
  const [loaded, setLoaded] = useState<{ path: string; schema: Parser<T>; result: Loaded<T> } | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void fetchView(path, schema).then((result) => {
      if (live) setLoaded({ path, schema, result });
    });
    return () => {
      live = false;
    };
  }, [path, schema]);
  return loaded !== undefined && loaded.path === path && loaded.schema === schema ? loaded.result : { state: "loading" };
}

/** How often the home page's live figures refresh while the page is visible. */
export const POLL_MS = 60_000;
/** The longest a poll waits after repeated 429 answers. */
export const MAX_POLL_MS = 600_000;

/** What a poll needs from its environment, so tests can drive it with fake timers. */
export interface PollClock {
  /** Runs `run` after `ms` milliseconds and returns a function that cancels it. */
  readonly after: (run: () => void, ms: number) => () => void;
  /** Whether the page is hidden (a background tab): a hidden page is not fetched for. */
  readonly hidden: () => boolean;
}

export interface Poll {
  readonly stop: () => void;
  /** The page became visible: fetch at once if a poll came due while it was hidden. */
  readonly wake: () => void;
}

/**
 * Loads now, then again `intervalMs` after each answer, until stopped. A 429
 * doubles the wait, up to `MAX_POLL_MS`; any other answer resets it. While
 * the page is hidden nothing is fetched: the poll that comes due waits for
 * `wake`. Figures change only when an answer arrives, never in between.
 */
export function startPoll<T>(load: () => Promise<Loaded<T>>, onResult: (result: Loaded<T>) => void, clock: PollClock, intervalMs: number = POLL_MS): Poll {
  let stopped = false;
  let cancel: (() => void) | null = null;
  let due = false;
  let inFlight = false;
  let wait = intervalMs;
  const run = (): void => {
    cancel = null;
    if (stopped) return;
    if (clock.hidden()) {
      due = true;
      return;
    }
    due = false;
    inFlight = true;
    void load()
      .catch((): Loaded<T> => ({ state: "error", message: "The Lemma server could not be reached." }))
      .then((result) => {
        inFlight = false;
        if (stopped) return;
        wait = result.state === "error" && result.status === 429 ? Math.min(wait * 2, MAX_POLL_MS) : intervalMs;
        onResult(result);
        cancel = clock.after(run, wait);
      });
  };
  run();
  return {
    stop: () => {
      stopped = true;
      cancel?.();
      cancel = null;
    },
    wake: () => {
      if (!stopped && due && !inFlight && cancel === null) run();
    },
  };
}

/** A read model kept fresh by polling: what the page shows, and why the latest poll failed when it shows older data. */
export interface Polled<T> {
  readonly loaded: Loaded<T>;
  /** Set when a poll failed after data had loaded: `loaded` keeps that earlier data rather than blanking the page. */
  readonly failure: string | null;
}

export const POLL_START: Polled<never> = { loaded: { state: "loading" }, failure: null };

/** The next state after a poll's answer: new data replaces old, and a failure keeps data that already loaded. */
export function nextPolled<T>(previous: Polled<T>, result: Loaded<T>): Polled<T> {
  if (result.state === "error" && previous.loaded.state === "ready") return { loaded: previous.loaded, failure: result.message };
  return { loaded: result, failure: null };
}

/** `useView` that refreshes every `intervalMs` while the page is visible (`startPoll`). */
export function usePolledView<T>(path: string, schema: Parser<T>, intervalMs: number = POLL_MS): Polled<T> {
  const [state, setState] = useState<{ path: string; schema: Parser<T>; polled: Polled<T> } | undefined>(undefined);
  useEffect(() => {
    const clock: PollClock = {
      after: (run, ms) => {
        const timer = window.setTimeout(run, ms);
        return () => window.clearTimeout(timer);
      },
      hidden: () => document.visibilityState === "hidden",
    };
    const poll = startPoll(
      () => fetchView(path, schema),
      (result) =>
        setState((previous) => ({
          path,
          schema,
          polled: nextPolled(previous !== undefined && previous.path === path && previous.schema === schema ? previous.polled : POLL_START, result),
        })),
      clock,
      intervalMs,
    );
    const onVisibility = () => {
      if (document.visibilityState === "visible") poll.wake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      poll.stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [path, schema, intervalMs]);
  return state !== undefined && state.path === path && state.schema === schema ? state.polled : POLL_START;
}
