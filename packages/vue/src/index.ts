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
import { type Ref, onMounted, onUnmounted, ref } from 'vue';

export * from '@tesseron/web';

/** Same shape as `import('@tesseron/web').ResumeStorage`. Re-imported under
 *  an internal alias because `export * from '@tesseron/web'` already
 *  re-exports the canonical name from this module — a same-name local
 *  import would collide (TS 2440). Consumers see `ResumeStorage` from
 *  `@tesseron/vue` unchanged. */
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
 * action is removed on unmount. Call inside `<script setup>` or `setup()`.
 *
 * Handlers that close over Vue `ref`/`reactive` values always read the current
 * `.value` at invocation time — no extra indirection required.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { tesseronAction } from '@tesseron/vue';
 * import { ref } from 'vue';
 * import { z } from 'zod';
 *
 * const todos = ref([]);
 *
 * tesseronAction('addTodo', {
 *   input: z.object({ text: z.string() }),
 *   handler: ({ text }) => { todos.value = [...todos.value, text]; },
 * });
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

  onUnmounted(() => client.removeAction(name));
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
 * `{ read }`. The resource is removed on unmount.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { tesseronResource } from '@tesseron/vue';
 * import { ref } from 'vue';
 *
 * const todos = ref([]);
 *
 * // Shorthand: read-only resource
 * tesseronResource('todoCount', () => todos.value.length);
 *
 * // With subscribe: pushed to the agent on every change
 * const countSubs = new Set();
 * watch(() => todos.value.length, (n) => countSubs.forEach(fn => fn(n)));
 * tesseronResource('todoCount', {
 *   read: () => todos.value.length,
 *   subscribe: (emit) => { countSubs.add(emit); return () => countSubs.delete(emit); },
 * });
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

  onUnmounted(() => client.removeResource(name));
}

// ─── Connection ──────────────────────────────────────────────────────────────

/** Options for {@link tesseronConnection}. */
export interface TesseronConnectionOptions {
  /** Gateway URL; defaults to `DEFAULT_GATEWAY_URL` (the local bridge). */
  url?: string;
  /** Set to `false` to skip connecting (useful for gating behind auth). Defaults to `true`. */
  enabled?: boolean;
  /**
   * Persist `{ sessionId, resumeToken }` so the composable can rejoin an
   * existing claimed session via `tesseron/resume` after the transport drops
   * (page refresh, HMR reload, brief network blip) instead of issuing a new
   * claim code. Mirrors `@tesseron/react`'s `useTesseronConnection.resume`.
   *
   * - `true` / omitted *(default)*: persist in `localStorage` under
   *   `'tesseron:resume'`. Refreshes inside the host idle TTL window keep
   *   the same session — no re-claim required.
   * - `false`: no persistence. Every connect is a fresh hello.
   * - `string`: persist in `localStorage` under that exact key. Use a per-app
   *   value when you mount multiple Tesseron clients on one page.
   * - {@link ResumeStorage}: custom `{ load, save, clear }` callbacks (sync or
   *   async). Use when `localStorage` is not available (Electron with strict
   *   CSP, an iframe partition, the OS keychain).
   *
   * On `TesseronError(ResumeFailed)`, the composable clears the stored
   * credentials, falls back to a fresh `tesseron/hello`, and surfaces
   * `resumeStatus: 'failed'`. The freshest token is always persisted.
   */
  resume?: boolean | string | ResumeStorage;
}

/**
 * Outcome of the resume attempt that produced the current connection.
 * - `'none'`     — no resume was attempted (no stored creds OR `resume: false`).
 * - `'resumed'`  — `tesseron/resume` succeeded; the previous session was reattached.
 * - `'failed'`   — resume was attempted but rejected; the composable fell back to a fresh `tesseron/hello`.
 */
export type TesseronResumeStatus = 'none' | 'resumed' | 'failed';

