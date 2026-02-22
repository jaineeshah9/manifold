# Three.js MCP Server — Blender-style 3D Scene Builder

An MCP server that lets Claude (or any MCP client) build a 3D scene through **discrete structured tool calls** with a **proper scene graph** instead of code generation. The goal is a **persistent scene graph on the server**, Claude orchestrating it via structured tools, and a **Three.js frontend** that re-renders on state changes, rendered as an **MCP App widget** inside Claude/ChatGPT's chat UI.

---

## What We're Building

| Layer | Description |
|-------|-------------|
| **AI client** | Claude/ChatGPT calls MCP tools to create and edit the scene |
| **MCP server** | Holds in-memory scene graph; exposes 7 structured tools |
| **Widget** | Three.js canvas in chat UI; rebuilds from server state; bidirectional with LLM |

**Design choice:** We do **not** use code generation as the primary path. All manipulation flows through structured tools and a persistent scene graph. `execute_code` is an escape hatch only.

---

## Step 0 — Install the Skill First

Before writing any code, install the mcp-use **chatgpt-app-builder** skill:

```bash
npx skills add https://github.com/mcp-use/mcp-use --skill chatgpt-app-builder
```

This gives you the full reference docs for:

- **server-and-widgets.md** — how to write `server.tool()` with widgets  
- **state-and-context.md** — persisting state, triggering LLM from widget  
- **setup.md** — scaffolding and running the dev server  
- **architecture.md** — deciding what needs UI vs tools-only  
- **widget-patterns.md** — advanced widget patterns  

Read these docs before writing any code. They are your primary implementation guide.

