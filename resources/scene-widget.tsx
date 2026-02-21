import { useEffect, useRef, useState } from "react";
import { McpUseProvider, useWidget, type WidgetMetadata } from "mcp-use/react";
import { z } from "zod";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });

const sceneObjectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("box"),      id: z.string(), name: z.string(), position: vec3Schema, scale: vec3Schema, color: z.string(), width: z.number(), height: z.number(), depth: z.number() }),
  z.object({ type: z.literal("sphere"),   id: z.string(), name: z.string(), position: vec3Schema, scale: vec3Schema, color: z.string(), radius: z.number() }),
  z.object({ type: z.literal("cylinder"), id: z.string(), name: z.string(), position: vec3Schema, scale: vec3Schema, color: z.string(), radius: z.number(), height: z.number() }),
  z.object({ type: z.literal("cone"),     id: z.string(), name: z.string(), position: vec3Schema, scale: vec3Schema, color: z.string(), radius: z.number(), height: z.number() }),
  z.object({ type: z.literal("plane"),    id: z.string(), name: z.string(), position: vec3Schema, scale: vec3Schema, color: z.string(), width: z.number(), depth: z.number() }),
]);

const faceSchema = z.enum([
  "top",
  "bottom",
  "left",
  "right",
  "front",
  "back",
  "center",
]);

const propsSchema = z.object({
  objects: z.record(z.string(), sceneObjectSchema),
  connections: z.array(z.object({
    from_id: z.string(),
    face_a: faceSchema,
    to_id: z.string(),
    face_b: faceSchema,
  })),
});

export const widgetMetadata: WidgetMetadata = {
  description: "Interactive Three.js 3D scene — controlled by Claude",
  props: propsSchema,
  exposeAsTool: false,
  metadata: { prefersBorder: false },
};

type Props = z.infer<typeof propsSchema>;
type SceneObject = z.infer<typeof sceneObjectSchema>;
type WidgetState = { selectedObjectId?: string };

// ---------------------------------------------------------------------------
// Geometry factory
// ---------------------------------------------------------------------------

function makeGeometry(obj: SceneObject): THREE.BufferGeometry {
  switch (obj.type) {
    case "box":      return new THREE.BoxGeometry(obj.width, obj.height, obj.depth);
    case "sphere":   return new THREE.SphereGeometry(obj.radius, 32, 32);
    case "cylinder": return new THREE.CylinderGeometry(obj.radius, obj.radius, obj.height, 32);
    case "cone":     return new THREE.ConeGeometry(obj.radius, obj.height, 32);
    case "plane":    { const g = new THREE.PlaneGeometry(obj.width, obj.depth); g.rotateX(-Math.PI / 2); return g; }
  }
}

// ---------------------------------------------------------------------------
// Widget component
// ---------------------------------------------------------------------------

