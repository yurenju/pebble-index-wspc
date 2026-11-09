import { createRelay, type Deps, type Env } from "../src/relay";

export const SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
export const LIB = "lib_TEST";
export const PATH = "00-inbox/pebble-index-records.md";
export const MARKER = "<!-- pebble-relay:end -->";
export const API_KEY = "wspc_test_key";

/** 2026-11-09 05:33:20 UTC */
export const NOW_MS = 1_794_202_400_000;

export class FakeClock {
  ms = NOW_MS;
  sleeps: number[] = [];
  now = () => this.ms;
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.ms += ms;
  };
}

export class FakeKV {
  store = new Map<string, string>();
  puts: { key: string; value: string; options?: KVNamespacePutOptions }[] = [];
  gets: string[] = [];
  failGet = false;
  failPut = false;

  async get(key: string): Promise<string | null> {
    this.gets.push(key);
    if (this.failGet) throw new Error("kv get down");
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
    this.puts.push({ key, value, options });
    if (this.failPut) throw new Error("kv put down");
    this.store.set(key, value);
  }

  get touched() {
    return this.gets.length + this.puts.length;
  }
}

export type Injected =
  | { status: number; code?: string; message?: string; headers?: Record<string, string> }
  | { throw: Error };

export interface DriveCall {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  signal: AbortSignal | undefined;
}

/**
 * In-memory stand-in for one WSPC Drive file, following the semantics observed
 * against the real API: edit needs a unique old_string, PUT is guarded by
 * expected_entry_version (0 = must not exist).
 */
export class FakeDrive {
  content: string | null = null;
  version = 0;
  calls: DriveCall[] = [];
  /** Responses returned (in order) before the fake handles a request itself. */
  inject: Injected[] = [];
  /** Called after each request is recorded, before handling; lets a test mutate state mid-flight. */
  onCall?: (call: DriveCall) => void;
  advance?: (ms: number) => void;
  latencyMs = 0;
  omitVersionHeader = false;

  constructor(content: string | null = null) {
    if (content !== null) {
      this.content = content;
      this.version = 1;
    }
  }

  get writes() {
    return this.calls.filter((c) => c.method !== "GET");
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const call: DriveCall = {
      method: req.method,
      url: new URL(req.url),
      headers: req.headers,
      body: await req.text(),
      signal: init?.signal ?? undefined,
    };
    this.calls.push(call);
    if (this.latencyMs) this.advance?.(this.latencyMs);
    this.onCall?.(call);

    const injected = this.inject.shift();
    if (injected) {
      if ("throw" in injected) throw injected.throw;
      return errorResponse(injected.status, injected.code ?? "INJECTED", injected.message ?? "injected", injected.headers);
    }

    if (req.headers.get("authorization") !== `Bearer ${API_KEY}`) {
      return errorResponse(401, "UNAUTHORIZED", "bad key");
    }
    const base = `/drive/libraries/${LIB}/files`;
    if (call.url.pathname === `${base}/edit` && req.method === "POST") return this.edit(call);
    if (call.url.pathname === `${base}/content` && req.method === "PUT") return this.put(call);
    if (call.url.pathname === `${base}/content` && req.method === "GET") return this.get(call);
    return errorResponse(404, "NOT_FOUND", `no route ${req.method} ${call.url.pathname}`);
  };

  private edit(call: DriveCall) {
    const { path, old_string, new_string } = JSON.parse(call.body);
    if (path !== PATH) return errorResponse(404, "FILE_NOT_FOUND", "wrong path");
    if (this.content === null) return errorResponse(404, "FILE_NOT_FOUND", "missing");
    const count = this.content.split(old_string).length - 1;
    if (count === 0) return errorResponse(409, "EDIT_NO_MATCH", "no match");
    if (count > 1) return errorResponse(409, "EDIT_NOT_UNIQUE", "not unique");
    this.content = this.content.replace(old_string, () => new_string);
    this.version++;
    return Response.json({ path, entry_version: this.version });
  }

