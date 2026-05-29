---
title: What you can build
description: Worked scenarios for Tesseron - a live copilot, bulk operations, a desktop app, a headless service - written agnostic to your stack, with the bindings and languages covered at the end.
related:
  - overview/why
  - overview/quickstart
  - sdk/index
---

Tesseron is an accessibility layer for AI agents: you declare the typed actions your app already performs, and any MCP-compatible agent can call them against your real, running state. This page is about what that lets you build.

None of these scenarios care what your app is built with. You declare an app, some actions, and a resource or two with one builder, then connect - the same three steps whether your app is a browser tab, a desktop app, or a background service with no UI at all. The examples show the `tesseron` builder directly; where you import it from - and the framework adapters and other-language bindings - is covered at the end, under [Bindings and languages](#bindings-and-languages). Every code block uses the real API.

## A live copilot inside a complex editor

You are building an editor - say a video editor - and you want an agent that co-edits alongside the human, drafting a rough cut the human then fine-tunes by hand. You declare the editor's real operations once, and the agent calls them straight against your live app.

**The problem.** Dragging clips onto a timeline, snapping them in order, nudging trim handles - that is exactly the fiddly, pixel-precise UI manipulation that browser automation gets wrong, slowly, one brittle round-trip at a time. But "drop these 6 clips in this order, then a title card before clip 3" is one structured intent. The agent does not need to drive your timeline widget, it needs to do the thing the widget does.

**What you declare.** A bulk timeline action, a title-card insert, a long-running preview render, an irreversible export, and a subscribable resource for the current timeline so the agent reads structured state instead of scraping the UI.

```ts
import { z } from "zod";

tesseron.app({ id: "video_editor", name: "Video Editor" });

tesseron.action("add_clips_to_timeline")
  .describe("Insert multiple clips onto the timeline in one ordered batch")
  .input(z.object({
    trackId: z.string(),
    clips: z.array(z.object({ assetId: z.string(), startMs: z.number() })),
  }))
  .handler((input) => {
    // one-shot bulk insert against your real editor store
    return editorStore.insertClips(input.trackId, input.clips);
  });

tesseron.action("insert_title_card")
  .describe("Insert a title card at a given position")
  .input(z.object({ trackId: z.string(), atMs: z.number(), text: z.string() }))
  .handler((input) => editorStore.insertTitleCard(input));

tesseron.action("render_preview")
  .describe("Render a preview of the current timeline")
  .input(z.object({ fromMs: z.number(), toMs: z.number() }))
  .annotate({ readOnly: true })
  .handler(async (input, ctx) => {
    // long-running: stream progress and forward cancellation
    return renderer.preview(input, {
      signal: ctx.signal,
      onProgress: (percent) =>
        ctx.progress({ message: "rendering preview", percent }),
    });
  });

tesseron.action("export_video")
  .describe("Export the final video to a file (expensive, irreversible)")
  .input(z.object({ format: z.enum(["mp4", "webm"]), quality: z.enum(["1080p", "4k"]) }))
  .annotate({ destructive: true, requiresConfirmation: true })
  .timeout({ ms: 600000 })
  .handler(async (input, ctx) => {
    const ok = await ctx.confirm({
      question: `Export the full timeline as ${input.quality} ${input.format}? This burns render minutes.`,
    });
    if (!ok) return { exported: false };
    return renderer.export(input, {
      signal: ctx.signal,
      onProgress: (percent) => ctx.progress({ message: "exporting", percent }),
    });
  });

tesseron.resource("timeline")
  .describe("The current timeline: tracks, clips, and ordering")
  .read(() => editorStore.getTimeline())
  .subscribe((emit) => {
    emit(editorStore.getTimeline()); // initial value
    const off = editorStore.on("change", () => emit(editorStore.getTimeline()));
    return () => off(); // cleanup the listener
  });

const welcome = await tesseron.connect();
console.log("Pair the agent with this code:", welcome.claimCode);
```

**What the agent does.** When the human says "build me a 30 second rough cut from the beach footage, clips in chronological order," the agent reads the `timeline` resource for available assets, then makes a single `video_editor__add_clips_to_timeline` call with all six clips ordered - no dragging, no per-clip round-trips. "Put a title card that says Day One before the third clip" is one `insert_title_card` call. When the human says "let me see it," the agent calls `render_preview`, which streams `ctx.progress` so the human watches the percent climb and can cancel mid-render through `ctx.signal`. Then the human takes over - nudging a trim handle, sliding clip four left by 200ms - and the agent sees the edit because the `timeline` resource re-emits. Finally "ship the 4K mp4" triggers `export_video`, which gates on `ctx.confirm`; if the agent's host cannot prompt, `ctx.confirm` returns false and nothing irreversible runs.

*Dragging clips is the UI manipulation automation fails at; "insert these 6 clips in this order" is one typed action, and your real handler runs against your real editor state.*

## One-shot bulk operations across a data-heavy app

An internal admin panel or data dashboard already has buttons for refunds, tagging, and bans. You expose those same handlers to the agent so it can run them in bulk, across exactly what the operator is looking at.

**The problem.** Every bulk job is N brittle UI round-trips: select a row, click refund, confirm the modal, wait, repeat for the next forty orders. The agent doesn't need to click those buttons - it needs to do the thing the buttons do, once, across the whole selection.

**What you declare.** Register the same handlers your buttons already call, plus a resource that exposes the live table filter and row selection so the agent can act on the current view.

```ts
import { z } from "zod";

tesseron.app({ id: "dashboard", name: "Admin Dashboard" });

// expose the live table filter + selection
tesseron.resource("current_selection")
  .describe("The operator's current table filter and selected row ids")
  .read(() => store.getSelection()) // { filter, orderIds, customerIds, userIds }
  .subscribe((emit) => {
    const onChange = () => emit(store.getSelection());
    store.on("change", onChange);
    return () => store.off("change", onChange); // cleanup the listener
  });

tesseron.action("refund_orders")
  .describe("Refund every order in the given list")
  .input(z.object({ orderIds: z.array(z.string()).min(1) }))
  .handler(async ({ orderIds }, ctx) => {
    let done = 0;
    for (const id of orderIds) {
      await refundOrder(id); // same code path the refund button calls
      ctx.progress({ message: `refunded ${id}`, percent: ++done / orderIds.length });
    }
    return { refunded: done };
  });

tesseron.action("tag_customers")
  .describe("Apply a tag to a list of customers")
  .input(z.object({ customerIds: z.array(z.string()).min(1), tag: z.string() }))
  .handler(async ({ customerIds, tag }) => {
    await tagCustomers(customerIds, tag); // your real customer store
    return { tagged: customerIds.length };
  });

tesseron.action("ban_users")
  .describe("Permanently ban a list of users")
  .input(z.object({ userIds: z.array(z.string()).min(1), reason: z.string() }))
  .annotate({ destructive: true, requiresConfirmation: true })
  .handler(async ({ userIds, reason }, ctx) => {
    const ok = await ctx.confirm({
      question: `Ban ${userIds.length} users for "${reason}"? This is irreversible.`,
    });
    if (!ok) return { banned: 0 };
    await banUsers(userIds, reason); // same code path the ban button calls
    return { banned: userIds.length };
  });

await tesseron.connect();
```

`ban_users` is annotated destructive, and the `ctx.confirm` gate returns `false` on decline and on agents without elicitation - so the safe path needs no capability guard. The `current_selection` resource is subscribable, so the agent always acts on the operator's current view rather than a stale snapshot.

**What the agent does.** An operator filters the table to last week's failed charges, selects the rows, and types "refund the orders I currently have selected." The agent reads the `current_selection` resource, pulls the `orderIds`, and calls `dashboard__refund_orders` with the whole array - five clicks become one call, and `ctx.progress` streams each refund back into the chat. "Tag everyone in this view as priority_support" reads the same resource and fires `dashboard__tag_customers` once. "Ban these three accounts for fraud" triggers `dashboard__ban_users`, which calls `ctx.confirm` - the operator approves in the agent, the ban runs, and a decline returns `{ banned: 0 }`.

*Your real handler runs against your real state - no separate MCP server, no backend duplication, just one-shot bulk where the UI made you click N times.*

## A desktop or local-first app

Not every app is a web page. A desktop tool - a markdown notes vault, a local-database GUI, an offline knowledge base - exposes actions exactly the same way. Tesseron runs inside your app's own process (for Electron or Tauri, the main process), mutates real state on disk, and pushes the result to your UI; no browser tab is involved anywhere.

**The problem.** A desktop app has no public API and no URL an agent can hit - the only way in is the UI, so an agent would have to drive menus, dialogs, and a tree view it cannot see. "Reorganize my 400 notes into folders by topic" is hundreds of brittle clicks. The agent doesn't need to click the New Note button, it needs to do the thing that button does, against your real vault.

**What you declare.** The same builder, running in the process that owns the files.

```ts
import { z } from "zod";

tesseron.app({
  id: "notes_vault",
  name: "Notes Vault",
  description: "A local markdown notes vault.",
});

const folderSchema = z.object({ folder: z.string() });

tesseron.action("create_note")
  .describe("Create a markdown note in a folder.")
  .input(z.object({ title: z.string(), body: z.string(), folder: z.string().optional() }))
  .handler(async (input, ctx) => {
    let folder = input.folder;
    if (!folder) {
      // no destination given - ask the human which folder
      const picked = await ctx.elicit({
        question: "Which folder should this note go in?",
        schema: folderSchema,
        jsonSchema: z.toJSONSchema(folderSchema),
      });
      if (picked === null) return { created: false };
      folder = picked.folder;
    }
    // writes a real .md file and notifies the UI
    const path = await vault.writeNote(folder, input.title, input.body);
    return { created: true, path };
  });

tesseron.action("search_notes")
  .describe("Full-text search across the vault.")
  .input(z.object({ query: z.string() }))
  .annotate({ readOnly: true })
  .handler(async (input) => {
    // runs against your real local index
    return { hits: await vault.search(input.query) };
  });

tesseron.action("organize_vault")
  .describe("Move notes into topic folders in bulk.")
  .input(z.object({ moves: z.array(z.object({ path: z.string(), folder: z.string() })) }))
  .annotate({ destructive: true, requiresConfirmation: true })
  .handler(async (input, ctx) => {
    const ok = await ctx.confirm({ question: `Move ${input.moves.length} notes?` });
    if (!ok) return { moved: 0 };
    for (let i = 0; i < input.moves.length; i++) {
      ctx.progress({ message: `moving ${input.moves[i].path}`, percent: (i / input.moves.length) * 100 });
      await vault.move(input.moves[i].path, input.moves[i].folder); // real fs move
    }
    return { moved: input.moves.length };
  });

tesseron.resource("vault_tree")
  .describe("The current folder and note tree.")
  .read(() => vault.tree())
  .subscribe((emit) => {
    const onChange = () => emit(vault.tree());
    vault.on("change", onChange);
    return () => vault.off("change", onChange); // tear down the watcher
  });

const welcome = await tesseron.connect();
console.log(`Pair the agent with claim code: ${welcome.claimCode}`);
```

**What the agent does.** "Jot down a note about today's standup" calls `notes_vault__create_note` with no folder, so the handler runs `ctx.elicit` and a native dialog asks which folder - you pick "Work", the note is written, and your UI refreshes. "Reorganize my vault by topic" reads the `vault_tree` resource, then calls `notes_vault__organize_vault`; because it is annotated destructive, `ctx.confirm` gates the move ("Move 412 notes?") and `ctx.progress` streams each file as it lands. "Find everything I wrote about Postgres" hits the read-only `notes_vault__search_notes` and returns hits straight from your local index. One bulk call replaces hundreds of drag-and-drop round-trips.

*The agent does the thing your buttons do - your real handler runs against your real vault, no browser in sight.*

## A service or daemon with no UI

Some apps have no UI at all - a deploy runner, a data-pipeline supervisor, an internal CLI. There is nothing to render; there are just typed handlers in a long-running process. Expose them and an agent can operate the service directly.

**The problem.** To let an agent drive a service like this, you would normally stand up a parallel REST API just to feed an LLM - new routes, new auth, new serialization - and then watch it drift from the real internal functions it wraps. Tesseron skips that layer: you expose your existing typed handlers directly, and your real handler runs against your real state.

**What you declare.**

```ts
import { z } from "zod";

tesseron.app({
  id: "deploy_ops",
  name: "Deploy Ops Daemon",
  description: "Headless control plane for deploys and rollbacks",
});

tesseron.action("trigger_deploy")
  .describe("Build and roll out a service to an environment. Returns the result.")
  .input(z.object({ service: z.string(), env: z.enum(["staging", "prod"]), ref: z.string() }))
  .timeout({ ms: 600_000 })
  .handler(async (input, ctx) => {
    ctx.progress({ message: `building ${input.service}@${input.ref}`, percent: 10 });
    // runs against your real deploy pipeline; signal cancels the in-flight rollout
    const res = await fetch(`http://internal/deploy/${input.service}`, {
      method: "POST",
      body: JSON.stringify(input),
      signal: ctx.signal,
    });
    ctx.progress({ message: "rollout complete", percent: 100 });

    // optionally have the agent summarize the tail of the deploy log
    if (ctx.agentCapabilities.sampling) {
      const tail = await getLogTail(input.service); // your real log store
      const summary = await ctx.sample({
        prompt: `Summarize this deploy log tail in two lines:\n${tail}`,
        maxTokens: 200,
      });
      return { ok: res.ok, summary };
    }
    return { ok: res.ok };
  });

