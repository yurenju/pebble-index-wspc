import { describe, expect, it } from "vitest";
import { pebbleRequest, setup } from "./harness";

describe("routing", () => {
  it("rejects non-POST with 405", async () => {
    const { send, drive, kv } = setup();
    const res = await send(pebbleRequest({ method: "GET" }));
    expect(res.status).toBe(405);
    expect(drive.calls).toHaveLength(0);
    expect(kv.touched).toBe(0);
  });

  it("rejects paths other than / with 404", async () => {
    const { send } = setup();
    const res = await send(pebbleRequest({ url: "https://pebble-relay.example.workers.dev/hook" }));
    expect(res.status).toBe(404);
  });
});
