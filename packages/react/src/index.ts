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
import { useEffect, useRef, useState } from 'react';

export * from '@tesseron/web';

/**
 * Alias of {@link import('@tesseron/web').ResumeStorage}. Imported locally
 * with a different name because `export * from '@tesseron/web'` already
 * re-exports the public name from this module, and a same-name local import
 * would collide (TS 2440). Consumers should still see the canonical
 * `ResumeStorage` from `@tesseron/react`.
 */
type ResumeStorage = WebResumeStorage;

/** Options for {@link useTesseronAction}; mirrors the chained {@link ActionBuilder} methods as a single object. */
export interface UseTesseronActionOptions<I, O> {
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
 * action is removed on unmount. `options.handler` is held in a ref so the
 * registration does not re-run when you close over new state — just pass the
 * latest handler each render.
 *
 * @example
 * ```tsx
 * useTesseronAction('addTodo', {
 *   input: z.object({ text: z.string() }),
 *   handler: ({ text }) => setTodos((t) => [...t, text]),
 * });
 * ```
 */
export function useTesseronAction<I = unknown, O = unknown>(
  name: string,
  options: UseTesseronActionOptions<I, O>,
  client: WebTesseronClient = tesseron,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let builder = client.action<I, O>(name);
    const o = optionsRef.current;
    if (o.description) builder = builder.describe(o.description);
    if (o.input) builder = builder.input(o.input, o.inputJsonSchema);
    if (o.output) builder = builder.output(o.output, o.outputJsonSchema);
    if (o.annotations) builder = builder.annotate(o.annotations);
    if (o.timeoutMs) builder = builder.timeout({ ms: o.timeoutMs });
    if (o.strictOutput) builder = builder.strictOutput();
    builder.handler((input, ctx) => optionsRef.current.handler(input, ctx));
    return () => {
      client.removeAction(name);
    };
  }, [name, client]);
}

/** Options for {@link useTesseronResource}. Pass either `read`, `subscribe`, or both. */
export interface UseTesseronResourceOptions<T> {
  description?: string;
  output?: StandardSchemaV1<T>;
  outputJsonSchema?: unknown;
  read?: () => T | Promise<T>;
  subscribe?: (emit: (value: T) => void) => () => void;
}

/**
 * Registers a Tesseron resource for the lifetime of the calling component.
 * The shorthand form (passing a reader function) is equivalent to `{ read }`.
 * Current-value closures are held in a ref so stale reads are avoided without
 * re-registering the resource each render.
 *
 * @example
 * ```tsx
 * useTesseronResource('todoCount', () => todos.length);
 * ```
 */
export function useTesseronResource<T = unknown>(
  name: string,
  optionsOrReader: UseTesseronResourceOptions<T> | (() => T | Promise<T>),
  client: WebTesseronClient = tesseron,
): void {
  const options: UseTesseronResourceOptions<T> =
    typeof optionsOrReader === 'function' ? { read: optionsOrReader } : optionsOrReader;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let builder = client.resource<T>(name);
    const o = optionsRef.current;
    if (o.description) builder = builder.describe(o.description);
    if (o.output) builder = builder.output(o.output, o.outputJsonSchema);
    if (o.read) {
      const read = o.read;
      builder = builder.read(() => (optionsRef.current.read ?? read)());
    }
    if (o.subscribe) {
      const subscribe = o.subscribe;
      builder = builder.subscribe((emit) => (optionsRef.current.subscribe ?? subscribe)(emit));
    }
    return () => {
      client.removeResource(name);
    };
  }, [name, client]);
}

