---
"@tesseron/core": minor
"@tesseron/web": minor
"@tesseron/react": minor
"@tesseron/svelte": minor
"@tesseron/vue": minor
"@tesseron/server": minor
"@tesseron/mcp": minor
"@tesseron/vite": minor
---

refactor(web, react, svelte, vue, core, server, mcp, vite): single shared implementation behind every SDK — zero duplicated logic across packages

Two families of copy-pasted code are collapsed to one source each. Every
public API — React hooks, Svelte stores, Vue composables, the gateway, the
server transports — is byte-for-byte behaviour-compatible; the duplication just
moves out of sight.

**Browser adapters.** `@tesseron/react`, `/svelte`, and `/vue` previously each
carried their own copy of the connection state machine (connect → resume →
`ResumeFailed` fallback → token rotation → save → `onWelcomeChange`), the
action/resource builder-chain application, the `localStorage` resume backend,
and the option/state types — with parity kept only by convention. That drift
surface is gone. A new framework-neutral reactive core in `@tesseron/web`
(`createConnectionController`, `registerAction`, `registerResource`,
`resolveResumeStorage`, `localStorageResumeBackend`, and the shared
`TesseronConnectionState` / `TesseronConnectionOptions` / `TesseronActionOptions`
/ `TesseronResourceOptions` / `TesseronResumeStatus` types) holds the logic
once; each adapter is now a thin (~10-line-per-primitive) binding onto its
framework's reactivity and lifecycle. The per-framework public names are
unchanged (React keeps its `Use…Options` aliases; Svelte/Vue surface the shared
types through their existing `export *`).

**Node utilities.** The byte-identical `fs-hygiene.ts` (three copies across
`/server`, `/vite`, `/mcp`), the duplicated claim/session/token mint helpers
(`/server`, `/vite`, plus inline in `/mcp`), and the host-bind helpers — the
rolling-window bind rate limiter, the `tesseron/hello` detector, the synthesized
pre-claim welcome, and the bind-failure lockout constants (byte-identical across
the two `/server` host transports and re-implemented again in `/vite`) — now
live once behind the new node-only `@tesseron/core/node` subpath
(`ensurePrivateDir`, `writePrivateFile`, `mintClaimCode`, `mintSessionId`,
`mintInvocationId`, `mintResumeToken`, `BindRateLimiter`, `isHelloFrame`,
`buildSynthesizedWelcomeResponse`, `BIND_FAILURE_*`). The main `@tesseron/core`
entry stays browser-safe. The drift-detection parity test that guarded the three
`fs-hygiene` copies is removed — there is nothing left to drift. `@tesseron/mcp`
keeps its historical `generate*` names as re-export aliases.
