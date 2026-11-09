// Concurrent files/edit marker-append with retry on 409 / 5xx.
// Usage: WSPC_API_KEY=... LIB_ID=lib_... node edit-retry-test.mjs
import { createHash } from "node:crypto";
const API = "https://api.wspc.ai", KEY = process.env.WSPC_API_KEY, LIB = process.env.LIB_ID, N = Number(process.env.N ?? 10);
const MARKER = "<!-- pebble:end -->", RUN = `_pebble-test/edit-retry-${Date.now()}`;
const auth = { Authorization: `Bearer ${KEY}` };
const sha = (s) => createHash("sha256").update(s).digest("hex");
async function put(path, body) {
  const r = await fetch(`${API}/drive/libraries/${LIB}/files/content?` + new URLSearchParams({ path, expected_entry_version: "0" }),
    { method: "PUT", body, headers: { ...auth, "Content-Type": "text/markdown", "x-drive-content-sha256": sha(body) } });
  if (r.status !== 200) throw new Error(`put ${r.status} ${await r.text()}`);
}
async function edit(path, line) {
  const t0 = performance.now(); const statuses = [];
  for (let a = 1; a <= 30; a++) {
    const r = await fetch(`${API}/drive/libraries/${LIB}/files/edit`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ path, old_string: MARKER, new_string: `${line}\n${MARKER}` }) });
    const j = await r.json().catch(() => ({})); statuses.push(r.status === 200 ? 200 : `${r.status}:${j?.error?.code}`);
    if (r.status === 200) return { ok: true, attempts: a, statuses, ms: Math.round(performance.now() - t0) };
    if (r.status !== 409 && r.status < 500) return { ok: false, attempts: a, statuses };
    await new Promise((s) => setTimeout(s, Math.random() * 50 * a));
  }
  return { ok: false, attempts: 30, statuses };
}
for (let round = 1; round <= 3; round++) {
  const p = `${RUN}/r${round}.md`; await put(p, `# t\n${MARKER}\n`);
  const t0 = performance.now();
  const res = await Promise.all(Array.from({ length: N }, (_, i) => edit(p, `- line ${i}`)));
  const wall = Math.round(performance.now() - t0);
  const txt = await (await fetch(`${API}/drive/libraries/${LIB}/files/content?` + new URLSearchParams({ path: p }), { headers: auth })).text();
  const lines = [...txt.matchAll(/^- line (\d+)$/gm)].map((m) => +m[1]);
  console.log(JSON.stringify({ round, attempts: res.map((r) => r.attempts), allOk: res.every((r) => r.ok), kept: lines.length,
    dupes: lines.length - new Set(lines).size, markers: txt.split(MARKER).length - 1, wallMs: wall, maxMs: Math.max(...res.map((r) => r.ms ?? 0)),
    non409: res.flatMap((r) => r.statuses).filter((s) => s !== 200 && !String(s).startsWith("409")) }));
}
