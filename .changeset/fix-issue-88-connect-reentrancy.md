---
'@tesseron/core': patch
'@tesseron/web': patch
'@tesseron/react': patch
'@tesseron/server': patch
'@tesseron/mcp': patch
'@tesseron/docs-mcp': patch
'@tesseron/svelte': patch
'@tesseron/vue': patch
'@tesseron/vite': patch
---

fix(core, web, react): make `connect()` re-entrant so claimed-session resume survives StrictMode and HMR (closes #88)

Two `connect()` calls used to race on `this.transport`: the second closed the
first's socket mid-handshake, frames in flight on either socket — including
the gateway's `tesseron/resume` response — could be lost, and a claimed
session ended up displaying a fresh claim code instead of resuming. The
predecessor fix in #68 papered this over for unclaimed sessions, but
claimed-session resume across full page reloads (e.g. Vite hot-reloading a
module-scope side effect) still failed.

Now:

- `TesseronClient.connect()` (core) eagerly closes the prior transport on
  re-entry, then queues the new handshake behind the prior connect's
  settlement and the prior transport's `onClose` drain. New dispatcher
  state is only installed once the old socket has stopped touching it,
  so a late-firing `onClose` can never trample the new welcome.
- `WebTesseronClient.connect()` (web, URL form) deduplicates concurrent
  calls with the same URL and the same resume credentials: the second
  caller shares the in-flight promise (and the in-flight WebSocket)
  instead of opening a parallel one. Without de-dup, the gateway would
  receive two `tesseron/resume` requests carrying the same single-shot
  token, the first would consume the zombie, and the second would
  invariably fail with `ResumeFailed`.
- `useTesseronConnection` (react) now defers transport ownership to the
  singleton's URL-form `connect()` and no longer closes the WebSocket on
  cleanup. Under React 18 StrictMode the second mount dedupes onto the
  first mount's still-in-flight promise, so only one socket is opened
  and only one `tesseron/resume` reaches the gateway.

Consumer apps can now drop the `beforeunload`-clears-`tesseron:resume`
workaround that was needed to mask the race; the SDK manages the
lifecycle by itself.
