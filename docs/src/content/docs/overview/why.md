---
title: Why Tesseron?
description: The problem Tesseron solves, and where it fits relative to browser automation, chat widgets, and custom APIs.
related:
  - overview/architecture
  - protocol/index
---

Agents are great at reasoning about what to do. They're bad at reaching into your app to do it.

The agent doesn't need to click a button - it needs to *do the thing the button does*. Tesseron is the layer that lets it: you instrument your app once, the way you'd add ARIA to a web page, and any MCP-compatible agent can call the typed actions you expose. An accessibility layer for AI agents, in other words - or an API for agents, written by the people who built the app.

There are three common ways to close that gap. Tesseron is a fourth.

## 1. Browser automation (Playwright, Selenium, Computer Use)

The agent drives a pixel-level browser. Conceptually powerful, practically fragile: every layout tweak breaks selectors, every modal needs bespoke handling, every authentication flow is re-solved from scratch. Token-heavy. Slow.

## 2. Chat widget embedded in the app

You bolt an AI sidebar into your UI and wire up tool calls manually. The agent can talk to your backend, but it can't touch the running UI state the user is looking at. Two worlds that never meet.

## 3. A bespoke MCP server for your backend

Great for headless automation. Useless for "put this in the user's cart on the page they're already viewing." The user's session, their open tab, their in-memory draft - all invisible to a backend MCP server.

## 4. Tesseron

The running app opens a WebSocket to a local MCP gateway and declares its actions:

```ts
tesseron.action('addToCart').input(...).handler(...);
```

The gateway exposes those actions as MCP tools over stdio. Any MCP-capable agent - Claude Code, Cursor, Claude Desktop, any other - sees them and calls them. The handler runs inside the user's real app, with their real state, their real auth.

### Not just for the web

Tesseron is a protocol, not a web framework. The first SDKs happen to target the browser (vanilla, React, Svelte, Vue) and Node (servers, CLIs, Electron/Tauri desktop apps) - but anything that can open a WebSocket and speak JSON-RPC 2.0 can host actions. A Python daemon driving a data pipeline, a Rust desktop app, a .NET line-of-business tool: all of them can expose the same typed actions the same way. The JS/TS implementation is just where it started; see [Porting Tesseron](/sdk/porting/) and the [Python SDK status](/sdk/python/).

## Tradeoffs (be honest)

- **Localhost by default.** Tesseron is a local-first developer tool. Apps bind to `127.0.0.1`; the gateway only dials loopback URLs. Nothing leaks off the machine.
- **Bound to a running app.** The agent can only act while your app is running. A refresh or reload keeps the same session (resume is on by default); fully closing the app ends it. This is a feature - it keeps the agent bound to what the user can actually see.
- **Not a replacement for a headless API.** If you need scheduled or unattended automation, you want a server-side MCP. Tesseron complements it - it doesn't replace it.

## When Tesseron is the right fit

- Internal tools where power users want to drive the UI via chat.
- Complex workflows that already exist as UI actions - search, filter, create, approve - and shouldn't be duplicated on the backend.
- Product demos and prototypes where "the agent actually does what the user sees" is the whole point.
- Personal dashboards, admin panels, CMS editors, developer tooling.
- Desktop and back-end apps too - an Electron editor, a Node daemon, a CLI - that want an agent-callable surface without standing up a separate MCP server.

If you're shipping one of those, keep reading.
