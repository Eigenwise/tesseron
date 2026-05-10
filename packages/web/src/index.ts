import {
  type ConnectOptions,
  TesseronClient,
  type Transport,
  type WelcomeResult,
} from '@tesseron/core';
import { BrowserWebSocketTransport } from './transport.js';

export * from '@tesseron/core';
export { BrowserWebSocketTransport } from './transport.js';

/**
 * Default gateway endpoint: the Tesseron Vite plugin exposes `/@tesseron/ws`
 * on the same origin as the page, so no separate port is needed.
 * Falls back to a non-browser safe string — in practice the browser always
 * has `location` defined, this branch is only hit during SSR/bundler analysis.
 */
export const DEFAULT_GATEWAY_URL =
  typeof location !== 'undefined'
    ? `${location.origin.replace(/^http/, 'ws')}/@tesseron/ws`
    : 'ws://localhost:5173/@tesseron/ws';

/**
 * Browser-side {@link TesseronClient} with a WebSocket-aware `connect` overload.
 * Pass nothing to use {@link DEFAULT_GATEWAY_URL}, a URL string to connect to
 * another gateway, or a custom {@link Transport} to bypass WebSocket entirely.
 * The optional second argument forwards {@link ConnectOptions} (e.g. session
 * resume) to the core client.
 *
 * **Re-entry safety.** Two URL-form `connect()` calls with the same URL and
 * the same resume credentials (StrictMode mount → cleanup → remount, HMR
 * re-running module-scope `connect()`, an `enabled` flag flapping under an
 * auth gate) share a single in-flight promise and a single underlying
 * WebSocket. Without this, both calls would build their own socket, the
 * gateway would see two `tesseron/resume` requests sharing one (single-shot)
 * resume token, and the second one would invariably fail with `ResumeFailed`.
 * See tesseron#88. The transport-form (`connect(transport, options)`)
 * bypasses URL-form de-dup and falls through to {@link TesseronClient.connect}'s
 * serialization on top.
 */
export class WebTesseronClient extends TesseronClient {
  /**
   * Tracks the most recent URL-form connect attempt so concurrent calls
   * with matching options share its promise instead of opening a parallel
   * WebSocket. Cleared once the promise settles.
   */
  private inFlightUrlConnect?: {
    url: string;
    resumeKey: string;
    promise: Promise<WelcomeResult>;
  };

  override connect(target?: Transport | string, options?: ConnectOptions): Promise<WelcomeResult> {
    if (target && typeof target !== 'string') {
      // Caller supplied their own transport — defer to core's
      // serialization. URL-form de-dup doesn't apply because we have no
      // safe way to assert the caller's transport is interchangeable with
      // an in-flight one.
      return super.connect(target, options);
    }
    const url = target ?? DEFAULT_GATEWAY_URL;
    const resumeKey = resumeKeyOf(options?.resume);
    const inFlight = this.inFlightUrlConnect;
    if (inFlight && inFlight.url === url && inFlight.resumeKey === resumeKey) {
      // Identity preserving: concurrent matching callers share THIS exact
      // promise reference, not a wrapper. That lets adapters compare
      // promises (`a === b`) to detect a deduped re-entry.
      return inFlight.promise;
    }
    const promise = (async (): Promise<WelcomeResult> => {
      const transport = new BrowserWebSocketTransport(url);
      try {
        await transport.ready();
      } catch (err) {
        // ready() rejected — gateway unreachable, TLS handshake failed,
        // or the socket closed before opening. Best-effort close so the
        // underlying `WebSocket` is GC'able and we don't leak a half-open
        // socket past the rejected connect promise. close() is a no-op
        // if the WS already closed itself, which is the common case.
        try {
          transport.close();
        } catch {
          // Already in a bad state; nothing more to do.
        }
        throw err;
      }
      return super.connect(transport, options);
    })();
    const entry = { url, resumeKey, promise };
    this.inFlightUrlConnect = entry;
    promise
      .catch(() => {})
      .finally(() => {
        if (this.inFlightUrlConnect === entry) this.inFlightUrlConnect = undefined;
      });
    return promise;
  }
}

function resumeKeyOf(resume: ConnectOptions['resume']): string {
  // Stable, order-insensitive fingerprint of the resume credentials.
  // `null`/`undefined` → empty string so two URL-form calls without a
  // resume payload de-dup against each other.
  if (!resume) return '';
  return `${resume.sessionId}\x00${resume.resumeToken}`;
}

/**
 * Singleton {@link WebTesseronClient} shared across a browser app. Most apps
 * import and use this directly rather than constructing their own.
 */
export const tesseron = new WebTesseronClient();
