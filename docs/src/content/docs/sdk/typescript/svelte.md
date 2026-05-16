---
title: "@tesseron/svelte"
description: Svelte adapter. Lifecycle-scoped action and resource registration, reactive connection store.
related:
  - sdk/typescript/web
  - sdk/typescript/vite
  - sdk/typescript/action-builder
---

`@tesseron/svelte` wraps `@tesseron/web` with Svelte lifecycle plumbing: actions and resources register on component mount, deregister on destroy; the connection status is a `Readable` store you subscribe to with `$connection` in templates.

Works with Svelte 4 and Svelte 5. Uses `onMount` / `onDestroy` / `writable` - no rune syntax, so the package ships as normal JS and doesn't need the Svelte compiler to build.

## Install

```bash
pnpm add @tesseron/svelte zod
pnpm add -D @tesseron/vite
```

Then register the [Vite plugin](/sdk/typescript/vite/) in your `vite.config.ts`.

## API

Three exports. The full `@tesseron/web` surface is re-exported too.

```ts
import {
  tesseronAction,
  tesseronResource,
  tesseronConnection,
} from '@tesseron/svelte';
```

### `tesseronAction(name, options)`

Registers an action for the lifetime of the component. Same shape as the builder API, passed as an object:

```svelte
<script lang="ts">
  import { tesseronAction } from '@tesseron/svelte';
  import { z } from 'zod';

  let todos = $state<string[]>([]);

  tesseronAction('addTodo', {
    input: z.object({ text: z.string() }),
    handler: ({ text }) => {
      todos = [...todos, text];
    },
  });
</script>
```

Options: `description`, `input`, `inputJsonSchema`, `output`, `outputJsonSchema`, `annotations`, `timeoutMs`, `strictOutput`, `handler`. The handler closes over `$state` / `$derived` variables and reads the current value at invocation time - no `$bindable` required.

### `tesseronResource(name, optionsOrReader)`

Registers a resource. Pass a reader function for the shorthand, or an options object if you also want `subscribe`, `description`, or an output schema:

```svelte
<script lang="ts">
  import { tesseronResource } from '@tesseron/svelte';

  let todos = $state<Todo[]>([]);

  // Read-only
  tesseronResource('todoCount', () => todos.length);

  // Read + subscribe
  const subs = new Set<(n: number) => void>();
  $effect(() => { const n = todos.length; subs.forEach(fn => fn(n)); });

  tesseronResource('todoCount', {
    read: () => todos.length,
    subscribe: (emit) => { subs.add(emit); return () => subs.delete(emit); },
  });
</script>
```

### `tesseronConnection(options?)`

Opens the connection on mount and returns a `Readable<TesseronConnectionState>`:

```svelte
<script lang="ts">
  import { tesseron, tesseronConnection } from '@tesseron/svelte';

  tesseron.app({ id: 'my_app', name: 'My App' });
  // ...tesseronAction / tesseronResource calls register before the connection...
  const connection = tesseronConnection();
</script>

{#if $connection.claimCode}
  <p>Claim code: <code>{$connection.claimCode}</code></p>
{/if}
```

`$connection.claimCode` clears reactively when the agent claims the session — the store subscribes to `client.onWelcomeChange` and patches the state on `tesseron/claimed`, so a template that branches on `claimCode` hides automatically without any extra logic.

`TesseronConnectionState`:

```ts
interface TesseronConnectionState {
  status: 'idle' | 'connecting' | 'open' | 'error' | 'closed';
  welcome?: WelcomeResult;
  claimCode?: string;
  error?: Error;
  resumeStatus?: 'none' | 'resumed' | 'failed';
}
```

Options:

```ts
interface TesseronConnectionOptions {
  url?: string;       // gateway URL; defaults to /@tesseron/ws
  enabled?: boolean;  // false → skip connecting (e.g. behind an auth gate)
  resume?: boolean | string | ResumeStorage; // default true
}
```

#### `resume` — survive page refresh / HMR

`resume` defaults to `true` — the store persists `{ sessionId, resumeToken }` to `localStorage` under `'tesseron:resume'` and replays it on the next mount via `tesseron/resume`. Refresh inside the [host idle TTL window](/sdk/typescript/vite/#sessions-span-browser-refreshes) (default 4 hours) keeps the same Tesseron session paired with the agent — no claim code re-entry needed.

| Form | Behaviour |
|---|---|
| `true` *(default)* | Persist in `localStorage` under `'tesseron:resume'`. |
| `false` | No persistence. Every connect is a fresh hello. |
| `string` | Persist in `localStorage` under that exact key. |
| `ResumeStorage` | Custom `{ load, save, clear }` callbacks (sync or async). |

`$connection.resumeStatus` (set when `status === 'open'`) reports `'resumed'` after a successful resume, `'failed'` after a rejected resume + fallback to fresh hello, or `'none'` otherwise. See [Session resume](/protocol/resume/) for the protocol-level semantics.

## Why an adapter at all

`@tesseron/web` by itself works fine in Svelte; you can call `tesseron.action(...)` and `tesseron.connect()` at module scope. The adapter is a convenience when you want:

- **Lifecycle scoping** - actions registered in a `+page.svelte` get torn down when the user navigates away.
- **Reactive connection status** - `$connection.status` in templates without manual store plumbing.
- **Latest-value closures** - the handler always sees the current `$state` without re-registration.

If none of that matters, stick with `@tesseron/web`.