**Skill URL:** [skills.sh/mcp-use/mcp-use/chatgpt-app-builder](https://skills.sh/mcp-use/mcp-use/chatgpt-app-builder)

---

## Primary References

1. **mcp-use chatgpt-app-builder** (primary SDK) — [skills.sh/mcp-use/mcp-use/chatgpt-app-builder](https://skills.sh/mcp-use/mcp-use/chatgpt-app-builder)  
   - Use `server.tool()` with `widget: { name: "widget-name" }`, `widget({ props, output })`, and in the widget: `useWidget()`, `sendFollowUpMessage()`, `state`/`setState`.

2. **Blender MCP** (architecture reference) — [github.com/ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp)  
   - Three-tier: AI client → MCP server → rendering layer. We adopt the structure but use a scene graph + tools instead of `execute_blender_code`.

3. **threejs-server** (rendering pattern) — [modelcontextprotocol/ext-apps/examples/threejs-server](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/threejs-server)  
   - Copy: OrbitControls, bloom post-processing, vite-plugin-singlefile. Do **not** copy: execute arbitrary JS string as primary path.

4. **MCP Apps protocol** — [modelcontextprotocol.io/docs/extensions/apps](https://modelcontextprotocol.io/docs/extensions/apps)  
   - Tools declare a `ui://` resource; host renders in a sandboxed iframe; bidirectional communication via MCP notifications.

---

## The 7 Tools

| Tool | Purpose |
|------|---------|
| **get_scene_state()** | Returns full scene JSON (all objects, positions, colors, connections). |
| **add_object(type, params)** | `type`: `"box"` \| `"sphere"` \| `"cylinder"` \| `"cone"` \| `"plane"`. `params`: `name`, `position {x,y,z}`, `scale {x,y,z}`, `color` (hex). Returns generated object id. |
| **update_object(id, params)** | Move / resize / recolor existing object by id; all params optional. |
| **delete_object(id)** | Remove object from scene by id. |
| **connect(from_id, face_a, to_id, face_b)** | `face`: `"top"` \| `"bottom"` \| `"left"` \| `"right"` \| `"front"` \| `"back"` \| `"center"`. Server computes offset so `face_a` of `from_id` touches `face_b` of `to_id`. LLM never deals with raw coordinates. |
| **clear_scene()** | Wipe everything; reset to empty scene. |
| **execute_code(code)** | Escape hatch for arbitrary Three.js; use sparingly; structured tools preferred. |

---

## Scene State Format (Server Source of Truth)

The server keeps this structure in memory. Every tool updates it and passes the full state to the widget as props:

```json
{
  "objects": {
    "obj_1": {
      "type": "box",
      "name": "base",
      "width": 200,
      "height": 20,
      "depth": 100,
      "position": { "x": 0, "y": 0, "z": 0 },
      "color": "#cc0000"
    },
    "obj_2": {
      "type": "cylinder",
      "name": "post",
      "radius": 10,
      "height": 100,
      "position": { "x": 0, "y": 60, "z": 0 },
      "color": "#ffffff"
    }
  },
  "connections": []
}
```

Tool handlers return `widget({ props: sceneState, output: text("...") })` so the widget always receives the latest scene.

---

## Widget Requirements (`resources/scene-widget.tsx`)

- Use **useWidget()** to receive scene state as **props**.
- On each render, **rebuild** the Three.js scene from `props.objects`.
- **Geometry mapping:**
  - `box` → `BoxGeometry(width, height, depth)`
  - `sphere` → `SphereGeometry(radius)`
  - `cylinder` → `CylinderGeometry(radius, radius, height)`
  - `cone` → `ConeGeometry(radius, height)`
  - `plane` → `PlaneGeometry(width, depth)`
- Apply **position** and **color** from scene state.
- **OrbitControls** for rotate/zoom.
- **Floating text label** above each object with its name.
- **Sidebar** listing all objects and their types.
- **Connections:** draw a line between connected objects.
- Use **sendFollowUpMessage()** when the user clicks an object so the LLM knows what they’re focused on.

---

## Stack

- **MCP server:** Node.js / TypeScript, [mcp-use/server](https://mcp-use.com/docs/typescript/getting-started/quickstart)
- **Widget:** React + Three.js in `resources/scene-widget.tsx`
- **State:** In-memory scene graph as source of truth
- **Build:** Vite + vite-plugin-singlefile
- **Host:** Rendered as mcp-use widget in Claude/ChatGPT chat UI

---

## Build Order

1. Scaffold project with mcp-use (follow **setup.md** from the skill).
2. Implement in-memory scene graph and the **7 tools** in `server.ts`.
3. Implement the Three.js widget in `resources/scene-widget.tsx`.
4. Wire **props → scene rebuild** on every tool call.
5. Test with the acceptance sequence below.

---

## Acceptance Test

Run in sequence:

1. `add_object("box", { name: "base", width: 200, height: 20, depth: 100, color: "#cc0000" })`
2. `add_object("cylinder", { name: "post", radius: 10, height: 100, color: "#ffffff" })`
3. `connect("obj_2", "bottom", "obj_1", "top")`
4. `update_object("obj_1", { color: "#0000cc" })`

**Expected:** Blue flat box with white cylinder standing on top, rotatable in chat.

---

## Constraints

- **TypeScript** throughout.
- Use **mcp-use/server** patterns (`server.tool`, `widget()`, `useWidget`) — not raw MCP SDK.
- **No code-gen as primary path** — `execute_code` is escape hatch only.
- No physics, STL export, or optimization — out of scope.
- Start with **server + scene graph first**, wire widget second.

---

## Getting Started (Local Dev)

```bash
npm install
npm run dev
```

Open [http://localhost:3000/inspector](http://localhost:3000/inspector) to test the server. Edit the entry file; the server auto-reloads as you edit.

## Deploy on Manufact Cloud

```bash
npm run deploy
```

---

## Learn More

- [mcp-use Documentation](https://mcp-use.com/docs/typescript/getting-started/quickstart)
- [MCP Apps Hackathon 2026 context](./docs/mcp-apps-hackathon-2026-master-context.md) (evaluation criteria, widget–model interaction)
