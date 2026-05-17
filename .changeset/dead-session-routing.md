---
'@tesseron/core': patch
'@tesseron/mcp': patch
---

fix(mcp, core): route around dead-transport sessions in the bridge selector (closes #92)

When two sessions for the same `app.id` co-existed in the gateway's claimed
map, `latestClaimedByApp` picked whichever had the most recent `claimedAt`
without checking that the underlying transport was still alive. If the
newer session's `onClose` handler hadn't fired yet (long-tailed WebSocket
close event, fast double-claim, OS-level FIN delay), every subsequent
`tools/call` from the agent forwarded `actions/invoke` to a closed socket
and the MCP tool call hung until the upstream client's own timeout.

The fix adds an optional liveness probe to the protocol-level Transport
interface (`Transport.isClosed?(): boolean`) and implements it on both the
gateway's WS and UDS dialer transports. The bridge selector
(`mcp-bridge.ts#latestClaimedByApp`) now skips any session whose transport
reports closed, so the live session wins regardless of `claimedAt` order.
When every candidate for an `app.id` is dead, the call fails fast with
the existing "no claimed session" error instead of hanging.

Backward compatible — `isClosed` is optional; transports that don't
implement it are treated as live (preserves pre-#92 behaviour for those
transports).

The Tesseron 2.9.0 host-mint resume flow already avoids the race for vite
hosts (the SessionManager keeps the gateway WS alive across browser
refreshes), but the gateway selector is now defence-in-depth for any
multi-claim scenario: a parallel Claude Code instance also paired, a fast
HMR cycle, or a non-vite host that doesn't hide the disconnect.
