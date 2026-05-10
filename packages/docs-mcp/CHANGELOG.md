# @tesseron/docs-mcp

## 2.8.1

### Patch Changes

- [#89](https://github.com/BrainBlend-AI/tesseron/pull/89) [`77f8a64`](https://github.com/BrainBlend-AI/tesseron/commit/77f8a641c8fb514baefe7e4b24a605772711a2ae) by Kenny - fix(core, web, react): make `connect()` re-entrant so claimed-session resume survives StrictMode and HMR (closes [#88](https://github.com/BrainBlend-AI/tesseron/issues/88))

  Two `connect()` calls used to race on `this.transport`: the second closed the
  first's socket mid-handshake, frames in flight on either socket — including
  the gateway's `tesseron/resume` response — could be lost, and a claimed
  session ended up displaying a fresh claim code instead of resuming. The
  predecessor fix in [#68](https://github.com/BrainBlend-AI/tesseron/issues/68) papered this over for unclaimed sessions, but
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

## 2.8.0

## 2.7.0

### Minor Changes

- [#82](https://github.com/BrainBlend-AI/tesseron/pull/82) [`cba7894`](https://github.com/BrainBlend-AI/tesseron/commit/cba7894a3a90fb6b2de7f2a1955ca842a514100b) by Kenny - feat: add `@tesseron/pi` Pi coding-agent plugin

  New workspace package shipping a Pi extension (`@mariozechner/pi-coding-agent`) that exposes the Tesseron MCP gateway and docs server as eight typed Pi tools (`tesseron_claim_session`, `tesseron_list_actions`, `tesseron_list_pending_claims`, `tesseron_invoke_action`, `tesseron_read_resource`, `tesseron_docs_list`, `tesseron_docs_search`, `tesseron_docs_read`) plus the same five-skill bundle the Claude/Codex plugin ships. Install with `pi install -l npm:@tesseron/pi@<v>`.

  The Pi extension uses a hand-rolled stdio JSON-RPC client (no `@modelcontextprotocol/sdk` dep) to spawn `npx -y @tesseron/{mcp,docs-mcp}@<version>` as child processes and forward `tools/call` requests. Pinned `@tesseron/mcp` version stays in lockstep with the rest of the SDK fixed group via an extension to `scripts/sync-plugin-version.mjs`, which now also mirrors `plugin/skills/` → `packages/pi/skills/` and fails CI on any drift.

## 2.6.1

## 2.6.0

## 2.5.1

## 2.5.0

## 2.4.0

## 2.3.1

## 2.3.0

## 2.2.2

## 2.2.1

## 2.2.0

## 2.1.1

## 2.1.0

## 2.0.0

## 0.2.0

### Minor Changes

- [#14](https://github.com/BrainBlend-AI/tesseron/pull/14) [`5545ff4`](https://github.com/BrainBlend-AI/tesseron/commit/5545ff42d552a7d0b7fb9d588f8288f771251565) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Initial release of `@tesseron/docs-mcp`: a stdio MCP server that exposes the Tesseron documentation as three tools (`list_docs`, `search_docs`, `read_doc`) and `tesseron-docs://<slug>` resources. The docs snapshot (37 pages) is bundled in the package at publish time; search runs locally via minisearch BM25. Distribute via `npx @tesseron/docs-mcp`.
