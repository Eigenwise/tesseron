---
title: "@tesseron/vue"
description: Vue 3 adapter. Composition-API bindings for actions, resources, and the connection state ref.
related:
  - sdk/typescript/web
  - sdk/typescript/vite
  - sdk/typescript/action-builder
---

`@tesseron/vue` wraps `@tesseron/web` with Vue 3 Composition API lifecycle plumbing: actions and resources register on `onMounted`, deregister on `onUnmounted`; the connection status is a `Ref` that auto-unwraps in templates.

Vue 3.0+, Composition API. Script-setup or `setup()` return - either works.

## Install

```bash
pnpm add @tesseron/vue zod
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
} from '@tesseron/vue';
```

### `tesseronAction(name, options)`

Registers an action for the lifetime of the component. Same shape as the builder API, passed as an object:

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { tesseronAction } from '@tesseron/vue';
import { z } from 'zod';

const todos = ref<string[]>([]);

tesseronAction('addTodo', {
  input: z.object({ text: z.string() }),
  handler: ({ text }) => {
    todos.value = [...todos.value, text];
  },
});
</script>
```

Options: `description`, `input`, `inputJsonSchema`, `output`, `outputJsonSchema`, `annotations`, `timeoutMs`, `strictOutput`, `handler`. The handler closes over `ref` / `computed` values and reads the current value at invocation time.

### `tesseronResource(name, optionsOrReader)`

Registers a resource. Pass a reader function for the shorthand, or an options object if you also want `subscribe`, `description`, or an output schema:

```vue
<script setup lang="ts">
import { ref, watch } from 'vue';
import { tesseronResource } from '@tesseron/vue';

const todos = ref<Todo[]>([]);

// Read-only
tesseronResource('todoCount', () => todos.value.length);

// Read + subscribe
const subs = new Set<(n: number) => void>();
watch(() => todos.value.length, (n) => subs.forEach(fn => fn(n)));

tesseronResource('todoCount', {
  read: () => todos.value.length,
  subscribe: (emit) => { subs.add(emit); return () => subs.delete(emit); },
});
</script>
```

### `tesseronConnection(options?)`

Opens the connection on mount and returns a `Ref<TesseronConnectionState>`:

```vue
<script setup lang="ts">
import { tesseron, tesseronConnection } from '@tesseron/vue';

tesseron.app({ id: 'my_app', name: 'My App' });
// ...tesseronAction / tesseronResource calls register before the connection...
const connection = tesseronConnection();
</script>

<template>
  <p v-if="connection.claimCode">
    Claim code: <code>{{ connection.claimCode }}</code>
  </p>
</template>
```

Templates auto-unwrap refs, so `connection.status` works directly. Outside templates use `connection.value.status`.

`connection.claimCode` clears reactively when the agent claims the session — the composable subscribes to `client.onWelcomeChange` and patches the ref on `tesseron/claimed`, so a `v-if` on `claimCode` hides automatically.

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

`resume` defaults to `true` — the composable persists `{ sessionId, resumeToken }` to `localStorage` under `'tesseron:resume'` and replays it on the next mount via `tesseron/resume`. Refresh inside the [host idle TTL window](/sdk/typescript/vite/#sessions-span-browser-refreshes) (default 4 hours) keeps the same Tesseron session paired with the agent — no claim code re-entry needed.

| Form | Behaviour |
|---|---|
| `true` *(default)* | Persist in `localStorage` under `'tesseron:resume'`. |
| `false` | No persistence. Every connect is a fresh hello. |
| `string` | Persist in `localStorage` under that exact key. |
| `ResumeStorage` | Custom `{ load, save, clear }` callbacks (sync or async). |

`connection.resumeStatus` (set when `status === 'open'`) reports `'resumed'` after a successful resume, `'failed'` after a rejected resume + fallback to fresh hello, or `'none'` otherwise. See [Session resume](/protocol/resume/) for the protocol-level semantics.

## Why an adapter at all

`@tesseron/web` by itself works fine in Vue; you can call `tesseron.action(...)` and `tesseron.connect()` at module scope. The adapter is a convenience when you want:

- **Lifecycle scoping** - actions registered in a `<script setup>` get torn down when the component unmounts.
- **Reactive connection status** - `connection.status` in templates without manual `ref` plumbing.
- **Latest-value closures** - the handler always sees the current `ref.value` without re-registration.

If none of that matters, stick with `@tesseron/web`.