tesseron.action("rollback")
  .describe("Roll a service back to its previous release.")
  .input(z.object({ service: z.string(), env: z.enum(["staging", "prod"]) }))
  .annotate({ destructive: true, requiresConfirmation: true })
  .handler(async (input, ctx) => {
    const ok = await ctx.confirm({
      question: `Roll back ${input.service} in ${input.env} to the previous release?`,
    });
    if (!ok) return { rolledBack: false };
    await rollbackService(input.service, input.env); // your real state
    return { rolledBack: true };
  });

tesseron.resource("deploy_status")
  .describe("Live status of in-flight and recent deploys.")
  .read(() => readDeployStatus()) // your real status store
  .subscribe((emit) => {
    emit(readDeployStatus()); // initial value so the first read resolves
    const off = onDeployChange((status) => emit(status)); // your event source
    return () => off(); // cleanup the listener
  });

const welcome = await tesseron.connect();
console.log(`Pair the agent with claim code: ${welcome.claimCode}`);
```

**What the agent does.** When you say "ship payments at ref a1b2c3 to staging", the agent calls `deploy_ops__trigger_deploy`; your handler streams `ctx.progress` updates as the build and rollout advance, forwards `ctx.signal` so a cancel actually aborts the fetch, and - if the connected agent supports sampling - uses `ctx.sample` to fold a log tail into a two-line summary. "What is deploying right now?" reads the `deploy_status` resource and, because it is subscribable, the agent watches it change live instead of polling. "Roll back prod payments" hits the rollback action, where `ctx.confirm` gates the destructive step - decline, or connect an agent without elicitation, and it returns false, so nothing happens.

*Expose your typed actions instead of standing up a parallel REST API just to feed an LLM - the agent does not need a button to click, it needs the thing the button does.*

## Bindings and languages

Nothing above was specific to a framework. The `tesseron` builder is the same whichever package you import it from - pick the one that matches your runtime:

- **`@tesseron/web`** - any browser app, vanilla or alongside any framework.
- **`@tesseron/react`**, **`@tesseron/svelte`**, **`@tesseron/vue`** - ergonomic adapters that register actions and resources from inside your components and tear them down on unmount. The admin and editor examples above could use these instead of the bare builder; the declared actions are identical.
- **`@tesseron/server`** - Node: backend services, CLIs, daemons, and the main process of an Electron or Tauri desktop app. The desktop and daemon examples above run on this.
- **`@tesseron/core`** - the builder and protocol types with no transport, for wiring your own.

And it is not limited to TypeScript. Tesseron is a protocol - the spec is published under CC BY 4.0 - and the JS/TS packages are the reference implementation, not the only possible one. Anything that speaks JSON-RPC 2.0 over a duplex channel can host actions: a Python data daemon, a Rust Tauri app, a .NET line-of-business tool. Those SDKs are not written yet - today TypeScript ships, and a Python SDK and Rust bindings for Tauri are on the roadmap. To expose actions from another language right now, [port the protocol](/sdk/porting/) - it is a small wire contract; for the planned Python SDK and its status, see [its page](/sdk/python/).

## Where to start

The [5-minute quickstart](/overview/quickstart/) takes any runtime from zero to a claimed session. Then browse the [SDK overview](/sdk/) for the package that fits your stack.
