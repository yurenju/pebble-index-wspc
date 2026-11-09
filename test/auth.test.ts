import { describe, expect, it } from "vitest";
import { NOW_MS, SECRET, pebbleRequest, setup } from "./harness";

describe("signature verification", () => {
  it("accepts a correctly signed request", async () => {
    const { send } = setup();
    const res = await send(pebbleRequest());
    expect(res).toEqual({ status: 200, text: "ok" });
  });

  it("matches the Pebble Flask reference (key = UTF-8 bytes of the secret, not hex-decoded)", async () => {
    // Expected value computed independently with Python's hmac, as in INDEX_WEBHOOK_API.md:
    //   hmac.new(secret.encode("utf-8"), prefix.encode() + raw_body, hashlib.sha256).hexdigest()
    const { send } = setup();
    const res = await send(
      pebbleRequest({
        fields: { recordedAt: "1794202320000", transcription: "hello" },
        delivery: "dlv_123",
        trigger: "hold_and_talk",
        timestamp: "1794202400",
        signature: "71ef1ba20dc125fb8f68619cb031e7cdc11437e5d7a6c27e7932b1642c297a3f",
      }),
    );
    expect(res).toEqual({ status: 200, text: "ok" });
  });

  it.each([
    ["wrong secret", { secret: SECRET.replace("0", "f") }],
    ["tampered body", { tamperBody: "--B--\r\n" }],
    ["missing signature", { signature: null }],
    ["non-hex signature", { signature: "z".repeat(64) }],
    ["short signature", { signature: "ab".repeat(16) }],
    ["uppercase hex signature", { signature: "A".repeat(64) }],
    ["timestamp 301s in the past", { timestamp: String(NOW_MS / 1000 - 301) }],
    ["timestamp 301s in the future", { timestamp: String(NOW_MS / 1000 + 301) }],
  ])("rejects %s with 401", async (_name, opts) => {
    const { send, drive, kv } = setup();
    const res = await send(pebbleRequest(opts));
    expect(res.status).toBe(401);
    expect(drive.calls).toHaveLength(0);
    expect(kv.touched).toBe(0);
  });

  it("accepts a timestamp exactly 300s off", async () => {
    const { send } = setup();
    const res = await send(pebbleRequest({ timestamp: String(NOW_MS / 1000 - 300) }));
    expect(res.status).toBe(200);
  });

  it.each([
    ["webhook version 2", { version: "2" }],
    ["missing timestamp", { timestamp: "" }],
    ["non-integer timestamp", { timestamp: "1762666400.5" }],
    ["blank delivery", { delivery: "" }],
  ])("rejects %s with 400", async (_name, opts) => {
    const { send, drive, kv } = setup();
    const res = await send(pebbleRequest(opts));
    expect(res.status).toBe(400);
    expect(drive.calls).toHaveLength(0);
    expect(kv.touched).toBe(0);
  });
});
