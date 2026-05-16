---
title: "@tesseron/vite"
description: Vite plugin that exposes `/@tesseron/ws` on your dev server and bridges browser tabs to the Tesseron gateway.
related:
  - sdk/typescript/web
  - protocol/transport
  - overview/architecture
---

`@tesseron/vite` is the bridge that lets `@tesseron/web` (and `@tesseron/react`, `@tesseron/svelte`, `@tesseron/vue`) connect without a separate port.

## Why it exists

Browsers can't bind TCP ports. The gateway needs a WebSocket endpoint to dial. The Vite dev server is already listening on a port - the plugin piggybacks on it.

When a browser tab opens your dev URL, it dials `/@tesseron/ws` on the same origin. The plugin:

1. Accepts the browser connection (no subprotocol).
2. Waits for the first JSON-RPC frame:
   - `tesseron/hello` → creates a new **Session**: mints `claimCode`/`sessionId`/`resumeToken`, writes `~/.tesseron/instances/<instanceId>.json` (a v2 manifest with `helloHandledByHost: true` + `hostMintedClaim`), synthesizes the welcome locally so the SDK sees the claim code instantly.
   - `tesseron/resume` → looks the sessionId up in the in-memory Session map; on a token match, re-attaches the new browser WS to the existing Session and synthesizes the resume response (rotated token, no claim code). On a miss, returns `ResumeFailed` so the SDK falls back to a fresh hello.
3. Waits for the gateway to dial the per-tab URL with the `tesseron-gateway` + `tesseron-bind.<code>` subprotocols. On bind, replays the cached hello to the gateway and bridges frames in both directions, buffering browser → gateway traffic if the browser starts talking before the gateway dials in. Text frames stay text, binary frames stay binary — the bridge preserves the frame type so the browser SDK isn't fed binary blobs that it would silently drop.

### Sessions span browser refreshes

A **Session** is keyed by `sessionId`, not by browser WebSocket. The browser WS can detach (refresh, tab close, network blip) and reattach via `tesseron/resume` without disturbing the gateway-side bridge — the agent keeps the same `sessionId` and stays paired without the user retyping the claim code. The plugin keeps the Session in memory across the detach window; if no resume arrives within `sessionIdleTtlMs` (default 4 hours), the Session is destroyed and the gateway-side WS closes.

One tab → one Session → one manifest → one gateway connection. Multiple tabs coexist cleanly, each with its own Session.

## Install

```bash
pnpm add -D @tesseron/vite
```

Peer: `vite >= 4`. No runtime dependencies on your framework plugin.

## Register

```ts title="vite.config.ts"
import { defineConfig } from 'vite';
import { tesseron } from '@tesseron/vite';

export default defineConfig({
  plugins: [
    // ...your framework plugin (vue(), svelte(), react(), etc.)
    tesseron(),
  ],
});
```

With your framework plugin:

```ts title="vite.config.ts (Vue)"
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { tesseron } from '@tesseron/vite';

export default defineConfig({
  plugins: [vue(), tesseron({ appName: 'vue-todo' })],
});
```

## Options

```ts
tesseron({
  appName: 'my-app',          // Optional. Written into the instance manifest so the
                              // gateway log names your app usefully. Defaults to the
                              // Vite project directory name.
  sessionIdleTtlMs: 4 * 60 * 60 * 1000,
                              // Optional. How long a Session is held in memory after
                              // its browser WS detaches (refresh, tab close). A new
                              // browser WS arriving within this window with a valid
                              // `tesseron/resume` re-attaches to the same Session
                              // and the gateway-side bridge sees no disconnect.
                              // Default 4 h, matching @tesseron/mcp's resumeTtlMs.
                              // Set 0 to tear down sessions immediately on browser
                              // close (disables cross-refresh resume).
});
```

That's the whole API surface — ports, paths, and subprotocols are wire-level details.

## How the browser reaches it

The client-side `@tesseron/web` defaults to `<location.origin>/@tesseron/ws`, so no URL config is needed in your app code:

```ts
import { tesseron } from '@tesseron/web';
tesseron.app({ id: 'shop', name: 'Shop' });
// ...declare actions...
await tesseron.connect();   // dials ws://localhost:5173/@tesseron/ws
```

If your Vite server runs on a non-default port (e.g. `5175`), `location.origin` already reflects that - the connection still lands on the plugin.

## Multiple tabs

Each browser tab gets its own `instanceId`, its own manifest, and its own gateway connection. Session claiming is per-tab - open three tabs of the same app and you get three claim codes, each independent.

## Production builds

The plugin only runs under `vite dev`. Production builds (`vite build`) don't serve WebSocket endpoints, so a static `dist/` deployed to a CDN won't have `/@tesseron/ws` available.

For production Tesseron use with a browser SPA, you need a host process. Options:

- **Electron / Tauri** - the native shell can run `@tesseron/server` in its main process and route `/@tesseron/ws` requests to it from the renderer.
- **A custom reverse proxy in front of your SPA** that terminates `/@tesseron/ws` and bridges to a Node process running `@tesseron/server`.
- **A separate Node service** that uses `@tesseron/server` if your prod topology already has one.

The Vite plugin is strictly for dev-time workflows.

## What it doesn't do

- **Not a framework adapter.** You still import from `@tesseron/web` / `@tesseron/react` / `@tesseron/svelte` / `@tesseron/vue` for the declarative API.
- **Not a bundler plugin.** It only runs `configureServer`; no build-time transforms.
- **Not a production tool.** See above.

## Writing your own bridge

If you use a dev server other than Vite (webpack-dev-server, Rsbuild, Next.js dev, a custom Express-based HMR setup), the same pattern works:

1. On WebSocket upgrade at `/@tesseron/ws` — accept the browser. Defer minting until you see the first JSON-RPC frame.
2. On `tesseron/hello`, allocate a Session (mint `claimCode`, `sessionId`, `resumeToken`), write `~/.tesseron/instances/<instanceId>.json` with `{ version: 2, instanceId, appName, addedAt, helloHandledByHost: true, hostMintedClaim: {...}, transport: { kind: 'ws', url } }` where `url` points at a tab-specific path like `/@tesseron/ws/<instanceId>`. Synthesize the welcome locally so the SDK sees the claim code immediately.
3. On `tesseron/resume`, look up the sessionId in your in-memory Session map. On a token match, attach the new browser WS to the existing Session and synthesize the resume response (rotated token, no claim code); on a miss, return `ResumeFailed`.
4. On WebSocket upgrade at the per-tab path with subprotocols `tesseron-gateway` + `tesseron-bind.<code>` — accept the gateway, validate the bind code in constant time, replay the cached hello, and relay frames between the two sockets. Preserve text/binary frame types.
5. On browser-WS close, keep the Session alive for the idle TTL; on idle-TTL expiry or gateway-WS close, destroy the Session and delete the manifest.

`@tesseron/vite`'s source is the reference; adapt it to whatever dev server you run.
