# pebble-index-wspc

`pebble-relay`: a single-owner Cloudflare Worker that receives Pebble Index webhook requests
and appends each transcript as one Entry line to a fixed WSPC Drive file.
Spec: [yurenju/pebble-index-wspc#19](https://github.com/yurenju/pebble-index-wspc/issues/19); vocabulary in [CONTEXT.md](CONTEXT.md).

## Layout

- `src/index.ts` — Worker entry; wires real `fetch`, clock and `console` into the Relay.
- `src/relay.ts` — request flow: method/path, auth, test events, parsing, dedup, write, logging.
- `src/auth.ts` — HMAC signature verification (webhook protocol version `1`).
- `src/entry.ts` — transcript normalisation and Entry formatting.
- `src/append.ts` — appending to the Destination: edit / create / marker repair, retries and budgets.

## Development

```bash
npm install
npm run typecheck
npm test
```

Tests drive the Worker's `fetch` handler with an in-memory fake of the WSPC Drive file, a fake KV
namespace and a fake clock.

## Deploy

Copy `wrangler.example.toml` to `wrangler.toml` (git-ignored), fill in the KV namespace id and the
three `[vars]`, then:

```bash
npx wrangler secret put WSPC_API_KEY
npx wrangler secret put PEBBLE_SIGNING_SECRET
npx wrangler deploy
```
