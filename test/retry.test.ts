import { describe, expect, it } from "vitest";
import { FakeDrive, MARKER, NOW_MS, pebbleRequest, setup, type Injected } from "./harness";

const fields = { recordedAt: "1794202320000", transcription: "  第一行\n第二行 " };
const ENTRY = "- 2026-11-09 14:32 第一行 第二行";
const conflict: Injected = { status: 409, code: "VERSION_CONFLICT" };
const timeoutError = () => new DOMException("The operation timed out.", "TimeoutError");

function writeFailed(logs: { level: string; data: Record<string, unknown> }[]) {
  const failed = logs.filter((l) => l.data.event === "write_failed");
  expect(failed).toHaveLength(1);
  expect(failed[0]!.level).toBe("error");
  return failed[0]!.data;
}

describe("retrying writes", () => {
  it("resends the same edit after 409 VERSION_CONFLICT, waiting 100–500 ms", async () => {
    const { send, drive, clock } = setup();
    drive.inject = [conflict, conflict, conflict];
    const res = await send(pebbleRequest({ fields }));
    expect(res).toEqual({ status: 200, text: "ok" });
    expect(drive.writes).toHaveLength(4);
    expect(new Set(drive.writes.map((c) => c.body)).size).toBe(1);
    expect(clock.sleeps).toEqual([300, 300, 300]); // random() = 0.5
    expect(drive.content).toBe(`${ENTRY}\n${MARKER}\n`);
  });

  it("waits a random 100–500 ms after a 409 on create before going back to edit", async () => {
    const drive = new FakeDrive(null);
    drive.inject = [{ status: 404, code: "FILE_NOT_FOUND" }, { status: 409, code: "VERSION_CONFLICT" }];
    const { send, clock } = setup({ drive });
    await send(pebbleRequest({ fields }));
    expect(clock.sleeps).toEqual([300]);
  });

  it.each([500, 502, 503, 504])("retries after %i with exponential backoff", async (status) => {
    const { send, drive, clock } = setup();
    drive.inject = [{ status }, { status }, { status }];
    const res = await send(pebbleRequest({ fields }));
    expect(res).toEqual({ status: 200, text: "ok" });
    // 0.5 s, 1 s, 2 s, each + 125 ms jitter (random() = 0.5 of 0–250 ms)
    expect(clock.sleeps).toEqual([625, 1125, 2125]);
    expect(drive.content).toBe(`${ENTRY}\n${MARKER}\n`);
  });

  it("caps the backoff at 8 s", async () => {
    const { send, drive, clock } = setup();
    drive.inject = Array.from({ length: 7 }, () => ({ status: 500 }));
    await send(pebbleRequest({ fields }));
    expect(clock.sleeps).toEqual([625, 1125, 2125, 4125, 8125, 8125, 8125]);
  });

  it.each([
    ["a network error", () => new TypeError("fetch failed")],
    ["a timeout", timeoutError],
  ])("retries after %s", async (_name, error) => {
    const { send, drive, clock } = setup();
    drive.inject = [{ throw: error() }];
    const res = await send(pebbleRequest({ fields }));
    expect(res).toEqual({ status: 200, text: "ok" });
    expect(clock.sleeps).toEqual([625]);
  });

  it("gives every WSPC request a timeout signal", async () => {
    const drive = new FakeDrive("- a\n");
    const { send } = setup({ drive });
    await send(pebbleRequest({ fields }));
    expect(drive.calls.map((c) => c.method)).toEqual(["POST", "GET", "PUT"]);
    expect(drive.calls.every((c) => c.signal instanceof AbortSignal && !c.signal.aborted)).toBe(true);
  });

  it("honours Retry-After seconds on 429", async () => {
    const { send, drive, clock } = setup();
    drive.inject = [{ status: 429, headers: { "retry-after": "3" } }];
    const res = await send(pebbleRequest({ fields }));
    expect(res.status).toBe(200);
    expect(clock.sleeps).toEqual([3000]);
  });

  it("honours a Retry-After HTTP date on 429", async () => {
    const { send, drive, clock } = setup();
    drive.inject = [{ status: 429, headers: { "retry-after": new Date(NOW_MS + 5000).toUTCString() } }];
    const res = await send(pebbleRequest({ fields }));
    expect(res.status).toBe(200);
    expect(clock.sleeps).toEqual([5000]);
  });

  it("uses exponential backoff on 429 without Retry-After", async () => {
    const { send, drive, clock } = setup();
    drive.inject = [{ status: 429 }];
    await send(pebbleRequest({ fields }));
    expect(clock.sleeps).toEqual([625]);
  });

  it("gives up at once when Retry-After exceeds the remaining budget", async () => {
    const { send, drive, clock, logs } = setup();
    drive.inject = [{ status: 429, code: "RATE_LIMITED", headers: { "retry-after": "120" } }];
    const res = await send(pebbleRequest({ fields }));
    expect(res).toEqual({ status: 503, text: "write failed" });
    expect(drive.calls).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
    expect(writeFailed(logs)).toMatchObject({ status: 429, code: "BUDGET_EXCEEDED", attempts: 1 });
  });

  it.each([
    ["401", { status: 401, code: "UNAUTHORIZED" }],
    ["403", { status: 403, code: "FORBIDDEN" }],
    ["413", { status: 413, code: "PAYLOAD_TOO_LARGE" }],
    ["FILE_TOO_LARGE", { status: 400, code: "FILE_TOO_LARGE" }],
    ["a missing library", { status: 404, code: "LIBRARY_NOT_FOUND" }],
    ["VALIDATION_ERROR", { status: 400, code: "VALIDATION_ERROR" }],
  ])("gives up without retrying on %s", async (_name, injected) => {
    const { send, drive, clock, kv, logs } = setup();
    drive.inject = [injected];
    const res = await send(pebbleRequest({ fields }));
    expect(res).toEqual({ status: 503, text: "write failed" });
    expect(drive.calls).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
    expect(kv.puts).toHaveLength(0);
    expect(writeFailed(logs)).toMatchObject({ status: injected.status, code: injected.code, attempts: 1 });
  });
});

