import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  type ActionAnnotations,
  type ActionContext,
  type ResumeCredentials,
  TesseronError,
  TesseronErrorCode,
  type ResumeStorage as WebResumeStorage,
  type WebTesseronClient,
  type WelcomeResult,
  tesseron,
} from '@tesseron/web';
import { onDestroy, onMount } from 'svelte';
import { type Readable, writable } from 'svelte/store';

export * from '@tesseron/web';

/** Same shape as `import('@tesseron/web').ResumeStorage`. Re-imported under
 *  an internal alias because `export * from '@tesseron/web'` already re-
 *  exports the canonical name from this module — a same-name local import
 *  would collide (TS 2440). Consumers see `ResumeStorage` from
 *  `@tesseron/svelte` unchanged. */
type ResumeStorage = WebResumeStorage;

// ─── Action ─────────────────────────────────────────────────────────────────

/** Options for {@link tesseronAction}; mirrors the chained {@link ActionBuilder} methods as a single object. */
export interface TesseronActionOptions<I, O> {
  description?: string;
  input?: StandardSchemaV1<I>;
  inputJsonSchema?: unknown;
  output?: StandardSchemaV1<O>;
  outputJsonSchema?: unknown;
  annotations?: ActionAnnotations;
  timeoutMs?: number;
  strictOutput?: boolean;
  handler: (input: I, ctx: ActionContext) => Promise<O> | O;
}

/**
 * Registers a Tesseron action for the lifetime of the calling component. The
 * action is removed on component destroy. Call during component initialisation
 * (top-level `<script>` block).
 *
 * Handlers that close over Svelte `$state` variables always read the current
 * value at invocation time — no extra indirection required.
 *
 * @example
 * ```svelte
 * <script>
 *   import { tesseronAction } from '@tesseron/svelte';
 *   import { z } from 'zod';
 *
 *   let todos = $state([]);
 *
 *   tesseronAction('addTodo', {
 *     input: z.object({ text: z.string() }),
 *     handler: ({ text }) => { todos = [...todos, text]; },
 *   });
 * </script>
 * ```
 */
export function tesseronAction<I = unknown, O = unknown>(
  name: string,
  options: TesseronActionOptions<I, O>,
  client: WebTesseronClient = tesseron,
): void {
  // Box holds the latest options so the registered handler always delegates
  // to whatever was most recently passed, matching React's useRef pattern.
  const box = { options };

  let builder = client.action<I, O>(name);
  const o = options;
  if (o.description) builder = builder.describe(o.description);
  if (o.input) builder = builder.input(o.input, o.inputJsonSchema);
  if (o.output) builder = builder.output(o.output, o.outputJsonSchema);
  if (o.annotations) builder = builder.annotate(o.annotations);
  if (o.timeoutMs) builder = builder.timeout({ ms: o.timeoutMs });
  if (o.strictOutput) builder = builder.strictOutput();
  builder.handler((input, ctx) => box.options.handler(input, ctx));

  onDestroy(() => client.removeAction(name));
}

// ─── Resource ────────────────────────────────────────────────────────────────

/** Options for {@link tesseronResource}. Pass `read`, `subscribe`, or both. */
export interface TesseronResourceOptions<T> {
  description?: string;
  output?: StandardSchemaV1<T>;
  outputJsonSchema?: unknown;
  read?: () => T | Promise<T>;
  subscribe?: (emit: (value: T) => void) => () => void;
}

/**
 * Registers a Tesseron resource for the lifetime of the calling component.
 * The shorthand form (passing a reader function directly) is equivalent to
 * `{ read }`. The resource is removed on component destroy.
 *
 * @example
 * ```svelte
 * <script>
 *   import { tesseronResource } from '@tesseron/svelte';
 *
 *   let todos = $state([]);
 *
 *   // Shorthand: read-only resource
 *   tesseronResource('todoCount', () => todos.length);
 *
 *   // With subscribe: pushed to the agent on every change
 *   const countSubs = new Set();
 *   $effect(() => { const n = todos.length; countSubs.forEach(fn => fn(n)); });
 *   tesseronResource('todoCount', {
 *     read: () => todos.length,
 *     subscribe: (emit) => { countSubs.add(emit); return () => countSubs.delete(emit); },
 *   });
 * </script>
 * ```
 */