/** Options for {@link useTesseronConnection}. */
export interface UseTesseronConnectionOptions {
  /** Gateway URL; defaults to `DEFAULT_GATEWAY_URL` (the local bridge). */
  url?: string;
  /** Set to `false` to skip connecting (useful for gating behind auth). Defaults to `true`. */
  enabled?: boolean;
  /**
   * Persist `{ sessionId, resumeToken }` so the hook can rejoin an existing
   * claimed session via `tesseron/resume` after the transport drops (page
   * refresh, HMR reload, brief network blip) instead of issuing a new claim
   * code. See [protocol/resume](https://tesseron.dev/protocol/resume/).
   *
   * - `true` / omitted (default): persist in `localStorage` under
   *   `'tesseron:resume'`. This is the right answer for almost every app —
   *   refreshes and brief drops stop costing the user a fresh claim code.
   * - `false`: no persistence. Every connect is a fresh hello. Use for
   *   incognito-style flows that must not carry session state across reloads.
   * - `string`: persist in `localStorage` under that exact key. Use a per-app
   *   value when you have multiple `WebTesseronClient` instances per page.
   * - `ResumeStorage`: custom `{ load, save, clear }` callbacks. Useful when
   *   `localStorage` is not available (Electron renderer with strict CSP, an
   *   iframe partition, custom storage).
   *
   * On a `TesseronError(ResumeFailed)` (TTL expired, token rotated by another
   * tab, gateway restarted, session was never claimed), the hook clears the
   * stored credentials, falls back to a fresh `tesseron/hello`, and surfaces
   * `resumeStatus: 'failed'` in {@link TesseronConnectionState} so the UI can
   * react. Resume tokens rotate on every successful handshake (hello or
   * resume), and the hook always overwrites the stored value with the
   * freshest token.
   *
   * Note: resume only re-establishes the session, not its
   * `resources/subscribe` bindings. The {@link useTesseronResource} hook
   * re-registers subscriptions naturally on remount, so apps using the
   * provided hooks see no behavioral difference; if you wire subscriptions
   * by hand against the lower-level client, you must re-subscribe after
   * each connect.
   */
  resume?: boolean | string | ResumeStorage;
}

/**
 * Outcome of the resume attempt that produced the current connection.
 * - `'none'` - no resume was attempted (no stored creds or `resume` disabled).
 * - `'resumed'` - `tesseron/resume` succeeded; the session was reattached.
 * - `'failed'` - resume was attempted but the gateway rejected it; the hook
 *   transparently fell back to a fresh `tesseron/hello`. Useful for telemetry
 *   and for UIs that want to say "your previous session expired" rather than
 *   silently displaying a new claim code.
 */
export type TesseronResumeStatus = 'none' | 'resumed' | 'failed';

/**
 * Sentinel thrown when {@link useTesseronConnection}'s effect detects that
 * cleanup has already fired. The outer `run().catch` checks for this type
 * and skips `setState({ status: 'error' })` — without the sentinel a future
 * refactor that drops the redundant `cancelled` re-check could surface
 * "useTesseronConnection: cancelled" as a UI error string.
 *
 * Internal — not exported from the package.
 */
class CancelledError extends Error {
  constructor() {
    super('useTesseronConnection: effect cancelled before connect resolved');
    this.name = 'CancelledError';
  }
}

/** Reactive connection state returned from {@link useTesseronConnection}. */
export interface TesseronConnectionState {
  status: 'idle' | 'connecting' | 'open' | 'error' | 'closed';
  welcome?: WelcomeResult;
  /**
   * Claim code to display in the UI. Present only on a fresh `tesseron/hello`;
   * absent after a successful resume because the session was already claimed.
   */
  claimCode?: string;
  error?: Error;
  /**
   * Set when `status === 'open'`. Indicates whether the current session is a
   * resumed one, a fresh fallback after a failed resume, or a plain hello.
   * See {@link TesseronResumeStatus}.
   */
  resumeStatus?: TesseronResumeStatus;
}

const DEFAULT_RESUME_STORAGE_KEY = 'tesseron:resume';

function localStorageResumeBackend(key: string): ResumeStorage {
  return {
    load: () => {
      // SSR: no window, nothing to load.
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
        // Corrupted entry or localStorage access denied (private mode, etc.)
        // - treat as no saved session and let the hook do a fresh hello.
        return null;
      }
    },
    save: (creds) => {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(key, JSON.stringify(creds));
      } catch {
        // Quota exceeded or storage disabled - non-fatal; the session still
        // works for this page load, it just won't survive the next refresh.
      }
    },
    clear: () => {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Same as save: best-effort cleanup.
      }
    },
  };
}

function resolveResumeStorage(
  option: UseTesseronConnectionOptions['resume'],
): ResumeStorage | null {
  // Default behaviour: persist via localStorage. Refreshes and brief drops
  // stop costing the user a fresh claim code on every reconnect.
  if (option === undefined || option === true) {
    return localStorageResumeBackend(DEFAULT_RESUME_STORAGE_KEY);
  }
  if (option === false) return null;
  if (typeof option === 'string') return localStorageResumeBackend(option);
  return option;
}

/**
 * Connects the shared {@link WebTesseronClient} singleton on mount and exposes
 * the connection status (and claim code) for rendering. Register your actions
 * and resources with {@link useTesseronAction} / {@link useTesseronResource}
 * before this hook runs so they appear in the initial `tesseron/hello` manifest.
 *
 * Pass `options.resume` to survive page refresh / HMR reloads without losing
 * the claimed session - see {@link UseTesseronConnectionOptions.resume}.
 */
