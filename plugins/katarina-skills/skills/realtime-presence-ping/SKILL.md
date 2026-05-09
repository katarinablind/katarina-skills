---
name: realtime-presence-ping
description: Use when building lightweight realtime presence pings — a button press / tap in one viewer's UI triggers a small ephemeral visual (bubble, heart, ripple, splash) to appear in other connected viewers' UIs at a random or specified position. Distinct from chat (no message), distinct from cursors (not continuous), distinct from notifications (visual + ephemeral, not text + persistent). Covers the trigger → broadcast → receive → render → fade-out lifecycle, transport options (Supabase Realtime, BroadcastChannel, WebSocket, server-sent events), and the visual decay pattern. Skip for chat systems, persistent reactions, or full presence-aware UIs.
---

# Realtime Presence Ping

A presence ping is the smallest possible piece of realtime communication: one user does
something tiny (a tap), and every other viewer sees a small ephemeral visual flash through
their UI. No text, no message, no history. The first reference is the bubble pings in
**telefishin** — a button press in one tank-viewer's UI sends a column of bubbles rising
through every other viewer's tank.

The pattern is general. The visual can be anything (bubble, heart, ripple, splash). The
transport can be anything (Supabase Realtime, WebSocket, BroadcastChannel, SSE). The
reusable shape is the lifecycle and the cleanup discipline.

## The lifecycle

```
trigger   → user presses a button (or taps the canvas)
emit      → broadcast { id, kind, x, y, ts, sender } on a shared channel
receive   → other clients (and optionally self) get the event
render    → spawn a DOM element with a one-shot animation at (x, y)
decay     → on animationend (or after timeout), remove the node
```

Four moving parts. Most bugs happen at the seams: forgetting to include an `id` so
duplicates fire, forgetting to filter your own echo, forgetting to remove the DOM node
after the animation ends.

## The event payload

Keep it tiny. A typical payload is:

```js
{
  id:        crypto.randomUUID(),  // dedupe across echo
  kind:      'bubble',             // visual motif (bubble, heart, ripple, ...)
  x:         420,                  // optional — sender-chosen position
  y:         310,
  timestamp: Date.now(),
  sender:    'tab-A',              // who emitted; lets recipients filter self
}
```

The `id` is the most important field. It lets recipients deduplicate when they receive
their own echo back from the server, and it gives every spawned visual a unique key for
React lists or DOM queries.

## Position strategies

There are two main choices, and they imply different feels:

- **Sender-chosen position.** The sender includes `(x, y)` in the payload — usually where
  they tapped. Recipients render at that exact position. This produces *spatial coupling*:
  if tab A clicks at the top-left of the canvas, the bubble appears top-left in tab B
  too. Good for shared whiteboards, click-to-place mechanics, "look at this spot" pings.

- **Recipient-chosen position.** The payload has no position. Each recipient picks a
  random position in their viewport. This is *loose coupling* and works well across very
  different screen sizes and aspect ratios. Telefishin uses this — bubble x-coord is
  `randomInRange(15, 85)` percent inside each receiver's tank.

Pick sender-chosen when *where it happened* is the message. Pick recipient-chosen when
the message is just *that something happened*.

## Transport options

The lifecycle is transport-agnostic. Pick a channel based on what you already have:

| Transport | Best for | Trade-off |
|---|---|---|
| **Supabase Realtime** | Apps already on Supabase. Telefishin's choice. | Needs a Supabase project. Postgres-changes channels also persist. |
| **WebSocket** | You control the server and want a return channel. | You run the server. |
| **BroadcastChannel** | Same-origin tabs in one browser. Local demos. | Same browser only — useless across users on different machines. |
| **Server-Sent Events** | One-way fanout from a cheap server. | No return channel — clients still need POSTs to emit. |

For most production apps the choice is dictated by your stack. For studios and demos,
BroadcastChannel is dramatically simpler — no server, two tabs, working demo.

## The visual decay (don't leak nodes)

Ephemeral animations need to clean themselves up. The most common bug in this whole
pattern is leaking DOM nodes — the bubble fades to invisible but the element stays in
the document forever, and after a few hundred pings your page is choked.

Two clean-up patterns, pick one:

```js
// Pattern A — listen for animationend
const el = document.createElement('div');
el.className = 'ping-bubble';
el.style.left = x + 'px';
el.style.top  = y + 'px';
container.appendChild(el);
el.addEventListener('animationend', () => el.remove(), { once: true });
```

