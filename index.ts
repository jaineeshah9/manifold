import { MCPServer, object, text, widget, error } from "mcp-use/server";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Vec3 { x: number; y: number; z: number; }
type Face = "top" | "bottom" | "left" | "right" | "front" | "back" | "center";

type SceneObject =
  | { type: "box";      id: string; name: string; position: Vec3; scale: Vec3; color: string; width: number; height: number; depth: number }
  | { type: "sphere";   id: string; name: string; position: Vec3; scale: Vec3; color: string; radius: number }
  | { type: "cylinder"; id: string; name: string; position: Vec3; scale: Vec3; color: string; radius: number; height: number }
  | { type: "cone";     id: string; name: string; position: Vec3; scale: Vec3; color: string; radius: number; height: number }
  | { type: "plane";    id: string; name: string; position: Vec3; scale: Vec3; color: string; width: number; depth: number };

interface Connection { from_id: string; face_a: Face; to_id: string; face_b: Face; }
interface SceneState  { objects: Record<string, SceneObject>; connections: Connection[]; }

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let sceneState: SceneState = { objects: {}, connections: [] };
let idCounter = 1;
let sceneVersion = 0;
function nextId() { return `obj_${idCounter++}`; }

const persistedStatePath = path.join(process.cwd(), ".mcp-use", "scene-state.json");