describe("giving up", () => {
  it("stops after 20 writes and logs a complete write_failed line", async () => {
    const { send, drive, clock, logs } = setup();
    drive.inject = Array.from({ length: 30 }, () => ({ ...conflict, message: "busy" }));
    const res = await send(
      pebbleRequest({ delivery: "dlv_full", trigger: "double_click_and_hold", fields }),
    );
    expect(res).toEqual({ status: 503, text: "write failed" });
    expect(drive.writes).toHaveLength(20);
    expect(writeFailed(logs)).toEqual({
      event: "write_failed",
      delivery: "dlv_full",
      trigger: "double_click_and_hold",
      recordedAt: "2026-11-09T05:32:00.000Z",
      status: 409,
      code: "VERSION_CONFLICT",
      message: "busy",
      attempts: 20,
      elapsedMs: clock.ms - NOW_MS,
      transcript: "  第一行\n第二行 ",
      entry: ENTRY,
    });
    expect(clock.ms - NOW_MS).toBe(19 * 300);
  });

  it("counts edit, create and repair writes against the same 20, but not the repair GET", async () => {
    const drive = new FakeDrive("- a\n");
    // Every repair PUT loses the race, so the Relay keeps cycling edit → GET → PUT.
    drive.onCall = (call) => {
      if (call.method === "PUT") drive.version++;
    };
    const { send } = setup({ drive });
    const res = await send(pebbleRequest({ fields }));
    expect(res.status).toBe(503);
    expect(drive.writes).toHaveLength(20);
    expect(drive.calls.filter((c) => c.method === "GET")).toHaveLength(10);
  });

  it("stops before 90 s have passed and reports BUDGET_EXCEEDED", async () => {
    const { send, drive, clock, logs } = setup();
    drive.inject = Array.from({ length: 30 }, () => ({ status: 503, code: "UNAVAILABLE", message: "down" }));
    const res = await send(pebbleRequest({ fields }));
    expect(res).toEqual({ status: 503, text: "write failed" });
    expect(clock.ms - NOW_MS).toBeLessThanOrEqual(90_000);
    const log = writeFailed(logs);
    expect(log).toMatchObject({ status: 503, code: "BUDGET_EXCEEDED", message: "down" });
    expect(log.attempts).toBe(drive.writes.length);
    expect(drive.writes.length).toBeLessThan(20);
  });

  it("counts time spent waiting on WSPC against the 90 s budget", async () => {
    const { send, drive, clock, logs } = setup();
    drive.latencyMs = 15_000;
    drive.inject = Array.from({ length: 30 }, () => ({ throw: timeoutError() }));
    const res = await send(pebbleRequest({ fields }));
    expect(res.status).toBe(503);
    expect(clock.ms - NOW_MS).toBeLessThanOrEqual(90_000 + 15_000);
    expect(drive.writes.length).toBeLessThanOrEqual(6);
    // Only writes actually sent count.
    expect(writeFailed(logs).attempts).toBe(drive.writes.length);
  });

  it("reports NETWORK_ERROR with a null status when the last write failed on the network", async () => {
    const { send, drive, logs } = setup();
    drive.inject = [...Array.from({ length: 19 }, () => conflict), { throw: new TypeError("fetch failed") }];
    await send(pebbleRequest({ fields }));
    expect(writeFailed(logs)).toMatchObject({ status: null, code: "NETWORK_ERROR", message: "fetch failed", attempts: 20 });
  });

  it("reports TIMEOUT when the last write timed out", async () => {
    const { send, drive, logs } = setup();
    drive.inject = [...Array.from({ length: 19 }, () => conflict), { throw: timeoutError() }];
    await send(pebbleRequest({ fields }));
    expect(writeFailed(logs)).toMatchObject({ status: null, code: "TIMEOUT", attempts: 20 });
  });

  it("gives up on a repair read without x-drive-entry-version instead of guessing version 0", async () => {
    const drive = new FakeDrive("- a\n");
    drive.omitVersionHeader = true;
    const { send, logs } = setup({ drive });
    const res = await send(pebbleRequest({ fields }));
    expect(res).toEqual({ status: 503, text: "write failed" });
    expect(drive.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    expect(writeFailed(logs)).toMatchObject({ status: 200, code: "INVALID_RESPONSE", attempts: 1 });
  });

  it("treats an invalid TIMEZONE as a write failure", async () => {
    const { send, drive, kv, logs } = setup({ env: { TIMEZONE: "Mars/Olympus" } });
    const res = await send(pebbleRequest({ fields }));
    expect(res).toEqual({ status: 503, text: "write failed" });
    expect(drive.calls).toHaveLength(0);
    expect(kv.puts).toHaveLength(0);
    expect(writeFailed(logs)).toMatchObject({ code: "INVALID_TIMEZONE", attempts: 0, transcript: fields.transcription });
  });
});
