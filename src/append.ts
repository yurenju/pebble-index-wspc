import type { Deps } from "./relay";

export const WSPC_BASE_URL = "https://api.wspc.ai";
export const END_MARKER = "<!-- pebble-relay:end -->";

/** Edits and PUTs across all paths share this many writes (repair GETs don't count). */
export const MAX_WRITES = 20;
/** Measured from when the Relay received the request; Pebble times out at 2 minutes. */
export const BUDGET_MS = 90_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** The WSPC Drive file Entries are appended to. */
export interface Destination {
  libraryId: string;
  path: string;
}

export type RepairReason = "EDIT_NO_MATCH" | "EDIT_NOT_UNIQUE";

export interface Failure {
  /** HTTP status of the last WSPC response; null for network errors and timeouts. */
  status: number | null;
  code: string | null;
  message: string | null;
}

export type AppendResult =
  | { ok: true; attempts: number; repaired: RepairReason | null }
  | ({ ok: false; attempts: number } & Failure);

type Step = { kind: "edit" } | { kind: "create" } | { kind: "repair"; reason: RepairReason };

interface Outcome extends Failure {
  response: Response | null;
}

type AppendDeps = Pick<Deps, "fetch" | "now" | "sleep" | "random">;

/**
 * Appends one Entry line just above the end marker of the Destination.
 *
 * Normally a single edit; creates the file when it doesn't exist, rebuilds it
 * when the marker is missing or duplicated, and retries transient failures
 * within MAX_WRITES writes and BUDGET_MS of `startedAtMs`.
 */
