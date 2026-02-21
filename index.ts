import { MCPServer, object, text, widget, error } from "mcp-use/server";
import { z } from "zod";
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
function nextId() { return `obj_${idCounter++}`; }

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
  description: "Blender-style 3D scene builder powered by Three.js",
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
    description: "Return the full current scene graph as structured JSON — all objects, their geometry/position/scale/color, and connections",
    schema: z.object({}),
    annotations: { readOnlyHint: true },
    widget: { name: "scene-widget", invoking: "Loading scene...", invoked: "Scene ready" },
  },
  async () => {
    return widget({ props: sceneState, output: object(sceneState) });
  }
);

// ---------------------------------------------------------------------------
// Tool: add_object
// ---------------------------------------------------------------------------

server.tool(
  {
    name: "add_object",
    description: "Add a new 3D object to the scene. Input is { type, params }. Server stores a persistent scene graph and returns the new object id.",
    schema: addObjectSchema,
    widget: { name: "scene-widget", invoking: "Adding object...", invoked: "Object added" },
  },
  async ({ type, params }) => {
    const defaultPos: Vec3 = { x: 0, y: 0, z: 0 };
    const defaultScale: Vec3 = { x: 1, y: 1, z: 1 };
    const defaultColor = "#888888";

    const { name, position, scale, color, width, height, depth, radius } = params;

    if (color && !isHexColor(color)) {
      return widget({
        props: sceneState,
        output: error(`Invalid color "${color}". Use hex format e.g. #ff0000`),
      });
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

    sceneState.objects[id] = obj;
    return widget({ props: sceneState, output: object({ id }) });
  }
);

// ---------------------------------------------------------------------------
// Tool: update_object
// ---------------------------------------------------------------------------

server.tool(
  {
    name: "update_object",
    description: "Update an existing object by id. Input is { id, params } and all params fields are optional.",
    schema: updateObjectSchema,
    widget: { name: "scene-widget", invoking: "Updating object...", invoked: "Object updated" },
  },
  async ({ id, params }) => {
    try {
      const obj = assertObject(id);
      const { name, position, scale, color, width, height, depth, radius } = params;

      if (color && !isHexColor(color)) {
        return widget({
          props: sceneState,
          output: error(`Invalid color "${color}". Use hex format e.g. #ff0000`),
        });
      }

      if (name !== undefined)     obj.name = name;
      if (position !== undefined) obj.position = position;
      if (scale !== undefined)    obj.scale = scale;
      if (color !== undefined)    obj.color = color;

      // Dimension updates — only apply if field exists on this geometry type
      if (width !== undefined && "width" in obj)   (obj as { width: number }).width = width;
      if (height !== undefined && "height" in obj) (obj as { height: number }).height = height;
      if (depth !== undefined && "depth" in obj)   (obj as { depth: number }).depth = depth;
      if (radius !== undefined && "radius" in obj) (obj as { radius: number }).radius = radius;

      sceneState.objects[id] = obj;
      return widget({ props: sceneState, output: object({ id }) });
    } catch (e) {
      return widget({
        props: sceneState,
        output: error(e instanceof Error ? e.message : String(e)),
      });
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: delete_object
// ---------------------------------------------------------------------------

server.tool(
  {
    name: "delete_object",
    description: "Remove an object from the scene by ID. Also removes any connections referencing this object.",
    schema: z.object({
      id: z.string().describe("Object ID to delete"),
    }),
    annotations: { destructiveHint: true },
    widget: { name: "scene-widget", invoking: "Deleting object...", invoked: "Object deleted" },
  },
  async ({ id }) => {
    try {
      assertObject(id);
      delete sceneState.objects[id];
      sceneState.connections = sceneState.connections.filter(
        (c) => c.from_id !== id && c.to_id !== id
      );
      return widget({ props: sceneState, output: text(`Deleted object "${id}"`) });
    } catch (e) {
      return widget({
        props: sceneState,
        output: error(e instanceof Error ? e.message : String(e)),
      });
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: connect
// ---------------------------------------------------------------------------

server.tool(
  {
    name: "connect",
    description: "Snap one object's face to another object's face. The `from` object is repositioned so that face_a touches face_b of the `to` object.",
    schema: z.object({
      from_id: z.string().describe("ID of the object to reposition"),
      face_a: faceSchema.describe("Face on the from object"),
      to_id: z.string().describe("ID of the anchor object"),
      face_b: faceSchema.describe("Face on the to object"),
    }),
    widget: { name: "scene-widget", invoking: "Connecting objects...", invoked: "Connected" },
  },
  async ({ from_id, face_a, to_id, face_b }) => {
    try {
      const fromObj = assertObject(from_id);
      const toObj   = assertObject(to_id);

      const newPos = computeConnectPos(fromObj, face_a, toObj, face_b);
      sceneState.objects[from_id] = { ...fromObj, position: newPos };
      sceneState.connections.push({ from_id, face_a, to_id, face_b });

      return widget({ props: sceneState, output: object({ from_id, new_position: newPos }) });
    } catch (e) {
      return widget({
        props: sceneState,
        output: error(e instanceof Error ? e.message : String(e)),
      });
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: clear_scene
// ---------------------------------------------------------------------------

server.tool(
  {
    name: "clear_scene",
    description: "Remove all objects and connections from the scene and reset the ID counter",
    schema: z.object({}),
    annotations: { destructiveHint: true },
    widget: { name: "scene-widget", invoking: "Clearing scene...", invoked: "Scene cleared" },
  },
  async () => {
    sceneState = { objects: {}, connections: [] };
    idCounter = 1;
    return widget({ props: sceneState, output: text("Scene cleared") });
  }
);

// ---------------------------------------------------------------------------
// Tool: execute_code
// ---------------------------------------------------------------------------

server.tool(
  {
    name: "execute_code",
    description: "Escape hatch. Run JavaScript against the scene graph in a sandboxed vm (disabled by default). The sandbox exposes `scene` (a deep copy of the current state) and `helpers` ({ getHalfExtents, faceOffset }). Mutate `scene.objects` or `scene.connections` and the changes are merged back.",
    schema: z.object({
      code: z.string().describe("JavaScript code to execute. Mutate `scene` to change the scene state."),
    }),
    widget: { name: "scene-widget", invoking: "Running code...", invoked: "Code executed" },
  },
  async ({ code }) => {
    if (process.env.ENABLE_EXECUTE_CODE !== "true") {
      return widget({
        props: sceneState,
        output: error(
          "execute_code is disabled by default. Set ENABLE_EXECUTE_CODE=true to enable it (not recommended for production)."
        ),
      });
    }

    const ctx = vm.createContext({
      scene: structuredClone(sceneState),
      helpers: { getHalfExtents, faceOffset },
    });

    try {
      vm.runInContext(code, ctx, { timeout: 1000 });
      // Merge only the allowlisted fields back into sceneState
      sceneState = {
        objects: ctx.scene.objects ?? sceneState.objects,
        connections: ctx.scene.connections ?? sceneState.connections,
      };
      return widget({ props: sceneState, output: object({ result: "Code executed successfully" }) });
    } catch (e) {
      return widget({
        props: sceneState,
        output: error(e instanceof Error ? e.message : String(e)),
      });
    }
  }
);

// ---------------------------------------------------------------------------

server.listen().then(() => {
  console.log("Manifold 3D Scene Builder running");
});
