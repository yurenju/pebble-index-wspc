import { describe, expect, it } from "vitest";
import { FakeDrive, MARKER, PATH, pebbleRequest, setup, sha256Hex } from "./harness";

const fields = { recordedAt: "1794202320000", transcription: "x" };
const ENTRY = "- 2026-11-09 14:32 x";

describe("creating the destination", () => {
  it("creates the file with version 0 when edit answers 404 FILE_NOT_FOUND", async () => {
    const drive = new FakeDrive(null);
    const { send } = setup({ drive });
    const res = await send(pebbleRequest({ fields }));
    expect(res).toEqual({ status: 200, text: "ok" });
    expect(drive.content).toBe(`${ENTRY}\n${MARKER}\n`);

    const put = drive.calls[1]!;
    expect(put.method).toBe("PUT");
    expect(put.url.pathname).toBe("/drive/libraries/lib_TEST/files/content");
    expect(put.url.searchParams.get("path")).toBe(PATH);
    expect(put.url.searchParams.get("expected_entry_version")).toBe("0");
    expect(put.headers.get("content-type")).toBe("text/markdown");
    // Known-good digest of the body, independent of the code under test's encoding.
    expect(put.headers.get("x-drive-content-sha256")).toBe(await sha256Hex(`${ENTRY}\n${MARKER}\n`));
  });

  it("hashes the UTF-8 bytes of non-ASCII content correctly", async () => {
    const drive = new FakeDrive(null);
    const { send } = setup({ drive });
    const res = await send(pebbleRequest({ fields: { recordedAt: "1794202320000", transcription: "報價單" } }));
    expect(res.status).toBe(200);
    expect(drive.content).toBe(`- 2026-11-09 14:32 報價單\n${MARKER}\n`);
  });

  it("falls back to edit when someone else created the file first (409 on create)", async () => {
    const drive = new FakeDrive(null);
    drive.onCall = (call) => {
      // Another request creates the file between our edit and our create.
      if (call.method === "PUT" && drive.content === null) {
        drive.content = `- 2026-11-09 14:00 other\n${MARKER}\n`;
        drive.version = 1;
      }
    };
    const { send } = setup({ drive });
    const res = await send(pebbleRequest({ fields }));
    expect(res).toEqual({ status: 200, text: "ok" });
    expect(drive.calls.map((c) => c.method)).toEqual(["POST", "PUT", "POST"]);
    expect(drive.content).toBe(`- 2026-11-09 14:00 other\n${ENTRY}\n${MARKER}\n`);
  });
});

describe("repairing the end marker", () => {
  it.each([
    ["marker deleted (EDIT_NO_MATCH)", "- a\n- b\n", `- a\n- b\n${ENTRY}\n${MARKER}\n`, "EDIT_NO_MATCH"],
    ["file without trailing newline", "- a", `- a\n${ENTRY}\n${MARKER}\n`, "EDIT_NO_MATCH"],
    ["empty file", "", `${ENTRY}\n${MARKER}\n`, "EDIT_NO_MATCH"],
    ["several markers (EDIT_NOT_UNIQUE)", `- a\n${MARKER}\n- b\n  ${MARKER}  \n`, `- a\n- b\n${ENTRY}\n${MARKER}\n`, "EDIT_NOT_UNIQUE"],
    ["marker inside a line", `- a ${MARKER} tail\n${MARKER}\n`, `- a  tail\n${ENTRY}\n${MARKER}\n`, "EDIT_NOT_UNIQUE"],
    ["marker with notes below it", `- a\n${MARKER}\nnote\n${MARKER}`, `- a\nnote\n${ENTRY}\n${MARKER}\n`, "EDIT_NOT_UNIQUE"],
  ])("rewrites the file when the %s", async (_name, before, after, reason) => {
    const drive = new FakeDrive(before);
    drive.version = 7;
    const { send, logs } = setup({ drive });
    const res = await send(pebbleRequest({ delivery: "dlv_r", fields }));
    expect(res).toEqual({ status: 200, text: "ok" });
    expect(drive.content).toBe(after);

    const put = drive.calls.find((c) => c.method === "PUT")!;
    expect(put.url.searchParams.get("expected_entry_version")).toBe("7");
    expect(put.headers.get("x-drive-content-sha256")).toBe(await sha256Hex(after));
    expect(logs).toContainEqual({ level: "warn", data: { event: "marker_repaired", reason, delivery: "dlv_r" } });
  });

  it("falls back to edit when the file changed during the repair (409)", async () => {
    const drive = new FakeDrive("- a\n");
    drive.onCall = (call) => {
      // Another request repairs the file between our GET and our PUT.
      if (call.method === "PUT" && !drive.content!.includes(MARKER)) {
        drive.content = `- a\n- other\n${MARKER}\n`;
        drive.version++;
      }
    };
    const { send } = setup({ drive });
    const res = await send(pebbleRequest({ fields }));
    expect(res).toEqual({ status: 200, text: "ok" });
    expect(drive.calls.map((c) => c.method)).toEqual(["POST", "GET", "PUT", "POST"]);
    expect(drive.content).toBe(`- a\n- other\n${ENTRY}\n${MARKER}\n`);
  });

  it("creates the file when it disappears before the repair reads it", async () => {
    const drive = new FakeDrive("- a\n");
    drive.onCall = (call) => {
      if (call.method === "GET") drive.content = null;
    };
    const { send } = setup({ drive });
    const res = await send(pebbleRequest({ fields }));
    expect(res).toEqual({ status: 200, text: "ok" });
    expect(drive.calls.map((c) => c.method)).toEqual(["POST", "GET", "PUT"]);
    expect(drive.calls[2]!.url.searchParams.get("expected_entry_version")).toBe("0");
    expect(drive.content).toBe(`${ENTRY}\n${MARKER}\n`);
  });
});
