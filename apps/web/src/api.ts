import { useEffect, useState } from "react";

/** Any core read-model schema: the dashboard parses every response before it renders anything from it. */
export interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export type Loaded<T> = { readonly state: "loading" } | { readonly state: "ready"; readonly data: T } | { readonly state: "error"; readonly message: string };

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
  if (response.status === 404) return { state: "error", message: "Not found." };
  if (response.status === 429) return { state: "error", message: "Too many requests; try again shortly." };
  if (!response.ok) return { state: "error", message: `The server answered ${response.status}.` };
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
