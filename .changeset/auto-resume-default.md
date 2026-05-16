---
'@tesseron/core': minor
'@tesseron/mcp': minor
'@tesseron/docs-mcp': minor
'@tesseron/web': minor
'@tesseron/server': minor
'@tesseron/react': minor
'@tesseron/svelte': minor
'@tesseron/vue': minor
'@tesseron/vite': minor
---

feat(vite, web, react, vue, svelte, mcp): session resume is now the default — no more claim-code dance on refresh

A casual page refresh keeps the same Tesseron session paired with the agent.
The work coordinates four layers; each is independently correct, and together
they make refresh-without-re-claim work end-to-end for every host.

- **@tesseron/vite** — replaces the per-WS instance model with a
  **SessionManager**. The unit of identity is now a `Session` keyed by
  `sessionId`, not the browser WebSocket. Browser WSes attach via `tesseron/hello`
  (create) or `tesseron/resume` (re-attach to an existing Session); browser
  detach starts an idle TTL (default 4 h, configurable via the new
  `sessionIdleTtlMs` option), and a reattaching browser within that window
  cancels it. The gateway-side bridge stays open across detach/reattach so
  the agent never sees a disconnect. The previous "host-mint sessions don't
  honour resume" rejection (#68) is replaced by proper resume validation:
  constant-time compare against the stored resume token, rotate on success,
  fall through to `ResumeFailed` on any miss.

- **@tesseron/mcp** — bumps `DEFAULT_RESUME_TTL_MS` from 90 seconds to
  **4 hours** for the gateway-mint path (Node-side hosts via `@tesseron/server`).
  A `TESSERON_RESUME_TTL_MS` env var (non-negative integer milliseconds; `0`
  disables resume) lets operators tune it without a fork.

- **@tesseron/web** — `tesseron.connect()` auto-persists the
  `{ sessionId, resumeToken }` pair to `localStorage` (`'tesseron:resume'`)
  and replays it on the next connect. New `WebConnectOptions.resume` accepts:
  `true`/omitted (default), `false`, a string key, a `ResumeStorage` backend,
  or an explicit `ResumeCredentials` literal.

- **@tesseron/react** — `useTesseronConnection`'s `resume` default flips from
  off to `true`. The hook always passes an explicit `resume` to the web SDK
  so the SDK's own auto-persist layer doesn't double-write under the hook's
  storage.

- **@tesseron/vue** and **@tesseron/svelte** — full parity with React:
  `resume` option (defaults to `true`), `resumeStatus` on the reactive state,
  `onWelcomeChange` subscription so `claimCode` clears automatically when an
  agent claims (previously stayed stale until refresh).

Behavioural envelope:

- Same session survives refresh, HMR reload, brief network blip, and even a
  short laptop sleep, for both browser tabs (`@tesseron/vite`) and Node
  processes (`@tesseron/server`).
- Invalid resume tokens (TTL expired, gateway/host restarted, corrupted
  storage) fail gracefully: `ResumeFailed` → SDK clears storage → fresh
  `tesseron/hello` → new claim code.
- Opt out everywhere with `{ resume: false }` for incognito-style flows.

No protocol bump — the wire shape is unchanged. See the [session resume
docs](https://tesseron.dev/protocol/resume/) and the
[vite plugin's Session model](https://tesseron.dev/sdk/typescript/vite/#sessions-span-browser-refreshes)
for the implementation details and the [security model](https://tesseron.dev/protocol/security/)
for the threat-model notes (unchanged: same-UID local process can read
`localStorage` and `~/.tesseron/instances/`, so the host-mint resume window
is the same trust surface as the existing claim-code flow).
