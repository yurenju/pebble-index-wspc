// Probe WSPC Drive REST behaviour for appending to the end of a file.
// Usage: WSPC_API_KEY=... LIB_ID=lib_... node drive-append-test.mjs
import { createHash } from "node:crypto";

const API = "https://api.wspc.ai";
const KEY = process.env.WSPC_API_KEY;
const LIB = process.env.LIB_ID;
const N = Number(process.env.N ?? 10);
if (!KEY || !LIB) throw new Error("WSPC_API_KEY and LIB_ID are required");

const RUN = `_pebble-test/${Date.now()}`;
const MARKER = "<!-- pebble:end -->";
const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const auth = { Authorization: `Bearer ${KEY}` };
const contentUrl = (path, q = {}) =>
  `${API}/drive/libraries/${LIB}/files/content?` + new URLSearchParams({ path, ...q });

async function call(method, url, { body, headers = {} } = {}) {
  const t0 = performance.now();
  const res = await fetch(url, { method, body, headers: { ...auth, ...headers } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ms: Math.round(performance.now() - t0), headers: res.headers, text, json };
}

const get = (path) => call("GET", contentUrl(path));
const put = (path, content, { version, hash = sha(content), q = {} } = {}) =>
  call("PUT", contentUrl(path, version === undefined ? q : { ...q, expected_entry_version: String(version) }), {
    body: content,
    headers: { "Content-Type": "text/markdown", ...(hash ? { "x-drive-content-sha256": hash } : {}) },
  });
const edit = (path, old_string, new_string, extra = {}) =>
  call("POST", `${API}/drive/libraries/${LIB}/files/edit`, {
    body: JSON.stringify({ path, old_string, new_string, ...extra }),
    headers: { "Content-Type": "application/json" },
  });
const versionOf = (r) => Number(r.headers.get("x-drive-entry-version") ?? r.json?.entry?.entry_version);
const brief = (r) => ({ status: r.status, ms: r.ms, code: r.json?.error?.code, result: r.json?.result, entry_version: r.json?.entry?.entry_version, message: r.json?.error?.message });

const report = {};
const log = (k, v) => { report[k] = v; console.log(`\n## ${k}\n` + JSON.stringify(v, null, 2)); };

// --- Q3: is x-drive-content-sha256 required? -------------------------------
{
  const p = `${RUN}/sha.md`;
  const noHash = await put(p, "no hash\n", { version: 0, hash: null });
  const badHash = await put(`${RUN}/sha-bad.md`, "bad hash\n", { version: 0, hash: sha("something else") });
  const goodHash = await put(`${RUN}/sha-good.md`, "good hash\n", { version: 0 });
  log("Q3 sha256 header", { noHash: brief(noHash), badHash: brief(badHash), goodHash: brief(goodHash) });
}

// --- Q4: PUT without expected_entry_version on an existing file ------------
{
  const p = `${RUN}/blind.md`;
  const created = await put(p, "v1\n", { version: 0 });
  const blind = await put(p, "v2 blind\n");
  const stale = await put(p, "v3 stale\n", { version: 1 });
  const createAgain = await put(p, "v0 again\n", { version: 0 });
  const after = await get(p);
  log("Q4 PUT without version", {
    created: brief(created), blind: brief(blind), staleVersion1: brief(stale), version0OnExisting: brief(createAgain),
    finalContent: after.text, finalVersion: versionOf(after),
  });
}

// --- Q2: does files/edit accept a version? when does it 409? ---------------
{
  const p = `${RUN}/edit-version.md`;
  await put(p, `a\n${MARKER}\n`, { version: 0 });
  const missing = await edit(`${RUN}/does-not-exist.md`, "x", "y");
  const noMatch = await edit(p, "zzz-not-there", "y");
  const staleExpected = await edit(p, MARKER, `b\n${MARKER}`, { expected_version: 999 });
  const staleExpectedEntry = await edit(p, MARKER, `c\n${MARKER}`, { expected_entry_version: 999 });
  const multiMatch = await (async () => { await put(p, "dup\ndup\n"); return edit(p, "dup", "x"); })();
  const after = await get(p);
  log("Q2 edit version / errors", {
    missingFile: brief(missing), noMatch: brief(noMatch),
    bodyExpectedVersion999: brief(staleExpected), bodyExpectedEntryVersion999: brief(staleExpectedEntry),
    multipleMatchesWithoutReplaceAll: brief(multiMatch), contentAfter: after.text,
  });
}

// --- Q1: concurrent files/edit against one marker ---------------------------
async function concurrentEdits(round) {
  const p = `${RUN}/edit-concurrent-${round}.md`;
  await put(p, `# test\n${MARKER}\n`, { version: 0 });
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => edit(p, MARKER, `- line ${i}\n${MARKER}`)),
  );
  const after = await get(p);
  const kept = [...after.text.matchAll(/^- line (\d+)$/gm)].map((m) => Number(m[1]));
  return {
    statuses: results.map((r) => r.status), codes: results.map((r) => r.json?.error?.code ?? null),
    ms: results.map((r) => r.ms), kept: kept.length, of: N,
    okButLost: results.map((r, i) => r.status === 200 && !kept.includes(i) ? i : null).filter((x) => x !== null),
    markers: after.text.split(MARKER).length - 1, finalVersion: versionOf(after),
  };
}
log("Q1 concurrent edit", [await concurrentEdits(1), await concurrentEdits(2), await concurrentEdits(3)]);