export function tesseronResource<T = unknown>(
  name: string,
  optionsOrReader: TesseronResourceOptions<T> | (() => T | Promise<T>),
  client: WebTesseronClient = tesseron,
): void {
  const options: TesseronResourceOptions<T> =
    typeof optionsOrReader === 'function' ? { read: optionsOrReader } : optionsOrReader;
  const box = { options };

  let builder = client.resource<T>(name);
  const o = options;
  if (o.description) builder = builder.describe(o.description);
  if (o.output) builder = builder.output(o.output, o.outputJsonSchema);
  if (o.read) {
    const initial = o.read;
    builder = builder.read(() => (box.options.read ?? initial)());
  }
  if (o.subscribe) {
    const initial = o.subscribe;
    builder = builder.subscribe((emit) => (box.options.subscribe ?? initial)(emit));
  }

  onDestroy(() => client.removeResource(name));
}

// ─── Connection ──────────────────────────────────────────────────────────────

/** Options for {@link tesseronConnection}. */
export interface TesseronConnectionOptions {
  /** Gateway URL; defaults to `DEFAULT_GATEWAY_URL` (the local bridge). */
  url?: string;
  /** Set to `false` to skip connecting (useful for gating behind auth). Defaults to `true`. */
  enabled?: boolean;
  /**
   * Persist `{ sessionId, resumeToken }` so the store can rejoin an existing
   * claimed session via `tesseron/resume` after the transport drops (page
   * refresh, HMR reload, brief network blip) instead of issuing a new claim
   * code. Mirrors `@tesseron/react`'s `useTesseronConnection.resume`.
   *
   * - `true` / omitted *(default)*: persist in `localStorage` under
   *   `'tesseron:resume'`. Refreshes inside the host idle TTL window keep
   *   the same session — no re-claim required.
   * - `false`: no persistence. Every connect is a fresh hello.
   * - `string`: persist in `localStorage` under that exact key.
   * - {@link ResumeStorage}: custom backend (`load` / `save` / `clear`,
   *   sync or async). Use when `localStorage` is unavailable.
   *
   * On `TesseronError(ResumeFailed)`, the store clears the stored
   * credentials, falls back to a fresh `tesseron/hello`, and surfaces
   * `resumeStatus: 'failed'`.
   */
  resume?: boolean | string | ResumeStorage;
}

/**
 * Outcome of the resume attempt that produced the current connection.
 * - `'none'`     — no resume was attempted.
 * - `'resumed'`  — `tesseron/resume` succeeded.
 * - `'failed'`   — resume was attempted but rejected; fell back to a fresh hello.
 */
export type TesseronResumeStatus = 'none' | 'resumed' | 'failed';

/** Reactive connection state held in the store returned by {@link tesseronConnection}. */
export interface TesseronConnectionState {
  status: 'idle' | 'connecting' | 'open' | 'error' | 'closed';
  welcome?: WelcomeResult;
  /** Claim code to display so the user can paste it into their MCP client.
   *  Cleared in-place when the gateway sends `tesseron/claimed` — UIs that
   *  show this field disappear once an agent attaches. */
  claimCode?: string;
  error?: Error;
  /** Set when `status === 'open'`. See {@link TesseronResumeStatus}. */
  resumeStatus?: TesseronResumeStatus;
}

const DEFAULT_RESUME_STORAGE_KEY = 'tesseron:resume';

function localStorageResumeBackend(key: string): ResumeStorage {
  return {
    load: () => {
      if (typeof window === 'undefined') return null;
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const obj = parsed as Record<string, unknown>;
          if (typeof obj['sessionId'] === 'string' && typeof obj['resumeToken'] === 'string') {
            return { sessionId: obj['sessionId'], resumeToken: obj['resumeToken'] };
          }
        }
        return null;
      } catch {
        return null;
      }
    },
    save: (creds) => {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(key, JSON.stringify(creds));
      } catch {
        // Quota exceeded / storage disabled — non-fatal.
      }
    },
    clear: () => {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.removeItem(key);
      } catch {
        // see save()
      }
    },
  };
}

