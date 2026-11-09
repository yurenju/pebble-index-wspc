import { describe, expect, it } from "vitest";
import { FakeDrive, MARKER, pebbleRequest, setup } from "./harness";

// 2026-11-09 05:32:00 UTC = 14:32 in Asia/Tokyo
const RECORDED_AT = "1794202320000";

describe("test events", () => {
  it("answers 200 test without touching WSPC or KV", async () => {
    const { send, drive, kv } = setup();
    const res = await send(pebbleRequest({ test: true, fields: { test: "true" } }));
    expect(res).toEqual({ status: 200, text: "test" });
    expect(drive.calls).toHaveLength(0);
    expect(kv.touched).toBe(0);
  });
});

describe("parsing", () => {
  it("rejects a request without a transcription field with 400", async () => {
    const { send, drive } = setup();
    const res = await send(pebbleRequest({ fields: { recordedAt: RECORDED_AT, audio: "..." } }));
    expect(res.status).toBe(400);
    expect(drive.calls).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["non-integer", "17626663.5"],
    ["text", "yesterday"],
    ["out-of-range", "9000000000000000"],
  ])(
    "rejects a %s recordedAt with 400",
    async (_name, recordedAt) => {
      const { send } = setup();
      const fields: Record<string, string> = { transcription: "hi" };
      if (recordedAt !== undefined) fields.recordedAt = recordedAt;
      const res = await send(pebbleRequest({ fields }));
      expect(res.status).toBe(400);
    },
  );

  it.each([["blank", "   "], ["empty", ""], ["newlines only", "\r\n\n \r "]])(
    "answers 200 empty for a %s transcript without touching WSPC or KV",
    async (_name, transcription) => {
      const { send, drive, kv } = setup();
      const res = await send(pebbleRequest({ fields: { recordedAt: RECORDED_AT, transcription } }));
      expect(res).toEqual({ status: 200, text: "empty" });
      expect(drive.calls).toHaveLength(0);
      expect(kv.touched).toBe(0);
    },
  );
});

describe("entries", () => {
  it("appends the entry just above the end marker", async () => {
    const drive = new FakeDrive(`- 2026-11-08 09:00 earlier\n${MARKER}\n`);
    const { send } = setup({ drive });
    const res = await send(
      pebbleRequest({ fields: { recordedAt: RECORDED_AT, transcription: "明天記得把報價單寄給客戶。" } }),
    );
    expect(res).toEqual({ status: 200, text: "ok" });
    expect(drive.content).toBe(
      `- 2026-11-08 09:00 earlier\n- 2026-11-09 14:32 明天記得把報價單寄給客戶。\n${MARKER}\n`,
    );
  });

  it("ignores audio, client and test fields", async () => {
    const { send, drive } = setup();
    await send(
      pebbleRequest({
        fields: { audio: "RIFF....", client: "{}", test: "false", recordedAt: RECORDED_AT, transcription: "ok" },
      }),
    );
    expect(drive.content).toBe(`- 2026-11-09 14:32 ok\n${MARKER}\n`);
  });

  it("collapses line breaks and the whitespace around them into one space and trims", async () => {
    const { send, drive } = setup();
    await send(
      pebbleRequest({
        fields: { recordedAt: RECORDED_AT, transcription: "  下午三點跟設計師開會 \r\n\n\r  記得帶草稿\t\n" },
      }),
    );
    expect(drive.content).toBe(`- 2026-11-09 14:32 下午三點跟設計師開會 記得帶草稿\n${MARKER}\n`);
  });

  it("keeps inner spaces that are not around a line break", async () => {
    const { send, drive } = setup();
    await send(pebbleRequest({ fields: { recordedAt: RECORDED_AT, transcription: "a  b" } }));
    expect(drive.content).toBe(`- 2026-11-09 14:32 a  b\n${MARKER}\n`);
  });

  it("uses the next local day when the timezone crosses midnight (UTC 15:30 → Tokyo 00:30)", async () => {
    const { send, drive } = setup();
    // 2026-11-08 15:30:59 UTC
    const recordedAt = String(Date.UTC(2026, 10, 8, 15, 30, 59));
    await send(pebbleRequest({ fields: { recordedAt, transcription: "離線時錄的" } }));
    expect(drive.content).toBe(`- 2026-11-09 00:30 離線時錄的\n${MARKER}\n`);
  });

  it("honours a configured TIMEZONE", async () => {
    const { send, drive } = setup({ env: { TIMEZONE: "America/New_York" } });
    await send(pebbleRequest({ fields: { recordedAt: RECORDED_AT, transcription: "x" } }));
    expect(drive.content).toBe(`- 2026-11-09 00:32 x\n${MARKER}\n`);
  });

  it("defaults TIMEZONE to Asia/Tokyo", async () => {
    const { send, drive } = setup({ env: { TIMEZONE: undefined } });
    await send(pebbleRequest({ fields: { recordedAt: RECORDED_AT, transcription: "x" } }));
    expect(drive.content).toBe(`- 2026-11-09 14:32 x\n${MARKER}\n`);
  });

  it("sends the edit with the API key, library and path", async () => {
    const { send, drive } = setup();
    await send(pebbleRequest({ fields: { recordedAt: RECORDED_AT, transcription: "x" } }));
    expect(drive.calls).toHaveLength(1);
    const [call] = drive.calls;
    expect(call!.method).toBe("POST");
    expect(call!.url.href).toBe("https://api.wspc.ai/drive/libraries/lib_TEST/files/edit");
    expect(JSON.parse(call!.body)).toEqual({
      path: "00-inbox/pebble-index-records.md",
      old_string: MARKER,
      new_string: `- 2026-11-09 14:32 x\n${MARKER}`,
    });
  });
});