  private async put(call: DriveCall) {
    if (call.url.searchParams.get("path") !== PATH) return errorResponse(400, "VALIDATION_ERROR", "wrong path");
    const sha = await sha256Hex(call.body);
    if (call.headers.get("x-drive-content-sha256") !== sha) return errorResponse(400, "HASH_MISMATCH", "hash");
    const expected = Number(call.url.searchParams.get("expected_entry_version"));
    const current = this.content === null ? 0 : this.version;
    if (expected !== current) return errorResponse(409, "VERSION_CONFLICT", "version");
    this.content = call.body;
    this.version++;
    return Response.json({ path: PATH, entry_version: this.version });
  }

  private get(call: DriveCall) {
    if (call.url.searchParams.get("path") !== PATH || this.content === null) {
      return errorResponse(404, "FILE_NOT_FOUND", "missing");
    }
    const headers: Record<string, string> = { "content-type": "text/markdown" };
    if (!this.omitVersionHeader) headers["x-drive-entry-version"] = String(this.version);
    return new Response(this.content, { headers });
  }
}

function errorResponse(status: number, code: string, message: string, headers: Record<string, string> = {}) {
  return Response.json({ error: { code, message } }, { status, headers });
}

export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function multipart(fields: Record<string, string>, boundary = "B") {
  let body = "";
  for (const [name, value] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  return { body: body + `--${boundary}--\r\n`, contentType: `multipart/form-data; boundary=${boundary}` };
}

export interface RequestOptions {
  fields?: Record<string, string>;
  delivery?: string;
  trigger?: string;
  test?: boolean;
  timestamp?: string;
  version?: string;
  secret?: string;
  /** Override the computed signature; null omits the header. */
  signature?: string | null;
  /** Replace the body after signing. */
  tamperBody?: string;
  method?: string;
  url?: string;
}

export async function sign(secret: string, prefix: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(prefix + body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function pebbleRequest(opts: RequestOptions = {}) {
  const fields = opts.fields ?? { recordedAt: "1794202320000", transcription: "明天記得把報價單寄給客戶。" };
  const { body, contentType } = multipart(fields);
  const delivery = opts.delivery ?? "dlv_1";
  const trigger = opts.trigger ?? "hold_and_talk";
  const timestamp = opts.timestamp ?? String(Math.floor(NOW_MS / 1000));
  const isTest = opts.test ?? false;
  const prefix = `v1\n${timestamp}\n${delivery}\n${trigger}\n${isTest ? "1" : "0"}\n`;
  const signature =
    opts.signature === undefined ? await sign(opts.secret ?? SECRET, prefix, body) : opts.signature;

  const headers: Record<string, string> = {
    "content-type": contentType,
    "x-index-webhook-version": opts.version ?? "1",
    "x-index-timestamp": timestamp,
    "x-index-delivery": delivery,
    "x-index-trigger": trigger,
  };
  if (isTest) headers["x-index-test"] = "true";
  if (signature !== null) headers["x-index-signature"] = signature;

  const method = opts.method ?? "POST";
  return new Request(opts.url ?? "https://pebble-relay.example.workers.dev/", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : (opts.tamperBody ?? body),
  });
}

export interface Logged {
  level: "warn" | "error";
  data: Record<string, unknown>;
}

export function setup(opts: { drive?: FakeDrive; env?: Partial<Env> } = {}) {
  const clock = new FakeClock();
  const kv = new FakeKV();
  const drive = opts.drive ?? new FakeDrive(`${MARKER}\n`);
  drive.advance = (ms) => (clock.ms += ms);
  const logs: Logged[] = [];
  const deps: Deps = {
    fetch: drive.fetch,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    log: (level, data) => logs.push({ level, data }),
  };
  const env: Env = {
    WSPC_API_KEY: API_KEY,
    PEBBLE_SIGNING_SECRET: SECRET,
    WSPC_LIBRARY_ID: LIB,
    DESTINATION_PATH: PATH,
    TIMEZONE: "Asia/Tokyo",
    DELIVERIES: kv as unknown as KVNamespace,
    ...opts.env,
  };
  const relay = createRelay(deps);
  const send = async (req: Request | Promise<Request>) => {
    const res = await relay.fetch(await req, env);
    return { status: res.status, text: await res.text() };
  };
  return { clock, kv, drive, logs, env, send };
}