// --- Q5: concurrent read-modify-write PUT with 409 retry -------------------
async function rmwAppend(p, line, maxAttempts = 30) {
  let attempts = 0;
  const statuses = [];
  while (attempts < maxAttempts) {
    attempts++;
    const r = await get(p);
    const base = r.status === 404 ? "" : r.text;
    const version = r.status === 404 ? 0 : versionOf(r);
    const w = await put(p, base + line + "\n", { version });
    statuses.push(w.status);
    if (w.status === 200) return { ok: true, attempts, statuses };
    if (w.status !== 409) return { ok: false, attempts, statuses, error: brief(w) };
    await new Promise((s) => setTimeout(s, Math.random() * 50 * attempts));
  }
  return { ok: false, attempts, statuses };
}
async function concurrentRmw(round) {
  const p = `${RUN}/rmw-concurrent-${round}.md`;
  await put(p, "# test\n", { version: 0 });
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: N }, (_, i) => rmwAppend(p, `- line ${i}`)));
  const wall = Math.round(performance.now() - t0);
  const after = await get(p);
  const kept = [...after.text.matchAll(/^- line (\d+)$/gm)].length;
  return { attempts: results.map((r) => r.attempts), allOk: results.every((r) => r.ok), kept, of: N, wallMs: wall,
    failures: results.filter((r) => !r.ok) };
}
log("Q5 concurrent read-modify-write", [await concurrentRmw(1), await concurrentRmw(2), await concurrentRmw(3)]);

// --- Q6: latency of one read + one write, sequential -----------------------
{
  const p = `${RUN}/latency.md`;
  await put(p, "# latency\n", { version: 0 });
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const r = await get(p);
    const w = await put(p, r.text + `- ${i}\n`, { version: versionOf(r) });
    const e = await edit(p, `- ${i}\n`, `- ${i}\n`.repeat(1) + "");
    samples.push({ getMs: r.ms, putMs: w.ms, putStatus: w.status, editMs: e.ms, editStatus: e.status });
  }
  const s = (k) => samples.map((x) => x[k]).sort((a, b) => a - b);
  log("Q6 latency", { samples, medianGet: s("getMs")[5], medianPut: s("putMs")[5], medianEdit: s("editMs")[5], maxGetPut: Math.max(...samples.map((x) => x.getMs + x.putMs)) });
}

console.log(`\nrun prefix: ${RUN}`);