export default function SceneWidget() {
  const { props, isPending, state, setState, sendFollowUpMessage } =
    useWidget<Props, WidgetState>();

  // In the Inspector, the widget can mount before any tool has ever provided props.
  // Treat missing/partial props as an empty scene to avoid crashing.
  const safeObjects = (props as Props | undefined)?.objects ?? {};
  const safeConnections = (props as Props | undefined)?.connections ?? [];

  // Refs for Three.js objects that persist across renders
  const mountRef     = useRef<HTMLDivElement>(null);
  const rendererRef  = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef    = useRef<THREE.PerspectiveCamera | null>(null);
  const sceneRef     = useRef<THREE.Scene | null>(null);
  const controlsRef  = useRef<OrbitControls | null>(null);
  const labelRendRef = useRef<CSS2DRenderer | null>(null);
  const rafRef       = useRef<number>(0);
  const meshMapRef   = useRef<Record<string, THREE.Mesh>>({});
  const propsRef     = useRef<Props | null>(null);
  // Track whether we've already auto-fit this scene; reset when scene clears
  const hasFitRef    = useRef<boolean>(false);

  // Local selection state (mirrors state.selectedObjectId)
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Fit camera to current scene meshes bounding box
  function fitCamera() {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    const meshes = Object.values(meshMapRef.current);
    if (meshes.length === 0) return;

    const box = new THREE.Box3();
    for (const mesh of meshes) box.expandByObject(mesh);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fovRad = camera.fov * (Math.PI / 180);
    // Distance needed so the scene fits in the vertical FOV, with padding
    const dist = Math.abs(maxDim / 2 / Math.tan(fovRad / 2)) * 1.8;

    const camPos = {
      x: center.x + dist * 0.5,
      y: center.y + dist * 0.4,
      z: center.z + dist * 0.8,
    };
    camera.position.set(camPos.x, camPos.y, camPos.z);
    controls.target.copy(center);
    controls.update();
    camera.updateProjectionMatrix();
    console.log("[scene-widget] fitCamera — center:", center, "| size:", size, "| maxDim:", maxDim.toFixed(1), "| dist:", dist.toFixed(1), "| camPos:", camPos);
  }

  // -------------------------------------------------------------------------
  // Init effect — runs once on mount
  // -------------------------------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const w = mount.clientWidth  || mount.offsetWidth  || 500;
    const h = mount.clientHeight || mount.offsetHeight || 500;
    console.log("[scene-widget] init — mount size:", w, "x", h);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    renderer.shadowMap.enabled = true;
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);
    sceneRef.current = scene;
    console.log("[scene-widget] scene + renderer ready");

    // Camera
    const camera = new THREE.PerspectiveCamera(60, w / h, 1, 10000);
    camera.position.set(0, 200, 500);
    cameraRef.current = camera;

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(200, 400, 300);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // Grid helper
    const grid = new THREE.GridHelper(1000, 20, 0x444444, 0x333333);
    scene.add(grid);

    // OrbitControls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controlsRef.current = controls;

    // CSS2DRenderer for labels
    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(w, h);
    labelRenderer.domElement.style.position = "absolute";
    labelRenderer.domElement.style.top = "0";
    labelRenderer.domElement.style.left = "0";
    labelRenderer.domElement.style.pointerEvents = "none";
    mount.appendChild(labelRenderer.domElement);
    labelRendRef.current = labelRenderer;

    // Resize observer
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        renderer.setSize(width, height);
        labelRenderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
    });
    observer.observe(mount);

    // Animation loop
    function animate() {
      rafRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    }
    animate();

    // Raycaster for clicks
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    function onClick(e: MouseEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
      mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(scene.children, true);

      // Find first hit that has an id in userData
      for (const hit of hits) {
        let obj: THREE.Object3D | null = hit.object;
        while (obj) {
          if (obj.userData.id) {
            const id = obj.userData.id as string;
            const sceneObj = propsRef.current?.objects[id];
            if (sceneObj) {
              setSelectedId(id);
              setState((prev) => ({ ...(prev ?? {}), selectedObjectId: id }));
              sendFollowUpMessage(`I clicked on "${sceneObj.name}" (id: ${id}, type: ${sceneObj.type})`);
            }
            return;
          }
          obj = obj.parent;
        }
      }
    }

    renderer.domElement.addEventListener("click", onClick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      observer.disconnect();
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      renderer.dispose();
      labelRenderer.domElement.remove();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // -------------------------------------------------------------------------
  // Rebuild effect — runs when props change (after isPending resolves)
  // -------------------------------------------------------------------------
  useEffect(() => {
    console.log("[scene-widget] rebuild effect — isPending:", isPending, "| objects:", Object.keys(safeObjects).length, "| sceneReady:", !!sceneRef.current);
    if (isPending) return;
    const scene = sceneRef.current;
    if (!scene) return;

    // Make the latest props visible to the click handler
    propsRef.current = { objects: safeObjects, connections: safeConnections };

    // Remove old meshes and labels
    for (const id of Object.keys(meshMapRef.current)) {
      const mesh = meshMapRef.current[id];
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        for (const m of mesh.material) m.dispose();
      } else {
        mesh.material.dispose();
      }
      // Remove label children
      for (const c of [...mesh.children]) {
        if (c instanceof CSS2DObject) {
          c.element?.remove?.();
          mesh.remove(c);
        }
      }
      scene.remove(mesh);
    }
    // Remove old connection lines
    scene.children
      .filter((c) => c.userData.isConnection)
      .forEach((c) => {
        if (c instanceof THREE.Line) {
          c.geometry.dispose();
          if (Array.isArray(c.material)) {
            for (const m of c.material) m.dispose();
          } else {
            c.material.dispose();
          }
        }
        scene.remove(c);
      });
    meshMapRef.current = {};

    // Add objects
    for (const [id, obj] of Object.entries(safeObjects)) {
      const geo = makeGeometry(obj);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(obj.color),
        roughness: 0.6,
        metalness: 0.1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(obj.position.x, obj.position.y, obj.position.z);
      mesh.scale.set(obj.scale.x, obj.scale.y, obj.scale.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.id = id;

      // Label
      const labelDiv = document.createElement("div");
      labelDiv.textContent = obj.name;
      labelDiv.style.cssText = [
        "color: white",
        "background: rgba(0,0,0,0.6)",
        "padding: 2px 6px",
        "border-radius: 4px",
        "font-size: 11px",
        "font-family: monospace",
        "pointer-events: none",
        "white-space: nowrap",
      ].join(";");

      // Compute label offset based on geometry type
      let labelY = 0;
      switch (obj.type) {
        case "box":      labelY = (obj.height / 2) * obj.scale.y + 10; break;
        case "sphere":   labelY = obj.radius * obj.scale.y + 10; break;
        case "cylinder": labelY = (obj.height / 2) * obj.scale.y + 10; break;
        case "cone":     labelY = (obj.height / 2) * obj.scale.y + 10; break;
        case "plane":    labelY = 15; break;
      }

      const label = new CSS2DObject(labelDiv);
      label.position.set(0, labelY, 0);
      mesh.add(label);

      scene.add(mesh);
      meshMapRef.current[id] = mesh;
    }
    console.log("[scene-widget] meshes built:", Object.keys(meshMapRef.current).length);

    // Highlight selected object
    for (const [id, mesh] of Object.entries(meshMapRef.current)) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.emissive.set(id === (state?.selectedObjectId ?? selectedId) ? 0x334455 : 0x000000);
    }

    // Draw connections (center-to-center lines)
    for (const conn of safeConnections) {
      const fromMesh = meshMapRef.current[conn.from_id];
      const toMesh   = meshMapRef.current[conn.to_id];
      if (!fromMesh || !toMesh) continue;

      const points = [fromMesh.position.clone(), toMesh.position.clone()];
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.5, transparent: true });
      const line = new THREE.Line(lineGeo, lineMat);
      line.userData.isConnection = true;
      scene.add(line);
    }

    // Auto-fit camera: fire once when scene first gets objects, reset when it empties
    const hasMeshes = Object.keys(meshMapRef.current).length > 0;
    if (hasMeshes && !hasFitRef.current) {
      // Force matrixWorld update so Box3.expandByObject gets correct world positions
      scene.updateMatrixWorld(true);
      fitCamera();
      hasFitRef.current = true;
    } else if (!hasMeshes) {
      hasFitRef.current = false;
    }
  }, [isPending, props]);

  // Sync selected highlight when state changes externally
  useEffect(() => {
    for (const [id, mesh] of Object.entries(meshMapRef.current)) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.emissive.set(id === (state?.selectedObjectId ?? selectedId) ? 0x334455 : 0x000000);
    }
  }, [state?.selectedObjectId, selectedId]);

  const objectList = Object.values(safeObjects);
  const activeId = state?.selectedObjectId ?? selectedId;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <McpUseProvider autoSize>
      <div style={{ display: "flex", height: 500, width: "100%", fontFamily: "monospace", overflow: "hidden" }}>
        {/* Three.js canvas container */}
        <div
          ref={mountRef}
          style={{ flex: 1, position: "relative", overflow: "hidden", background: "#1a1a2e" }}
        >
          {isPending && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "white", zIndex: 10 }}>
              <p style={{ fontFamily: "monospace" }}>Building scene...</p>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div style={{
          width: 200,
          background: "#111122",
          color: "#ccc",
          overflowY: "auto",
          borderLeft: "1px solid #333",
          display: "flex",
          flexDirection: "column",
        }}>
          <div style={{ padding: "8px 12px", background: "#0d0d1e", borderBottom: "1px solid #333", fontSize: 12, color: "#888", letterSpacing: "0.05em", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>OBJECTS ({objectList.length})</span>
            {objectList.length > 0 && (
              <button
                onClick={fitCamera}
                title="Fit camera to scene"
                style={{ background: "none", border: "1px solid #444", color: "#aaa", fontSize: 10, padding: "2px 6px", borderRadius: 3, cursor: "pointer" }}
              >
                Fit
              </button>
            )}
          </div>

          {objectList.length === 0 && (
            <div style={{ padding: 12, fontSize: 11, color: "#555", textAlign: "center" }}>
              No objects yet
            </div>
          )}

          {objectList.map((obj) => (
            <div
              key={obj.id}
              onClick={() => {
                setSelectedId(obj.id);
            setState((prev) => ({ ...(prev ?? {}), selectedObjectId: obj.id }));
                sendFollowUpMessage(`I selected "${obj.name}" (id: ${obj.id}, type: ${obj.type}) from the sidebar`);
              }}
              style={{
                padding: "8px 12px",
                cursor: "pointer",
                borderBottom: "1px solid #1e1e33",
                background: activeId === obj.id ? "#1e2a3a" : "transparent",
                display: "flex",
                alignItems: "center",
                gap: 8,
                transition: "background 0.15s",
              }}
            >
              {/* Color swatch */}
              <span style={{
                width: 10, height: 10, borderRadius: "50%",
                background: obj.color, flexShrink: 0,
                border: "1px solid rgba(255,255,255,0.2)",
              }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: "#eee", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {obj.name}
                </div>
                <div style={{ fontSize: 10, color: "#666" }}>
                  {obj.type} · {obj.id}
                </div>
              </div>
            </div>
          ))}

          {/* Connections section */}
          {safeConnections.length > 0 && (
            <>
              <div style={{ padding: "8px 12px", background: "#0d0d1e", borderBottom: "1px solid #333", borderTop: "1px solid #333", fontSize: 12, color: "#888", letterSpacing: "0.05em", marginTop: "auto" }}>
                CONNECTIONS ({safeConnections.length})
              </div>
              {safeConnections.map((conn, i) => {
                const fromObj = safeObjects[conn.from_id];
                const toObj   = safeObjects[conn.to_id];
                return (
                  <div key={i} style={{ padding: "6px 12px", borderBottom: "1px solid #1e1e33", fontSize: 10, color: "#666" }}>
                    {fromObj?.name ?? conn.from_id}.{conn.face_a} → {toObj?.name ?? conn.to_id}.{conn.face_b}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </McpUseProvider>
  );
}
