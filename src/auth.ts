export const MAX_CLOCK_SKEW_S = 300;

export interface PebbleHeaders {
  timestamp: string;
  delivery: string;
  trigger: string;
  isTest: boolean;
}

export type AuthResult =
  | { ok: true; headers: PebbleHeaders; rawBody: ArrayBuffer }
  | { ok: false; status: 400 | 401; reason: string };

/**
 * Verifies a Pebble Index webhook request (protocol version 1) and returns its
 * raw body, which can only be read once.
 */
export async function verifyPebbleRequest(request: Request, secret: string, nowMs: number): Promise<AuthResult> {
  const h = request.headers;
  if (h.get("x-index-webhook-version") !== "1") return fail(400, "unsupported webhook version");

  const timestamp = h.get("x-index-timestamp") ?? "";
  if (!/^-?\d+$/.test(timestamp)) return fail(400, "invalid timestamp");
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_S) return fail(401, "expired request");

  const delivery = h.get("x-index-delivery") ?? "";
  const trigger = h.get("x-index-trigger") ?? "";
  const isTest = h.get("x-index-test") === "true";

  const signature = hexToBytes(h.get("x-index-signature") ?? "");
  if (!signature) return fail(401, "invalid signature");

  const rawBody = await request.arrayBuffer();
  const prefix = new TextEncoder().encode(`v1\n${timestamp}\n${delivery}\n${trigger}\n${isTest ? "1" : "0"}\n`);
  const signed = new Uint8Array(prefix.byteLength + rawBody.byteLength);
  signed.set(prefix, 0);
  signed.set(new Uint8Array(rawBody), prefix.byteLength);

  // The key is the secret string's UTF-8 bytes exactly as entered in the Pebble app (not hex-decoded).
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (!(await crypto.subtle.verify("HMAC", key, signature, signed))) return fail(401, "invalid signature");

  if (delivery === "") return fail(400, "missing delivery");
  return { ok: true, headers: { timestamp, delivery, trigger, isTest }, rawBody };
}

function fail(status: 400 | 401, reason: string): AuthResult {
  return { ok: false, status, reason };
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