```js
// Pattern B — setTimeout matching the animation duration
container.appendChild(el);
setTimeout(() => el.remove(), LIFETIME_MS);
```

Pattern A is more correct (cleans up exactly when the animation actually ends, even if
the user pauses the tab). Pattern B is bulletproof if your animation duration is
deterministic and you're worried about animation events not firing in some edge case.

In React-land, the equivalent is `<AnimatePresence>` plus a `setTimeout` that splices
the trail out of the array — exactly what telefishin's `BubbleLayer` does:

```ts
const timeout = setTimeout(() => removeTrail(trailKey), totalSec * 1000);
trailRemovalTimeouts.current[trailKey] = timeout;
```

And on unmount, clear every pending timeout — otherwise a route change leaves stale
removal timers firing into a dead component.

## Visual motifs

The motif is whatever fits the app's metaphor. The lifecycle is identical for all of
them — only the CSS animation changes:

- **Bubble** — rises from the bottom, drifts horizontally, fades at the top.
  Telefishin's choice because it's a fish tank.
- **Heart** — rises like a bubble but with a wider drift; classic streaming-app reaction.
- **Ripple** — expands outward from the click point, fades as it grows; Material-Design
  style. Best paired with sender-chosen positions.
- **Splash** — multiple small particles fanning out from the click point, falling under
  pseudo-gravity. Heavier visually; good for celebrations.

Telefishin uses bubbles because the metaphor is a fish tank. The skill is about the
mechanism; pick the visual based on your metaphor.

## Worked example — BroadcastChannel demo

Self-contained HTML. Open in two browser tabs and the button in tab A spawns a bubble in
tab B (and tab A — local echo). Replace the BroadcastChannel with any other transport
without touching the visual code.

```html
<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; height: 100vh; background: #07203a;
         display: flex; flex-direction: column; align-items: center;
         justify-content: flex-end; padding: 20px; }
  #stage { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
  .ping-bubble {
    position: absolute; width: 28px; height: 28px; border-radius: 50%;
    background: rgba(255,255,255,0.35);
    border: 1px solid rgba(255,255,255,0.6);
    animation: rise 2400ms ease-out forwards;
  }
  @keyframes rise {
    0%   { transform: translate(-50%, 0)        scale(0.5); opacity: 0; }
    15%  { opacity: 0.85; }
    100% { transform: translate(-50%, -100vh)   scale(1.0); opacity: 0; }
  }
  button { position: relative; padding: 10px 18px; font-size: 14px;
           border: 1px solid #fff4; background: #fff2; color: #fff;
           border-radius: 999px; cursor: pointer; }
</style></head>
<body>
  <div id="stage"></div>
  <button id="ping">Send ping</button>

<script>
const ch     = new BroadcastChannel('presence-ping');
const me     = crypto.randomUUID();
const stage  = document.getElementById('stage');

function spawnBubble(x) {
  const el = document.createElement('div');
  el.className = 'ping-bubble';
  el.style.left = x + 'px';
  el.style.bottom = '-30px';
  stage.appendChild(el);
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

function emit() {
  // Recipient-chosen position: send no x; each recipient picks one.
  const msg = { id: crypto.randomUUID(), kind: 'bubble',
                ts: Date.now(), sender: me };
  ch.postMessage(msg);
  // Local echo — render our own ping immediately.
  spawnBubble(Math.random() * innerWidth);
}

ch.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.sender === me) return;       // ignore our own echo if it loops back
  spawnBubble(Math.random() * innerWidth);
});

document.getElementById('ping').addEventListener('click', emit);
</script>
</body></html>
```

That's the entire pattern. Swap `BroadcastChannel` for a Supabase channel or a WebSocket
and the `spawnBubble` / `emit` / `addEventListener('message', ...)` shape is unchanged.
The lifecycle is the reusable part.

## Checklist when wiring this up

- [ ] Every event has a unique `id`.
- [ ] Decide local-echo policy: render your own ping immediately, *or* let the round-trip
      bring it back. Pick one and document it. Telefishin echoes locally.
- [ ] Filter by `sender` so you don't render duplicates if echo + round-trip both fire.
- [ ] Decide position policy: sender-chosen vs recipient-chosen.
- [ ] Every spawned DOM node has a removal hook (`animationend` or `setTimeout`).
- [ ] On component unmount, clear every pending removal timer.
- [ ] Rate-limit the trigger (telefishin caps bubble emits to avoid spam).
