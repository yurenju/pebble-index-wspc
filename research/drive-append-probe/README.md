# WSPC Drive append probe (2026-11-09)

Throwaway branch for the wayfinder ticket "實測 WSPC Drive 接到檔尾的行為" (yurenju/pebble-index-wspc#12). Never merged.

- `drive-append-test.mjs`: sha256 header, PUT without version, edit errors / version field, concurrent edit (no retry), concurrent read-modify-write PUT with retry, latency.
- `edit-retry-test.mjs`: concurrent marker-append via `files/edit` with retry on 409 / 5xx.
- `*.output.txt`: raw output of the runs against library `pebble-relay-test`, N=10, run from a single machine.

Run: `WSPC_API_KEY=... LIB_ID=lib_... node <script>`
