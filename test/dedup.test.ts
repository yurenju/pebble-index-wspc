import { describe, expect, it } from "vitest";
import { MARKER, NOW_MS, pebbleRequest, setup } from "./harness";

describe("duplicate deliveries", () => {
  it("records the delivery in KV for 30 days after a successful write", async () => {
    const { send, kv } = setup();
    const res = await send(pebbleRequest({ delivery: "dlv_abc", fields: { recordedAt: "1794202320000", transcription: "x" } }));
    expect(res).toEqual({ status: 200, text: "ok" });
    expect(kv.puts).toEqual([
      {
        key: "delivery:dlv_abc",
        value: JSON.stringify({ recordedAt: 1794202320000, writtenAt: new Date(NOW_MS).toISOString() }),
        options: { expirationTtl: 2_592_000 },
      },
    ]);
  });

  it("answers 200 duplicate without calling WSPC when the delivery was already written", async () => {
    const { send, kv, drive } = setup();
    kv.store.set("delivery:dlv_abc", "{}");
    const res = await send(pebbleRequest({ delivery: "dlv_abc" }));
    expect(res).toEqual({ status: 200, text: "duplicate" });
    expect(drive.calls).toHaveLength(0);
    expect(kv.puts).toHaveLength(0);
  });

  it("a resent delivery is written only once", async () => {
    const { send, drive } = setup();
    const req = () => pebbleRequest({ delivery: "dlv_same", fields: { recordedAt: "1794202320000", transcription: "x" } });
    expect((await send(req())).text).toBe("ok");
    expect((await send(req())).text).toBe("duplicate");
    expect(drive.content).toBe(`- 2026-11-09 14:32 x\n${MARKER}\n`);
  });

  it("does not record the delivery when the write fails", async () => {
    const { send, kv, drive } = setup();
    drive.inject = [{ status: 401, code: "UNAUTHORIZED" }];
    const res = await send(pebbleRequest());
    expect(res.status).toBe(503);
    expect(kv.puts).toHaveLength(0);
  });

  it("writes anyway and warns when the KV lookup fails", async () => {
    const { send, kv, drive, logs } = setup();
    kv.failGet = true;
    const res = await send(pebbleRequest({ delivery: "dlv_abc" }));
    expect(res).toEqual({ status: 200, text: "ok" });
    expect(drive.writes).toHaveLength(1);
    expect(logs).toContainEqual({ level: "warn", data: expect.objectContaining({ event: "dedup_check_failed", delivery: "dlv_abc" }) });
  });

  it("still answers 200 ok and warns when storing the delivery fails", async () => {
    const { send, kv, logs } = setup();
    kv.failPut = true;
    const res = await send(pebbleRequest({ delivery: "dlv_abc" }));
    expect(res).toEqual({ status: 200, text: "ok" });
    expect(logs).toContainEqual({ level: "warn", data: expect.objectContaining({ event: "dedup_store_failed", delivery: "dlv_abc" }) });
  });
});