/** Reactive connection state held in the ref returned by {@link tesseronConnection}. */
export interface TesseronConnectionState {
  status: 'idle' | 'connecting' | 'open' | 'error' | 'closed';
  welcome?: WelcomeResult;
  /**
   * Claim code to display so the user can paste it into their MCP client.
   * Present only on a fresh `tesseron/hello`; absent after a successful resume.
   * Cleared in-place when the gateway sends `tesseron/claimed` so UIs that
   * show this field disappear once an agent attaches.
   */
  claimCode?: string;
  error?: Error;
  /**
   * Set when `status === 'open'`. See {@link TesseronResumeStatus}.
   */
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
  // Default behaviour: persist via localStorage. Refreshes stop costing the
  // user a fresh claim code on every reconnect.
  if (option === undefined || option === true) {
    return localStorageResumeBackend(DEFAULT_RESUME_STORAGE_KEY);
  }
  if (option === false) return null;
  if (typeof option === 'string') return localStorageResumeBackend(option);
  return option;
}

/**
 * Connects the shared {@link WebTesseronClient} singleton on mount and returns
 * a `Ref` holding the current connection state. In templates the ref is
 * auto-unwrapped — access `connection.status` directly. In `<script setup>`
 * use `connection.value.status`.
 *
 * Register your actions and resources with {@link tesseronAction} /
 * {@link tesseronResource} before calling this so they appear in the initial
 * `tesseron/hello` manifest.
 *
 * Resume is on by default: a page refresh inside the host's idle TTL window
 * keeps the same Tesseron session paired with the agent — no re-claim needed.
 * Pass `resume: false` to opt out (incognito-style flows).
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { tesseronConnection } from '@tesseron/vue';
 *
 * tesseron.app({ id: 'my_app', name: 'My App' });
 * // ...register actions and resources first...
 * const connection = tesseronConnection();
 * </script>
 *
 * <template>
 *   <p v-if="connection.claimCode">
 *     Claim code: <code>{{ connection.claimCode }}</code>
 *   </p>
 * </template>
 * ```
 */
export function tesseronConnection(
  options: TesseronConnectionOptions = {},
  client: WebTesseronClient = tesseron,
): Ref<TesseronConnectionState> {
  const state = ref<TesseronConnectionState>({ status: 'idle' });
  let cancelled = false;
  let unsubscribeWelcome: (() => void) | undefined;

  onMounted(() => {
    if (options.enabled === false) return;
    cancelled = false;
    state.value = { status: 'connecting' };

    const storage = resolveResumeStorage(options.resume);

    const run = async (): Promise<void> => {
      let saved: ResumeCredentials | null = null;
      if (storage) {
        try {
          saved = (await storage.load()) ?? null;
        } catch {
          // Storage failures are non-fatal — proceed to fresh hello.
          saved = null;
        }
      }

      // Pass an explicit resume value so the underlying web SDK's own auto-
      // persist layer doesn't double-write under this composable's storage
      // key — the composable owns load/save/clear here and surfaces
      // `resumeStatus` reactively, which the SDK's storage layer doesn't.
      let welcome: WelcomeResult;
      let resumeStatus: TesseronResumeStatus = 'none';
      try {
        welcome = await client.connect(options.url, { resume: saved ?? false });
        if (saved) resumeStatus = 'resumed';
      } catch (err) {
        if (saved && err instanceof TesseronError && err.code === TesseronErrorCode.ResumeFailed) {
          // Stored creds are stale (TTL elapsed, host destroyed Session, token
          // rotated by another tab). Best-effort clear and start fresh.
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
      state.value = {
        status: 'open',
        welcome,
        claimCode: welcome.claimCode,
        resumeStatus,
      };
    };

    run().catch((error: unknown) => {
      if (cancelled) return;
      state.value = {
        status: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    });

    // React to `tesseron/claimed` and any future welcome-mutating notifications
    // so a UI that branches on `connection.claimCode` clears the claim code
    // automatically once the agent attaches. Without this, the claim code
    // stays rendered indefinitely after the user has typed it.
    unsubscribeWelcome = client.onWelcomeChange((welcome) => {
      if (cancelled) return;
      if (state.value.status !== 'open') return;
      state.value = { ...state.value, welcome, claimCode: welcome.claimCode };
    });
  });

  onUnmounted(() => {
    cancelled = true;
    if (unsubscribeWelcome) {
      unsubscribeWelcome();
      unsubscribeWelcome = undefined;
    }
  });

  return state;
}