export function useTesseronConnection(
  options: UseTesseronConnectionOptions = {},
  client: WebTesseronClient = tesseron,
): TesseronConnectionState {
  const [state, setState] = useState<TesseronConnectionState>({ status: 'idle' });
  const enabled = options.enabled ?? true;
  const url = options.url;
  const resumeRef = useRef(options.resume);
  resumeRef.current = options.resume;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Defer transport ownership to {@link WebTesseronClient}'s URL-form
    // `connect()`. Under React 18 `StrictMode` (mount → cleanup → remount)
    // the second mount's `connect(url, options)` deduplicates against the
    // first mount's still-in-flight promise instead of opening a parallel
    // WebSocket and racing on `tesseron/resume`. The cleanup below just
    // marks this run as cancelled so its callbacks become no-ops; it
    // intentionally does NOT close the transport, because a remount that
    // dedups onto the same promise still needs the underlying socket
    // alive. See tesseron#88 (and tesseron#68 for the predecessor race
    // that owned-transport ownership tried to mitigate).
    setState({ status: 'connecting' });

    const storage = resolveResumeStorage(resumeRef.current);

    const run = async (): Promise<void> => {
      let saved: ResumeCredentials | null = null;
      if (storage) {
        try {
          saved = (await storage.load()) ?? null;
        } catch {
          // A throwing custom backend shouldn't break the connection; treat
          // as no saved creds and proceed to a fresh hello.
          saved = null;
        }
      }

      // URL-form `client.connect` is the de-dup path on the singleton:
      // same URL + same resume creds + concurrent calls → shared promise,
      // single socket. That's what fixes the StrictMode / HMR resume race
      // (tesseron#88).
      //
      // `resume: false` is passed explicitly when we have no saved creds (or
      // are recovering from a failed resume) so the web SDK's own auto-
      // persist layer stays out of the hook's storage: the hook owns load/
      // save/clear here and surfaces `resumeStatus` reactively, which the
      // web SDK's storage layer can't.
      let welcome: WelcomeResult;
      let resumeStatus: TesseronResumeStatus = 'none';
      try {
        welcome = await client.connect(url, { resume: saved ?? false });
        if (saved) resumeStatus = 'resumed';
      } catch (err) {
        if (saved && err instanceof TesseronError && err.code === TesseronErrorCode.ResumeFailed) {
          // Stored creds are stale (TTL elapsed, gateway restarted, session
          // never claimed, token already rotated by another tab). Best-effort
          // clear and start fresh; clear failures must not block the fallback.
          if (storage) {
            try {
              await storage.clear();
            } catch {
              // Cleanup is non-fatal - the next successful save() overwrites
              // the stale entry anyway.
            }
          }
          if (cancelled) return;
          welcome = await client.connect(url, { resume: false });
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
          // Persistence failure is non-fatal - the live session still works
          // for this page load; it just won't survive the next refresh.
        }
      }
      if (cancelled) return;
      setState({
        status: 'open',
        welcome,
        claimCode: welcome.claimCode,
        resumeStatus,
      });
    };

    run().catch((error: unknown) => {
      if (cancelled || error instanceof CancelledError) return;
      setState({
        status: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });

    // Subscribe to server-driven welcome updates. Currently only fires on
    // `tesseron/claimed` (which clears `claimCode` and updates `agent`),
    // but the API is generic so future welcome-mutating notifications get
    // surfaced for free. The unsubscribe runs on unmount or dep change.
    const unsubscribe = client.onWelcomeChange((welcome) => {
      if (cancelled) return;
      setState((prev) => {
        // Only patch when we're already 'open'; otherwise the welcome update
        // arrived during connect() and the run() block above will deliver
        // the consistent state.
        if (prev.status !== 'open') return prev;
        return { ...prev, welcome, claimCode: welcome.claimCode };
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
      // Intentionally NOT closing the transport: the singleton's URL-form
      // `connect()` dedups concurrent calls so a remount of the hook —
      // including StrictMode's synchronous mount → cleanup → remount —
      // shares this run's still-in-flight promise. Closing the socket here
      // would tear that down out from under the remount and reproduce the
      // tesseron#88 race we fixed by deferring ownership to the singleton.
    };
  }, [enabled, url, client]);

  return state;
}
