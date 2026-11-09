import { verifyPebbleRequest } from "./auth";
import { appendEntry, type Failure } from "./append";
import { DEFAULT_TIMEZONE, formatEntry, normalizeTranscript } from "./entry";

const DEDUP_TTL_S = 30 * 24 * 60 * 60;

export interface Env {
  WSPC_API_KEY: string;
  PEBBLE_SIGNING_SECRET: string;
  WSPC_LIBRARY_ID: string;
  DESTINATION_PATH: string;
  TIMEZONE?: string;
  DELIVERIES: KVNamespace;
}

/** Everything the Relay needs from the outside world, injectable for tests. */
export interface Deps {
  fetch: typeof fetch;
  /** Current time in Unix milliseconds. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Uniform random in [0, 1). */
  random: () => number;
  log: (level: "warn" | "error", data: Record<string, unknown>) => void;
}

export function createRelay(deps: Deps) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const startedAtMs = deps.now();
      if (request.method !== "POST") return text(405, "method not allowed");
      if (new URL(request.url).pathname !== "/") return text(404, "not found");

      const auth = await verifyPebbleRequest(request, env.PEBBLE_SIGNING_SECRET, startedAtMs);
      if (!auth.ok) return text(auth.status, auth.reason);
      if (auth.headers.isTest) return text(200, "test");

      const parsed = await parseBody(auth.rawBody, request.headers.get("content-type"));
      if (!parsed.ok) return text(400, parsed.reason);

      const normalized = normalizeTranscript(parsed.transcript);
      if (normalized === "") return text(200, "empty");

      const { delivery } = auth.headers;
      const kvKey = `delivery:${delivery}`;
      try {
        if ((await env.DELIVERIES.get(kvKey)) !== null) return text(200, "duplicate");
      } catch (err) {
        // Better a duplicate Entry than a lost one.
        deps.log("warn", { event: "dedup_check_failed", delivery, message: errorMessage(err) });
      }

      const writeFailed = (failure: Failure, attempts: number, entry: string | null) => {
        deps.log("error", {
          event: "write_failed",
          delivery,
          trigger: auth.headers.trigger,
          recordedAt: new Date(parsed.recordedAt).toISOString(),
          status: failure.status,
          code: failure.code,
          message: failure.message,
          attempts,
          elapsedMs: deps.now() - startedAtMs,
          transcript: parsed.transcript,
          entry,
        });
        return text(503, "write failed");
      };

      let entry: string;
      try {
        entry = formatEntry(parsed.recordedAt, normalized, env.TIMEZONE || DEFAULT_TIMEZONE);
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        return writeFailed({ status: null, code: "INVALID_TIMEZONE", message: err.message }, 0, null);
      }

      const result = await appendEntry(
        entry,
        { libraryId: env.WSPC_LIBRARY_ID, path: env.DESTINATION_PATH },
        env.WSPC_API_KEY,
        deps,
        startedAtMs,
      );
      if (!result.ok) return writeFailed(result, result.attempts, entry);
      if (result.repaired) deps.log("warn", { event: "marker_repaired", reason: result.repaired, delivery });

      try {
        await env.DELIVERIES.put(
          kvKey,
          JSON.stringify({ recordedAt: parsed.recordedAt, writtenAt: new Date(deps.now()).toISOString() }),
          { expirationTtl: DEDUP_TTL_S },
        );
      } catch (err) {
        deps.log("warn", { event: "dedup_store_failed", delivery, message: errorMessage(err) });
      }

      return text(200, "ok");
    },
  };
}

type ParseResult = { ok: true; recordedAt: number; transcript: string } | { ok: false; reason: string };

async function parseBody(rawBody: ArrayBuffer, contentType: string | null): Promise<ParseResult> {
  let form: FormData;
  try {
    form = await new Response(rawBody, { headers: contentType ? { "content-type": contentType } : {} }).formData();
  } catch {
    return { ok: false, reason: "invalid multipart body" };
  }
  const recordedAt = form.get("recordedAt");
  // Must also fit in a Date (±8.64e15 ms), or formatting the Entry would throw.
  if (
    typeof recordedAt !== "string" ||
    !/^-?\d+$/.test(recordedAt) ||
    Number.isNaN(new Date(Number(recordedAt)).getTime())
  ) {
    return { ok: false, reason: "invalid recordedAt" };
  }
  const transcript = form.get("transcription");
  if (typeof transcript !== "string") return { ok: false, reason: "missing transcription" };
  return { ok: true, recordedAt: Number(recordedAt), transcript };
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function text(status: number, body: string) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