function resolveResumeStorage(option: TesseronConnectionOptions['resume']): ResumeStorage | null {
  if (option === undefined || option === true) {
    return localStorageResumeBackend(DEFAULT_RESUME_STORAGE_KEY);
  }
  if (option === false) return null;
  if (typeof option === 'string') return localStorageResumeBackend(option);
  return option;
}

/**
 * Connects the shared {@link WebTesseronClient} singleton on mount and returns
 * a Svelte `Readable` store holding the current connection state. Subscribe
 * with the `$` prefix in templates.
 *
 * Register your actions and resources with {@link tesseronAction} /
 * {@link tesseronResource} before calling this so they appear in the initial
 * `tesseron/hello` manifest.
 *
 * Resume is on by default: a page refresh inside the host's idle TTL window
 * keeps the same Tesseron session paired with the agent — no re-claim
 * needed. Pass `resume: false` to opt out.
 *
 * @example
 * ```svelte
 * <script>
 *   import { tesseronConnection } from '@tesseron/svelte';
 *
 *   tesseron.app({ id: 'my_app', name: 'My App' });
 *   // ...register actions and resources first...
 *   const connection = tesseronConnection();
 * </script>
 *
 * {#if $connection.claimCode}
 *   <p>Claim code: <code>{$connection.claimCode}</code></p>
 * {/if}
 * ```
 */
export function tesseronConnection(
  options: TesseronConnectionOptions = {},
  client: WebTesseronClient = tesseron,
): Readable<TesseronConnectionState> {
  const { subscribe, set, update } = writable<TesseronConnectionState>({ status: 'idle' });

  onMount(() => {
    if (options.enabled === false) return;
    let cancelled = false;
    set({ status: 'connecting' });

    const storage = resolveResumeStorage(options.resume);

    const run = async (): Promise<void> => {
      let saved: ResumeCredentials | null = null;
      if (storage) {
        try {
          saved = (await storage.load()) ?? null;
        } catch {
          saved = null;
        }
      }

      let welcome: WelcomeResult;
      let resumeStatus: TesseronResumeStatus = 'none';
      try {
        welcome = await client.connect(options.url, { resume: saved ?? false });
        if (saved) resumeStatus = 'resumed';
      } catch (err) {
        if (saved && err instanceof TesseronError && err.code === TesseronErrorCode.ResumeFailed) {
          if (storage) {
            try {
              await storage.clear();
            } catch {
              // see localStorageResumeBackend().clear()
            }
          }
          if (cancelled) return;
          welcome = await client.connect(options.url, { resume: false });
          resumeStatus = 'failed';
        } else {
          throw err;
        }
      }

      if (cancelled) return;
      if (storage && welcome.resumeToken) {
        try {
          await storage.save({
            sessionId: welcome.sessionId,
            resumeToken: welcome.resumeToken,
          });
        } catch {
          // see localStorageResumeBackend().save()
        }
      }
      if (cancelled) return;
      set({
        status: 'open',
        welcome,
        claimCode: welcome.claimCode,
        resumeStatus,
      });
    };

    run().catch((error: unknown) => {
      if (cancelled) return;
      set({
        status: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });

    // Subscribe to welcome mutations (`tesseron/claimed` and any future
    // welcome-mutating notifications) so a UI that branches on
    // `connection.claimCode` clears the claim code automatically once the
    // agent attaches. Without this the claim code stays rendered forever.
    const unsubscribeWelcome = client.onWelcomeChange((w) => {
      if (cancelled) return;
      update((prev) => {
        if (prev.status !== 'open') return prev;
        return { ...prev, welcome: w, claimCode: w.claimCode };
      });
    });

    return () => {
      cancelled = true;
      unsubscribeWelcome();
    };
  });

  return { subscribe };
}