async function loadPersistedState() {
  try {
    const raw = await fs.readFile(persistedStatePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<{
      sceneState: SceneState;
      idCounter: number;
      sceneVersion: number;
    }>;

    if (parsed.sceneState?.objects && parsed.sceneState?.connections) {
      sceneState = parsed.sceneState;
    }
    if (typeof parsed.idCounter === "number" && Number.isFinite(parsed.idCounter) && parsed.idCounter >= 1) {
      idCounter = Math.floor(parsed.idCounter);
    } else {
      // Best-effort inference from existing object IDs: obj_#
      const nums = Object.keys(sceneState.objects)
        .map((k) => (k.startsWith("obj_") ? Number(k.slice(4)) : NaN))
        .filter((n) => Number.isFinite(n) && n >= 1) as number[];
      const max = nums.length ? Math.max(...nums) : 0;
      idCounter = Math.max(idCounter, max + 1);
    }
    if (typeof parsed.sceneVersion === "number" && Number.isFinite(parsed.sceneVersion) && parsed.sceneVersion >= 0) {
      sceneVersion = Math.floor(parsed.sceneVersion);
    }
  } catch {
    // ignore missing/invalid persisted state
  }
}

async function persistState() {
  try {
    await fs.mkdir(path.dirname(persistedStatePath), { recursive: true });
    await fs.writeFile(
      persistedStatePath,
      JSON.stringify({ sceneState, idCounter, sceneVersion }, null, 2),
      "utf8"
    );
  } catch (e) {
    console.warn("[manifold] Failed to persist scene state:", e);
  }
}

async function commitState() {
  sceneVersion += 1;
  await persistState();
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function getHalfExtents(o: SceneObject): Vec3 {
  const s = o.scale;
  switch (o.type) {
    case "box":      return { x: (o.width / 2) * s.x,  y: (o.height / 2) * s.y, z: (o.depth / 2) * s.z };
    case "sphere":   return { x: o.radius * s.x,        y: o.radius * s.y,        z: o.radius * s.z };
    case "cylinder": return { x: o.radius * s.x,        y: (o.height / 2) * s.y,  z: o.radius * s.z };
    case "cone":     return { x: o.radius * s.x,        y: (o.height / 2) * s.y,  z: o.radius * s.z };
    case "plane":    return { x: (o.width / 2) * s.x,   y: 0,                     z: (o.depth / 2) * s.z };
  }
}

function faceOffset(o: SceneObject, face: Face): Vec3 {
  const h = getHalfExtents(o);
  const map: Record<Face, Vec3> = {
    top:    { x: 0,     y: h.y,  z: 0 },
    bottom: { x: 0,     y: -h.y, z: 0 },
    left:   { x: -h.x,  y: 0,    z: 0 },
    right:  { x: h.x,   y: 0,    z: 0 },
    front:  { x: 0,     y: 0,    z: h.z },
    back:   { x: 0,     y: 0,    z: -h.z },
    center: { x: 0,     y: 0,    z: 0 },
  };
  return map[face];
}

// from.position = to.position + offset(face_b on to) - offset(face_a on from)
function computeConnectPos(from: SceneObject, fa: Face, to: SceneObject, fb: Face): Vec3 {
  const a = faceOffset(from, fa);
  const b = faceOffset(to, fb);
  return {
    x: to.position.x + b.x - a.x,
    y: to.position.y + b.y - a.y,
    z: to.position.z + b.z - a.z,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertObject(id: string): SceneObject {
  const obj = sceneState.objects[id];
  if (!obj) throw new Error(`Object "${id}" not found`);
  return obj;
}

function isHexColor(s: string) { return /^#[0-9a-fA-F]{6}$/.test(s); }

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const vec3Schema = z.object({
  x: z.number().describe("X coordinate"),
  y: z.number().describe("Y coordinate"),
  z: z.number().describe("Z coordinate"),
});

const faceSchema = z.enum([
  "top",
  "bottom",
  "left",
  "right",
  "front",
  "back",
  "center",
]);

const commonParamsSchema = z.object({
  name: z.string().describe("Human-readable name for the object"),
  position: vec3Schema.optional().describe("World-space position (default: origin {0,0,0})"),
  scale: vec3Schema.optional().describe("Scale factor per axis (default: {1,1,1})"),
  color: z.string().optional().describe("Hex color e.g. #ff0000 (default: #888888)"),
});

const addObjectSchema = z.object({
  type: z.enum(["box", "sphere", "cylinder", "cone", "plane"]).describe(
    "Geometry type: box, sphere, cylinder, cone, or plane"
  ),
  params: commonParamsSchema.extend({
    // Dimensions (only relevant fields are used based on `type`)
    width: z.number().optional().describe("Width in units — box default 100, plane default 200"),
    height: z.number().optional().describe("Height in units — box/cylinder/cone default 100"),
    depth: z.number().optional().describe("Depth in units — box default 100, plane default 200"),
    radius: z.number().optional().describe("Radius in units — sphere default 50, cylinder/cone default 25"),
  }),
});

const updateObjectSchema = z.object({
  id: z.string().describe("Object ID returned by add_object"),
  params: z.object({
    name: z.string().optional().describe("New name"),
    position: vec3Schema.optional().describe("New world-space position"),
    scale: vec3Schema.optional().describe("New scale factor per axis"),
    color: z.string().optional().describe("New hex color, e.g. #ff0000"),
    // Geometry dims — only apply when the target object type supports the field
    width: z.number().optional().describe("New width (box or plane)"),
    height: z.number().optional().describe("New height (box, cylinder, or cone)"),
    depth: z.number().optional().describe("New depth (box or plane)"),
    radius: z.number().optional().describe("New radius (sphere, cylinder, or cone)"),
  }).describe("Only provided fields are changed."),
});

// ---------------------------------------------------------------------------
// MCPServer
// ---------------------------------------------------------------------------

const server = new MCPServer({
  name: "manifold",
  title: "Manifold 3D Scene Builder",
  version: "1.0.0",
  description: "Build and preview a simple 3D scene",
  baseUrl: process.env.MCP_URL || "http://localhost:3000",
  favicon: "favicon.ico",
  websiteUrl: "https://mcp-use.com",
  icons: [{ src: "icon.svg", mimeType: "image/svg+xml", sizes: ["512x512"] }],
});

// ---------------------------------------------------------------------------
// Tool: get_scene_state
// ---------------------------------------------------------------------------

server.tool(
  {
    name: "get_scene_state",
    description:
      "Show the current scene in the scene widget (and return scene JSON). Changes from other tools are not visible to the user until you call this.",
    schema: z.object({}),
    annotations: { readOnlyHint: true },
    widget: { name: "scene-widget", invoking: "Loading scene...", invoked: "Scene ready" },
  },
  async () => {
    return widget({
      props: { ...sceneState, version: sceneVersion },
      output: object({ ...sceneState, version: sceneVersion }),
    });
  }
);

// ---------------------------------------------------------------------------
// Tool: add_object
// ---------------------------------------------------------------------------

server.tool(
  {
    name: "add_object",
    description: "Add an object to the scene state. Call get_scene_state to show it in the widget.",
    schema: addObjectSchema,
  },
  async ({ type, params }) => {
    const defaultPos: Vec3 = { x: 0, y: 0, z: 0 };
    const defaultScale: Vec3 = { x: 1, y: 1, z: 1 };
    const defaultColor = "#888888";

    const { name, position, scale, color, width, height, depth, radius } = params;

    if (color && !isHexColor(color)) {
      return error(`Invalid color "${color}". Use hex format e.g. #ff0000`);
    }

    const id = nextId();
    const base = {
      id,
      name,
      position: position ?? defaultPos,
      scale: scale ?? defaultScale,
      color: color ?? defaultColor,
    };

    let obj: SceneObject;
    switch (type) {
      case "box":
        obj = { ...base, type: "box", width: width ?? 100, height: height ?? 100, depth: depth ?? 100 };
        break;
      case "sphere":
        obj = { ...base, type: "sphere", radius: radius ?? 50 };
        break;
      case "cylinder":
        obj = { ...base, type: "cylinder", radius: radius ?? 25, height: height ?? 100 };
        break;
      case "cone":
        obj = { ...base, type: "cone", radius: radius ?? 25, height: height ?? 100 };
        break;
      case "plane":
        obj = { ...base, type: "plane", width: width ?? 200, depth: depth ?? 200 };
        break;
    }

    sceneState = {
      ...sceneState,
      objects: { ...sceneState.objects, [id]: obj },
    };
    await commitState();
    return object({ id });
  }
);

// ---------------------------------------------------------------------------
// Tool: update_object
// ---------------------------------------------------------------------------

server.tool(
  {
    name: "update_object",
    description: "Update an object in the scene state. Call get_scene_state to show it in the widget.",
    schema: updateObjectSchema,
  },
  async ({ id, params }) => {
    try {
      const obj = assertObject(id);
      const { name, position, scale, color, width, height, depth, radius } = params;

      if (color && !isHexColor(color)) {
        return error(`Invalid color "${color}". Use hex format e.g. #ff0000`);
      }

      const nextObj: SceneObject = {
        ...obj,
        ...(name !== undefined ? { name } : null),
        ...(position !== undefined ? { position } : null),
        ...(scale !== undefined ? { scale } : null),
        ...(color !== undefined ? { color } : null),
      } as SceneObject;

      // Dimension updates — only apply if field exists on this geometry type
      if (width !== undefined && "width" in nextObj)   (nextObj as { width: number }).width = width;
      if (height !== undefined && "height" in nextObj) (nextObj as { height: number }).height = height;
      if (depth !== undefined && "depth" in nextObj)   (nextObj as { depth: number }).depth = depth;
      if (radius !== undefined && "radius" in nextObj) (nextObj as { radius: number }).radius = radius;

      sceneState = {
        ...sceneState,
        objects: { ...sceneState.objects, [id]: nextObj },
      };
      await commitState();
      return object({ id });
    } catch (e) {
      return error(e instanceof Error ? e.message : String(e));
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: delete_object
// ---------------------------------------------------------------------------

server.tool(
  {
    name: "delete_object",
    description: "Delete an object (and its connections) from the scene state. Call get_scene_state to show it in the widget.",
    schema: z.object({
      id: z.string().describe("Object ID to delete"),
    }),
    annotations: { destructiveHint: true },
  },
  async ({ id }) => {
    try {
      assertObject(id);
      const { [id]: _deleted, ...rest } = sceneState.objects;
      sceneState = {
        objects: rest,
        connections: sceneState.connections.filter((c) => c.from_id !== id && c.to_id !== id),
      };
      await commitState();
      return text(`Deleted object "${id}"`);
    } catch (e) {
      return error(e instanceof Error ? e.message : String(e));
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: connect
// ---------------------------------------------------------------------------

server.tool(
  {
    name: "connect",
    description:
      "Snap one object's face to another (updates position and records a connection). Call get_scene_state to show it in the widget.",
    schema: z.object({
      from_id: z.string().describe("ID of the object to reposition"),
      face_a: faceSchema.describe("Face on the from object"),
      to_id: z.string().describe("ID of the anchor object"),
      face_b: faceSchema.describe("Face on the to object"),
    }),
  },
  async ({ from_id, face_a, to_id, face_b }) => {
    try {
      const fromObj = assertObject(from_id);
      const toObj   = assertObject(to_id);

      const newPos = computeConnectPos(fromObj, face_a, toObj, face_b);
      sceneState = {
        objects: { ...sceneState.objects, [from_id]: { ...fromObj, position: newPos } },
        connections: [...sceneState.connections, { from_id, face_a, to_id, face_b }],
      };
      await commitState();
      return object({ from_id, new_position: newPos });
    } catch (e) {
      return error(e instanceof Error ? e.message : String(e));
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: clear_scene
// ---------------------------------------------------------------------------

server.tool(
  {
    name: "clear_scene",
    description:
      "Clear the entire scene (objects + connections) and reset IDs. Only call if the user explicitly wants to start over.",
    schema: z.object({}),
    annotations: { destructiveHint: true },
  },
  async () => {
    sceneState = { objects: {}, connections: [] };
    idCounter = 1;
    await commitState();
    return text("Scene cleared");
  }
);

// ---------------------------------------------------------------------------
// Tool: execute_code
// ---------------------------------------------------------------------------

server.tool(
  {
    name: "execute_code",
    description:
      "USE WITH CAUTION ONLY WHEN NECESSARY. Run sandboxed JavaScript to batch-edit the scene state (mutate `scene`, then it's merged back). Call get_scene_state to show it in the widget.",
    schema: z.object({
      code: z.string().describe("JavaScript code to execute. Mutate `scene` to change the scene state."),
    }),
  },
  async ({ code }) => {
    try {
      const ctx = vm.createContext({
        scene: structuredClone(sceneState),
        helpers: { getHalfExtents, faceOffset },
      });

      vm.runInContext(code, ctx, { timeout: 1000 });

      // NOTE: Never store "contextified" vm objects in server state. They may not
      // serialize/merge correctly across tool calls. Instead, pull a JSON snapshot
      // out of the vm and parse it back into plain host objects.
      const snapshotJson = vm.runInContext(
        "JSON.stringify({ objects: scene?.objects ?? {}, connections: scene?.connections ?? [] })",
        ctx,
        { timeout: 1000 }
      );

      const snapshot = JSON.parse(String(snapshotJson)) as Partial<SceneState>;
      sceneState = {
        objects: (snapshot.objects ?? {}) as SceneState["objects"],
        connections: Array.isArray(snapshot.connections) ? snapshot.connections : [],
      };
      await commitState();

      return object({
        result: "Code executed successfully",
        object_count: Object.keys(sceneState.objects).length,
        connection_count: sceneState.connections.length,
      });
    } catch (e) {
      return error(e instanceof Error ? e.message : String(e));
    }
  }
);

// ---------------------------------------------------------------------------

await loadPersistedState();
server.listen().then(() => {
  console.log("Manifold 3D Scene Builder running");
});