export async function appendEntry(
  entry: string,
  dest: Destination,
  apiKey: string,
  deps: AppendDeps,
  startedAtMs: number,
): Promise<AppendResult> {
  const filesUrl = `${WSPC_BASE_URL}/drive/libraries/${encodeURIComponent(dest.libraryId)}/files`;
  const elapsed = () => deps.now() - startedAtMs;
  let attempts = 0;
  let backoffs = 0;
  let step: Step = { kind: "edit" };
  let last: Outcome = { status: null, code: null, message: null, response: null };

  const giveUp = (failure: Failure): AppendResult => ({
    ok: false,
    attempts,
    status: failure.status,
    code: failure.code,
    message: failure.message,
  });
  const budgetExceeded = () => giveUp({ ...last, code: "BUDGET_EXCEEDED" });

  /** Sends one WSPC request; null when no time budget is left (nothing was sent). */
  const call = async (url: string, init: RequestInit, isWrite: boolean): Promise<Outcome | null> => {
    const remaining = BUDGET_MS - elapsed();
    if (remaining <= 0) return null;
    if (isWrite) attempts++;
    try {
      const res = await deps.fetch(url, {
        ...init,
        headers: { authorization: `Bearer ${apiKey}`, ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
      });
      if (res.ok) return { status: res.status, code: null, message: null, response: res };
      return { status: res.status, ...(await readError(res)), response: res };
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return {
        status: null,
        code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
        response: null,
      };
    }
  };

  /** Waits before the next try; false when that would overrun the time budget. */
  const wait = async (ms: number) => {
    if (elapsed() + ms > BUDGET_MS) return false;
    if (ms > 0) await deps.sleep(ms);
    return true;
  };
  const conflictDelay = () => 100 + deps.random() * 400;
  const backoffDelay = () => Math.min(8000, 500 * 2 ** backoffs++) + deps.random() * 250;

  /** For failures that aren't part of the edit/create/repair flow: retry the same step, or give up. */
  const transientDelay = (out: Outcome): number | null => {
    if (out.status === null || [500, 502, 503, 504].includes(out.status)) return backoffDelay();
    if (out.status === 429) return retryAfterMs(out.response, deps.now()) ?? backoffDelay();
    return null;
  };

  for (;;) {
    let out: Outcome | null;
    let next: Step | null = null;
    let delay: number | null = null;

    if (step.kind === "edit") {
      out = await call(
        `${filesUrl}/edit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: dest.path, old_string: END_MARKER, new_string: `${entry}\n${END_MARKER}` }),
        },
        true,
      );
      if (!out) return budgetExceeded();
      if (out.status === 200) return { ok: true, attempts, repaired: null };
      if (out.status === 409 && out.code === "VERSION_CONFLICT") [next, delay] = [step, conflictDelay()];
      else if (out.status === 404 && out.code === "FILE_NOT_FOUND") [next, delay] = [{ kind: "create" }, 0];
      else if (out.status === 409 && (out.code === "EDIT_NO_MATCH" || out.code === "EDIT_NOT_UNIQUE")) {
        [next, delay] = [{ kind: "repair", reason: out.code }, 0];
      }
    } else {
      let expectedVersion = 0;
      let body = `${entry}\n${END_MARKER}\n`;
      if (step.kind === "repair") {
        // The GET does not count as a write.
        const read = await call(`${filesUrl}/content?${new URLSearchParams({ path: dest.path })}`, { method: "GET" }, false);
        if (!read) return budgetExceeded();
        last = read;
        if (read.status === 404 && read.code === "FILE_NOT_FOUND") {
          step = { kind: "create" };
          continue;
        }
        if (read.status !== 200) {
          const readDelay = transientDelay(read);
          if (readDelay === null) return giveUp(read);
          if (!(await wait(readDelay))) return budgetExceeded();
          continue;
        }
        const version = read.response!.headers.get("x-drive-entry-version");
        if (version === null || !/^\d+$/.test(version)) {
          return giveUp({ status: read.status, code: "INVALID_RESPONSE", message: "missing x-drive-entry-version" });
        }
        expectedVersion = Number(version);
        body = rebuildWithEntry(await read.response!.text(), entry);
      }

      out = await putContent(filesUrl, dest.path, expectedVersion, body, call);
      if (!out) return budgetExceeded();
      if (out.status === 200) return { ok: true, attempts, repaired: step.kind === "repair" ? step.reason : null };
      if (out.status === 409) [next, delay] = [{ kind: "edit" }, conflictDelay()];
    }

    last = out;
    if (next === null) {
      delay = transientDelay(out);
      if (delay === null) return giveUp(out);
      next = step;
    }
    if (attempts >= MAX_WRITES) return giveUp(out);
    if (!(await wait(delay!))) return budgetExceeded();
    step = next;
  }
}

/**
 * Removes every end marker (whole marker-only lines, and the marker string
 * anywhere else), then appends the Entry and a fresh marker as the last line.
 */
export function rebuildWithEntry(content: string, entry: string): string {
  let rest = content
    .split("\n")
    .filter((line) => line.trim() !== END_MARKER)
    .map((line) => line.split(END_MARKER).join(""))
    .join("\n");
  if (rest !== "" && !rest.endsWith("\n")) rest += "\n";
  return `${rest}${entry}\n${END_MARKER}\n`;
}

async function putContent(
  filesUrl: string,
  path: string,
  expectedVersion: number,
  body: string,
  call: (url: string, init: RequestInit, isWrite: boolean) => Promise<Outcome | null>,
) {
  const bytes = new TextEncoder().encode(body);
  const query = new URLSearchParams({ path, expected_entry_version: String(expectedVersion) });
  return call(
    `${filesUrl}/content?${query}`,
    {
      method: "PUT",
      headers: { "content-type": "text/markdown", "x-drive-content-sha256": await sha256Hex(bytes) },
      body: bytes,
    },
    true,
  );
}

/** Retry-After as seconds or an HTTP date, in ms from now; null when absent or unparseable. */
function retryAfterMs(res: Response | null, nowMs: number): number | null {
  const value = res?.headers.get("retry-after")?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

async function readError(res: Response): Promise<{ code: string | null; message: string | null }> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    return {
      code: typeof body.error?.code === "string" ? body.error.code : null,
      message: typeof body.error?.message === "string" ? body.error.message : null,
    };
  } catch {
    return { code: null, message: null };
  }
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
