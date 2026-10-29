# Splat Viewer: Build Guide

How to build the Gaussian splat (3DGS) viewer in this folder from scratch. It is a web page that:

- loads splat scenes (`.ply`, `.spz`, `.splat`, `.ksplat`, `.sog`) by drag-and-drop, file picker or URL
- shows them with orbit, fly and **walk** cameras
- has a **Colors** panel that matches SuperSplat's colour grading
- uses a **collision mesh** so you can walk inside a room without going through walls or floors
- **generates that collision mesh** with PlayCanvas `splat-transform`, from a button in the viewer or from the command line

> **Engine note:** the viewer renders with [Spark](https://sparkjs.dev) on top of [three.js](https://threejs.org), **not PlayCanvas**. Only the collision mesh tooling comes from PlayCanvas (`@playcanvas/splat-transform`), and the `.collision.glb` files it makes also work in PlayCanvas's [SuperSplat Viewer](https://github.com/playcanvas/supersplat-viewer).

---

## 1. Requirements

| Need | Version | Why |
|---|---|---|
| Node.js | 20 or newer (tested on 22) | Vite, splat-transform |
| A modern browser | Chrome / Edge / Firefox | WebGL2 |
| A GPU adapter Node can use | any; a software one (llvmpipe) works | splat-transform voxelizes on the GPU; there is no CPU path |

---

## 2. Create the project

```sh
mkdir splat-viewer && cd splat-viewer
npm init -y
npm install three @sparkjsdev/spark three-mesh-bvh
npm install -D vite @playcanvas/splat-transform
```

| Package | Role |
|---|---|
| `three` | Scene, camera, controls, glTF loading |
| `@sparkjsdev/spark` | Gaussian splat rendering for three.js (`SplatMesh`, `SparkRenderer`, `dyno` shader graph) |
| `three-mesh-bvh` | Fast collision queries against the collision mesh (capsule vs triangles, raycasts) |
| `vite` | Dev server and build; also hosts the collision generation endpoint |
| `@playcanvas/splat-transform` | PlayCanvas's tool that turns a splat into a voxel grid and a `.collision.glb` |

Then create the files below.

```
splat-viewer/
├── package.json
├── vite.config.js
├── index.html            # page layout and side panel
├── src/
│   ├── main.js           # app: renderer, loading, cameras, UI wiring
│   ├── style.css         # panel styling
│   ├── color-grade.js    # SuperSplat colour grade as a Spark shader modifier
│   └── collision.js      # collision mesh loading and the Walk controller
└── tools/
    ├── collision.js          # runs splat-transform to make a collision mesh
    ├── make-collision.js     # `npm run collision` command line
    └── collision-plugin.js   # Vite plugin: POST /api/collision for the viewer button
```

---

## 3. How it works

### 3.1 Rendering (`src/main.js`)

- A `THREE.WebGLRenderer` draws the scene. A `SparkRenderer` is added to the scene so Spark can sort and draw splats.
- `sortRadial: false` sorts splats by depth, as SuperSplat and PlayCanvas do, instead of Spark's default radial sort.
- Each scene is a `SplatMesh` created with `extSplats: true`, which keeps full-precision data. Spark's default 16-byte packing visibly loses detail.
- **Flip upside-down** rotates the mesh 180° about X. Most COLMAP/INRIA training outputs are Y-down.
- After loading, the camera is fitted to the splat's bounding box.

### 3.2 Colour grading (`src/color-grade.js`)

This is a port of SuperSplat's colour grade (`src/color-grade.ts` in `playcanvas/supersplat`), so the same slider values give the same look.

The seven controls (tint, temperature, saturation, brightness, black point, white point, transparency) combine into one **3×3 colour matrix plus an offset**, plus an alpha multiplier `exp(transparency)`:

```
range  = 1 / (whitePoint − blackPoint)
scale  = range · tint · (1 + temperature, 1, 1 − temperature)
matrix = (sat·I + (1 − sat)·1·LUMAᵀ) · diag(scale)     LUMA = (0.299, 0.587, 0.114)
offset = brightness − blackPoint
```

It runs on the GPU as a Spark **world modifier** (a small GLSL `Dyno` node). That node runs after Spark has evaluated each splat's view-dependent colour (spherical harmonics), which is the same point where SuperSplat applies its grade. Moving a slider updates the uniforms and calls `mesh.updateVersion()`.

### 3.3 Coordinate spaces

This matters when loading collision meshes and typing seed or spawn points:

| Space | Used by | Relation |
|---|---|---|
| **PLY space** | the raw file; Spark renders it as-is | — |
| **PlayCanvas / SuperSplat space** | SuperSplat editor, `splat-transform` outputs, `--seed-pos`, the viewer's `?spawn=` | PLY rotated 180° about **Z**: `(x, y, z) → (−x, −y, z)` |
| **Viewer world space** | what you see | PLY space × the splat's transform (Flip = 180° about **X**) |

So a collision mesh or point from PlayCanvas goes into the viewer through `splatMatrix × rotZ(180°)`; that's `PC_TO_PLY` in `src/collision.js`.

### 3.4 Collision and Walk mode (`src/collision.js`)

- `loadCollisionGeometry()` loads the `.glb`, merges all its meshes into one position-only geometry, and keeps it in PlayCanvas space.
- `Walker.setCollider()` moves that geometry into viewer space and builds a `MeshBVH`.
- The player is a **capsule**, 1.6 m tall with a 0.2 m radius, matching splat-transform's default `--voxel-carve 1.6,0.2`. Each frame runs 5 sub-steps of: apply gravity, move, `bvh.shapecast()` the capsule against nearby triangles, push it out along the contact direction. It counts as **on the ground** when the push-out is mostly upward.
- **Spawn** (`findSpawn`):
  - With a start point, it drops straight down from it to the floor.
  - Without one, it samples a grid around the middle of the mesh, keeps spots with head room and clear space around them, and picks the lowest floor nearest the centre. That stops you spawning on a table.
- Controls: click to capture the mouse (Esc releases it), WASD or arrow keys to move, Shift to run, Space to jump.

### 3.5 Collision mesh generation (`tools/`)

`splat-transform` builds a voxel grid from the splats and turns it into a mesh:

| Step | Flag | What it does |
|---|---|---|
| Cluster filter | `--filter-cluster` | Drops floaters not connected to the scene at the seed |
| Voxelize | `--voxel-size 0.05 --voxel-opacity 0.1` | Marks voxels the splats make solid |
| Exterior fill (rooms) | `--voxel-external-fill` | Seals everything outside the room; skipped if the seed can "see" outside through a hole |
| Floor fill (outdoor) | `--voxel-floor-fill` | Fills the ground below surfaces |
| Carve | `--voxel-carve 1.6,0.2` | Flood-fills from the seed with the player capsule; only reachable space stays walkable |
| Mesh | `--collision-mesh smooth` | Writes `<name>.collision.glb` |

`tools/collision.js` wraps the CLI with the following safety measures:

- **No shell:** arguments are passed as a list, never through a shell, and are validated as numbers or fixed keywords.
- **Empty results are errors:** an old `.glb` is deleted first, so a run that produces nothing can't be mistaken for success.
- **GPU fallback:** if the default GPU gives no mesh, it retries on the **software GPU (llvmpipe)**. Some drivers, such as Intel integrated graphics on Linux, silently voxelize large scenes to nothing.

The Vite plugin exposes this as `POST /api/collision` for the viewer's button. It streams splat-transform's log back, then the `.glb` as base64. It only exists under `npm run dev` / `npm run preview`.

---

## 4. Source files

### `package.json`

```json
{
  "name": "spark-3dgs-viewer",
  "version": "1.0.0",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "collision": "node tools/make-collision.js"
  },
  "dependencies": {
    "@sparkjsdev/spark": "^2.3.1",
    "three": "^0.186.1",
    "three-mesh-bvh": "^0.9.16"
  },
  "devDependencies": {
    "@playcanvas/splat-transform": "^3.10.1",
    "vite": "^8.3.2"
  },
  "type": "module",
  "private": true
}
```

### `vite.config.js`

```js
import { defineConfig } from "vite";
import collisionPlugin from "./tools/collision-plugin.js";

export default defineConfig({
  // POST /api/collision: generate a collision mesh with splat-transform (dev/preview only).
  plugins: [collisionPlugin()],
  // Spark ships inline workers + wasm; pre-bundling can break them.
  optimizeDeps: { exclude: ["@sparkjsdev/spark"] },
  build: { target: "es2022" },
  // Listen on all interfaces so other devices on the LAN can connect.
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
```

### `index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Splat Viewer</title>
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body>
    <canvas id="canvas"></canvas>

    <aside id="panel">
      <h1>Splat Viewer</h1>

      <label class="drop" id="drop">
        <input type="file" id="file" accept=".ply,.spz,.splat,.ksplat,.sog,.zip,.rad" hidden />
        <strong>Open a splat file</strong>
        <span>or drop it anywhere</span>
        <small>.ply · .spz · .splat · .ksplat · .sog</small>
      </label>

      <form id="url-form">
        <input type="url" id="url" placeholder="…or paste a URL" />
        <button type="submit">Load</button>
      </form>

      <div id="status" hidden>
        <div class="bar"><div id="bar-fill"></div></div>
        <p id="status-text"></p>
      </div>

      <dl id="info" hidden>
        <dt>File</dt><dd id="info-name"></dd>
        <dt>Splats</dt><dd id="info-count"></dd>
        <dt>Size</dt><dd id="info-size"></dd>
      </dl>

      <fieldset id="controls" disabled>
        <label><input type="checkbox" id="flip" checked /> Flip upside-down (Y-down scans)</label>
        <label class="range">
          Sharpness <output id="sharpness-value">1.0</output>
          <input type="range" id="sharpness" min="1" max="2" step="0.1" value="1" />
        </label>
        <label><input type="checkbox" id="radial" /> Radial sort (steadier while rotating)</label>
        <label><input type="checkbox" id="autorotate" /> Auto-rotate</label>
        <label>
          Camera mode
          <select id="mode">
            <option value="orbit">Orbit</option>
            <option value="fly">Fly (WASD + drag)</option>
            <option value="walk">Walk (collision)</option>
          </select>
        </label>
        <button type="button" id="reset">Reset view</button>
      </fieldset>

      <details id="collision" open>
        <summary>Collision</summary>
        <div class="collision-body">
          <fieldset id="generate" disabled>
            <label>
              Scene type
              <select id="gen-mode">
                <option value="room">Room / interior</option>
                <option value="outdoor">Outdoor / open</option>
              </select>
            </label>
            <label>
              Detail
              <select id="gen-voxel">
                <option value="0.1">Coarse (10 cm, fast)</option>
                <option value="0.05" selected>Normal (5 cm)</option>
                <option value="0.025">Fine (2.5 cm, slow)</option>
              </select>
            </label>
            <button type="button" id="gen-run">Generate collision mesh</button>
            <small class="muted">Uses the start point (or where the camera is now) as a point inside the walkable space. Fly inside the room first.</small>
          </fieldset>
          <label class="file-button">
            <input type="file" id="collision-file" accept=".glb" hidden />
            Load collision mesh (.glb)
          </label>
          <small id="collision-name" class="muted">None</small>
          <a id="collision-download" class="muted" hidden>Download .collision.glb</a>
          <label><input type="checkbox" id="show-collision" /> Show collision mesh</label>
          <button type="button" id="set-start">Set start point here</button>
          <small id="start-pos" class="muted">Start: centre of collision mesh</small>
        </div>
      </details>

      <details id="colors">
        <summary>Colors</summary>
        <fieldset id="color-controls" disabled>
          <label class="color-row">Tint <input type="color" id="c-tint" value="#ffffff" /></label>
          <label class="range">Temperature <output></output>
            <input type="range" id="c-temperature" min="-0.5" max="0.5" step="0.01" value="0" /></label>
          <label class="range">Saturation <output></output>
            <input type="range" id="c-saturation" min="0" max="2" step="0.01" value="1" /></label>
          <label class="range">Brightness <output></output>
            <input type="range" id="c-brightness" min="-1" max="1" step="0.01" value="0" /></label>
          <label class="range">Black Point <output></output>
            <input type="range" id="c-blackPoint" min="0" max="1" step="0.01" value="0" /></label>
          <label class="range">White Point <output></output>
            <input type="range" id="c-whitePoint" min="0" max="1" step="0.01" value="1" /></label>
          <label class="range">Transparency <output></output>
            <input type="range" id="c-transparency" min="-6" max="6" step="0.01" value="0" /></label>
          <button type="button" id="c-reset">Reset colors</button>
        </fieldset>
      </details>

      <p class="hint" id="hint">Orbit: drag to rotate · right-drag to pan · scroll to zoom</p>
    </aside>

    <div id="drop-overlay" hidden>Drop to load</div>

    <script type="module" src="/src/main.js"></script>
  </body>
</html>
```

### `src/style.css`

```css
:root {
  --bg: #0e0f12;
  --panel: rgba(22, 24, 29, 0.88);
  --border: rgba(255, 255, 255, 0.1);
  --text: #e8e9ec;
  --muted: #8b8f98;
  --accent: #ff6a3d;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--text);
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  height: 100%;
  overflow: hidden;
  background: var(--bg);
}

#canvas {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  outline: none;
}

#panel {
  position: fixed;
  top: 16px;
  left: 16px;
  width: 280px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  padding: 16px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  backdrop-filter: blur(8px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
}

h1 { margin: 0; font-size: 15px; font-weight: 600; }

.drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 18px 12px;
  border: 1.5px dashed var(--border);
  border-radius: 10px;
  cursor: pointer;
  text-align: center;
  transition: border-color 0.15s, background 0.15s;
}
.drop:hover { border-color: var(--accent); background: rgba(255, 106, 61, 0.06); }
.drop span, .drop small { color: var(--muted); }
.drop small { font-size: 11px; margin-top: 4px; }

#url-form { display: flex; gap: 6px; }

input[type="url"], select {
  flex: 1;
  min-width: 0;
  padding: 7px 9px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--text);
  font: inherit;
}

button {
  padding: 7px 12px;
  background: var(--accent);
  border: 0;
  border-radius: 7px;
  color: #fff;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}
button:disabled, fieldset:disabled button { opacity: 0.4; cursor: default; }

.bar { height: 4px; background: rgba(255, 255, 255, 0.08); border-radius: 2px; overflow: hidden; }
#bar-fill { height: 100%; width: 0; background: var(--accent); transition: width 0.1s; }
#bar-fill.indeterminate { width: 30%; animation: slide 1s ease-in-out infinite alternate; }
@keyframes slide { from { margin-left: 0; } to { margin-left: 70%; } }
#status-text { margin: 6px 0 0; color: var(--muted); }
#status.error #status-text { color: #ff6b6b; }

#info {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: 0;
}
#info dt { color: var(--muted); }
#info dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
fieldset:disabled { opacity: 0.5; }
fieldset label { display: flex; align-items: center; gap: 8px; }
fieldset label.range { flex-wrap: wrap; }
fieldset label.range output { margin-left: auto; color: var(--muted); }
fieldset label.range input { width: 100%; accent-color: var(--accent); }

#colors summary, #collision summary { cursor: pointer; font-weight: 600; }
#colors[open] summary, #collision[open] summary { margin-bottom: 10px; }
.collision-body { display: flex; flex-direction: column; gap: 8px; }
.collision-body label { display: flex; align-items: center; gap: 8px; }
.muted { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.file-button {
  justify-content: center;
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  cursor: pointer;
}
.file-button:hover { border-color: var(--accent); }
#collision-download { color: var(--accent); cursor: pointer; }
#collision-download[hidden] { display: none; }
.color-row input[type="color"] {
  margin-left: auto;
  width: 44px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: none;
  cursor: pointer;
}

.hint { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.5; }

#drop-overlay {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(255, 106, 61, 0.12);
  border: 3px dashed var(--accent);
  font-size: 22px;
  font-weight: 600;
  pointer-events: none;
}
#drop-overlay[hidden], #status[hidden], #info[hidden] { display: none; }
```

### `src/main.js`

```js
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SparkControls, SplatMesh } from "@sparkjsdev/spark";
import { ColorGrade, NEUTRAL } from "./color-grade.js";
import { Walker, EYE_HEIGHT, PC_TO_PLY, loadCollisionGeometry } from "./collision.js";

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");

// --- Scene setup -----------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x0e0f12);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
camera.position.set(0, 0, 3);

// Match SuperSplat/PlayCanvas more closely: depth sort (how most scenes are trained)
// instead of Spark's default radial sort. Sharpness is tunable from the panel.
const spark = new SparkRenderer({ renderer, sortRadial: false });
scene.add(spark);

const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.autoRotateSpeed = 1.5;

const fly = new SparkControls({ canvas });
const walker = new Walker(camera, canvas);
let mode = "orbit";

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
  timer.update();
  const dt = timer.getDelta();
  if (mode === "orbit") orbit.update();
  else if (mode === "walk") walker.update(dt);
  else fly.update(camera);
  renderer.render(scene, camera);
});

// --- Loading ---------------------------------------------------------------

let current = null;
let loadId = 0;
let homeView = null;
let currentSource = null; // { fileBytes | url, fileName } of the loaded scene
let collisionGeometry = null; // merged collision mesh, PlayCanvas/SuperSplat space
// Start point in PlayCanvas/SuperSplat space (same coordinates as splat-transform's --seed-pos).
let startPoint = parseVec(new URLSearchParams(location.search).get("spawn"));
const grade = new ColorGrade();

async function loadSplat({ fileBytes, url, fileName, size }) {
  const id = ++loadId;
  showStatus(`Loading ${fileName}…`, null);
  $("controls").disabled = true;
  $("generate").disabled = true;
  $("color-controls").disabled = true;

  if (current) {
    scene.remove(current);
    current.dispose();
    current = null;
  }

  try {
    const mesh = new SplatMesh({
      fileBytes,
      url,
      fileName,
      // Full-precision splats (float32 centers, finer color/scale/SH) instead of Spark's
      // default 16-byte packed encoding, which visibly loses detail vs SuperSplat.
      extSplats: true,
      // SuperSplat-style colour grade (Colors panel), applied to the final view-dependent colour.
      worldModifier: grade.modifier,
      onProgress: (e) => {
        if (id !== loadId) return;
        if (e.lengthComputable && e.total > 0) {
          showStatus(`Downloading ${fileName}… ${Math.round((e.loaded / e.total) * 100)}%`, e.loaded / e.total);
        }
      },
    });
    applyFlip(mesh);
    scene.add(mesh);
    current = mesh;

    if (fileBytes) showStatus(`Decoding ${fileName}…`, null);
    await mesh.initialized;
    if (id !== loadId) return; // superseded by a newer load

    hideStatus();
    showInfo(fileName, mesh.numSplats ?? mesh.packedSplats?.numSplats, size);
    frameMesh(mesh);
    rebuildCollider();
    if (collisionGeometry || startPoint) goToStart();
    currentSource = { fileBytes, url, fileName };
    $("controls").disabled = false;
    $("color-controls").disabled = false;
    $("generate").disabled = false;
  } catch (err) {
    if (id !== loadId) return;
    console.error(err);
    if (current) {
      scene.remove(current);
      current.dispose();
      current = null;
    }
    showStatus(`Failed to load ${fileName}: ${err?.message ?? err}`, 0, true);
  }
}

function loadFile(file) {
  if (!file) return;
  file.arrayBuffer().then((buf) =>
    loadSplat({ fileBytes: new Uint8Array(buf), fileName: file.name, size: file.size }),
  );
}

function loadUrl(url) {
  const fileName = decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || url);
  loadSplat({ url, fileName });
}

// Most 3DGS training outputs (INRIA/COLMAP) are Y-down; rotating 180° about X makes them upright.
function applyFlip(mesh) {
  mesh.quaternion.set(0, 0, 0, 1);
  if ($("flip").checked) mesh.quaternion.set(1, 0, 0, 0);
  mesh.updateMatrixWorld(true);
}

// --- Collision & start point -------------------------------------------------

function parseVec(str) {
  const v = str?.split(",").map(Number);
  return v?.length === 3 && v.every(Number.isFinite) ? new THREE.Vector3(...v) : null;
}

// PlayCanvas/SuperSplat space -> this viewer's world space (depends on the flip toggle).
function pcToWorld() {
  return new THREE.Matrix4().multiplyMatrices(current.matrixWorld, PC_TO_PLY);
}

function rebuildCollider() {
  walker.clearCollider();
  if (!collisionGeometry || !current) return;
  const debug = walker.setCollider(collisionGeometry, current.matrixWorld);
  debug.visible = $("show-collision").checked;
  scene.add(debug);
}

// Put the camera at the start point (or the middle of the collision mesh) in walk mode.
function goToStart() {
  if (!current) return;
  const hint = startPoint?.clone().applyMatrix4(pcToWorld());
  const feet = walker.bvh ? walker.findSpawn(hint) : hint?.sub(new THREE.Vector3(0, EYE_HEIGHT, 0));
  if (!feet) return;
  camera.near = 0.01;
  camera.updateProjectionMatrix();
  setMode("walk");
  walker.teleport(feet);
}

async function loadCollision(source, name) {
  showStatus(`Loading collision ${name}…`, null);
  try {
    collisionGeometry?.dispose();
    collisionGeometry = await loadCollisionGeometry(source);
    hideStatus();
    $("collision-name").textContent = `${name} · ${(collisionGeometry.getAttribute("position").count / 3).toLocaleString()} tris`;
    rebuildCollider();
    goToStart();
  } catch (err) {
    console.error(err);
    collisionGeometry = null;
    showStatus(`Failed to load collision ${name}: ${err?.message ?? err}`, 0, true);
  }
}

// Generate a collision mesh for the loaded scene with PlayCanvas splat-transform,
// run by the dev/preview server (tools/collision-plugin.js).
async function generateCollisionMesh() {
  if (!current || !currentSource) return;
  const seed = startPoint ?? camera.position.clone().applyMatrix4(pcToWorld().invert());
  const { fileName } = currentSource;
  $("generate").disabled = true;
  showStatus("Generating collision mesh… (this can take a minute)", null);

  try {
    const bytes = currentSource.fileBytes ?? new Uint8Array(await (await fetch(currentSource.url)).arrayBuffer());
    const params = new URLSearchParams({
      name: fileName,
      seed: seed.toArray().map((v) => v.toFixed(3)).join(","),
      mode: $("gen-mode").value,
      voxel: $("gen-voxel").value,
    });
    const res = await fetch(`/api/collision?${params.toString().replace(/%2C/g, ",")}`, { method: "POST", body: bytes });
    if (res.status === 404) throw new Error("no collision server here: run the viewer with `npm run dev` or `npm run preview`");
    if (!res.ok) throw new Error(await res.text());

    // The server streams splat-transform's log, then a final result/error line.
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += value;
      const tail = text.slice(-2000);
      if (!tail.includes("@@")) {
        const line = tail.split("\n").map((l) => l.replace(/[▸·]/g, "").trim()).filter((l) => l && !/^warning/i.test(l)).pop();
        if (line) showStatus(`Generating collision mesh… ${line}`, null);
      }
    }
    const error = text.split("@@ERROR@@")[1];
    if (error != null) throw new Error(error.trim().split("\n").slice(-3).join(" "));
    const base64 = text.split("@@RESULT@@")[1];
    if (base64 == null) throw new Error("no result from the server");
    const glb = Uint8Array.from(atob(base64.trim()), (c) => c.charCodeAt(0));

    const name = `${fileName.replace(/\.[^.]+$/, "")}.collision.glb`;
    const link = $("collision-download");
    URL.revokeObjectURL(link.href);
    link.href = URL.createObjectURL(new Blob([glb], { type: "model/gltf-binary" }));
    link.download = name;
    link.textContent = `Download ${name}`;
    link.hidden = false;

    startPoint ??= seed;
    await loadCollision(glb.buffer, name);
  } catch (err) {
    console.error(err);
    showStatus(`Collision generation failed: ${err?.message ?? err}`, 0, true);
  } finally {
    $("generate").disabled = false;
  }
}

// Fit the camera to the splat's bounding box.
function frameMesh(mesh) {
  const box = mesh.getBoundingBox(true).clone().applyMatrix4(mesh.matrixWorld);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  const dist = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.9;

  camera.near = Math.max(radius / 1000, 0.001);
  camera.far = radius * 100;
  camera.updateProjectionMatrix();

  camera.position.copy(center).add(new THREE.Vector3(0, radius * 0.15, dist));
  camera.up.set(0, 1, 0);
  camera.lookAt(center);
  orbit.target.copy(center);
  orbit.update();
  fly.fpsMovement.moveSpeed = Math.max(radius * 0.5, 0.1);

  homeView = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), target: center.clone() };
}

// --- UI --------------------------------------------------------------------

function showStatus(text, progress, isError = false) {
  $("status").hidden = false;
  $("status").classList.toggle("error", isError);
  $("status-text").textContent = text;
  const fill = $("bar-fill");
  fill.classList.toggle("indeterminate", progress == null);
  fill.style.width = progress == null ? "" : `${progress * 100}%`;
}

function hideStatus() {
  $("status").hidden = true;
}

function showInfo(name, count, size) {
  $("info").hidden = false;
  $("info-name").textContent = name;
  $("info-name").title = name;
  $("info-count").textContent = count != null ? count.toLocaleString() : "—";
  $("info-size").textContent = size ? `${(size / 1024 / 1024).toFixed(1)} MB` : "—";
}

$("file").addEventListener("change", (e) => {
  loadFile(e.target.files[0]);
  e.target.value = "";
});

$("url-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("url").value.trim();
  if (url) loadUrl(url);
});

$("flip").addEventListener("change", () => {
  if (!current) return;
  applyFlip(current);
  frameMesh(current);
  rebuildCollider();
  if (mode === "walk") goToStart();
});

$("sharpness").addEventListener("input", (e) => {
  spark.focalAdjustment = Number(e.target.value);
  $("sharpness-value").textContent = Number(e.target.value).toFixed(1);
});

$("radial").addEventListener("change", (e) => {
  spark.sortRadial = e.target.checked;
});

$("autorotate").addEventListener("change", (e) => {
  orbit.autoRotate = e.target.checked;
});

const hints = {
  orbit: "Orbit: drag to rotate · right-drag to pan · scroll to zoom",
  fly: "Fly: WASD to move · Q/E up/down · drag to look · Shift for speed",
  walk: "Walk: click to look around (Esc to release) · WASD to move · Shift to run · Space to jump",
};

function setMode(next) {
  const prev = mode;
  mode = next;
  $("mode").value = next;
  orbit.enabled = mode === "orbit";
  walker.enabled = mode === "walk";
  if (mode !== "walk" && document.pointerLockElement === canvas) document.exitPointerLock();
  if (mode === "walk" && prev !== "walk") {
    walker.teleport(camera.position.clone().sub(new THREE.Vector3(0, EYE_HEIGHT, 0)));
  }
  if (mode === "orbit") {
    // Re-target orbit to a point in front of where the fly camera ended up.
    const dist = camera.position.distanceTo(orbit.target) || 1;
    orbit.target.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(dist));
  }
  $("hint").textContent = hints[mode];
}

$("mode").addEventListener("change", (e) => {
  setMode(e.target.value);
  e.target.blur(); // so WASD/arrow keys move the camera instead of the dropdown
});

$("reset").addEventListener("click", () => {
  if (mode === "walk") return goToStart();
  if (!homeView) return;
  camera.position.copy(homeView.position);
  camera.quaternion.copy(homeView.quaternion);
  orbit.target.copy(homeView.target);
  orbit.update();
});

$("collision-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) file.arrayBuffer().then((buf) => loadCollision(buf, file.name));
  e.target.value = "";
});

$("gen-run").addEventListener("click", generateCollisionMesh);

$("show-collision").addEventListener("change", (e) => {
  if (walker.debugMesh) walker.debugMesh.visible = e.target.checked;
});

// Remember where the camera is as the start point, and show it in SuperSplat coordinates
// (use it as --seed-pos for splat-transform, or share the link with ?spawn=).
$("set-start").addEventListener("click", () => {
  if (!current) return;
  startPoint = camera.position.clone().applyMatrix4(pcToWorld().invert());
  const text = startPoint.toArray().map((v) => v.toFixed(2)).join(",");
  const params = new URLSearchParams(location.search);
  params.set("spawn", text);
  history.replaceState(null, "", `?${params.toString().replace(/%2C/g, ",")}`);
  $("start-pos").textContent = `Start: ${text}`;
});

// --- Colors (same controls and ranges as SuperSplat's Colors panel) ------------

const colorKeys = ["temperature", "saturation", "brightness", "blackPoint", "whitePoint", "transparency"];

function updateGrade() {
  const params = { tint: $("c-tint").value };
  for (const key of colorKeys) {
    const input = $(`c-${key}`);
    params[key] = Number(input.value);
    input.previousElementSibling.textContent = params[key].toFixed(2);
  }
  grade.set(params);
  current?.updateVersion();
}

$("color-controls").addEventListener("input", updateGrade);

$("c-reset").addEventListener("click", () => {
  $("c-tint").value = NEUTRAL.tint;
  for (const key of colorKeys) $(`c-${key}`).value = NEUTRAL[key];
  updateGrade();
});

updateGrade();

// Drag & drop anywhere on the page.
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (++dragDepth === 1) $("drop-overlay").hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth === 0) $("drop-overlay").hidden = true;
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop-overlay").hidden = true;
  const file = e.dataTransfer.files[0];
  if (file?.name.toLowerCase().endsWith(".glb")) file.arrayBuffer().then((buf) => loadCollision(buf, file.name));
  else loadFile(file);
});

// Allow ?url=...&collision=...&spawn=x,y,z for quick linking.
const query = new URLSearchParams(location.search);
const collisionUrl = query.get("collision");
if (collisionUrl) loadCollision(collisionUrl, decodeURIComponent(collisionUrl.split("/").pop()));
if (startPoint) $("start-pos").textContent = `Start: ${query.get("spawn")}`;
const initialUrl = query.get("url");
if (initialUrl) {
  $("url").value = initialUrl;
  loadUrl(initialUrl);
}
```

### `src/color-grade.js`

```js
import * as THREE from "three";
import { dyno } from "@sparkjsdev/spark";

// Port of SuperSplat's colour grade (src/color-grade.ts in playcanvas/supersplat).
// The seven authored parameters collapse into an affine colour transform (3x3
// matrix + offset) plus an alpha multiplier, applied to each splat's final
// view-dependent colour, exactly as SuperSplat's shader does.

export const NEUTRAL = {
  tint: "#ffffff",
  temperature: 0,
  saturation: 1,
  brightness: 0,
  blackPoint: 0,
  whitePoint: 1,
  transparency: 0, // log space: 0 is a factor of 1
};

// Luma weights the saturation mix is taken about (same as SuperSplat).
const LUMA = [0.299, 0.587, 0.114];

class ColorGradeDyno extends dyno.Dyno {
  constructor({ gsplat, row0, row1, row2, alpha }) {
    super({
      inTypes: { gsplat: dyno.Gsplat, row0: "vec4", row1: "vec4", row2: "vec4", alpha: "float" },
      outTypes: { gsplat: dyno.Gsplat },
      inputs: { gsplat, row0, row1, row2, alpha },
      statements: ({ inputs, outputs }) => {
        const { gsplat } = outputs;
        const { row0, row1, row2, alpha } = inputs;
        return [
          `${gsplat} = ${inputs.gsplat};`,
          `if (isGsplatActive(${gsplat}.flags)) {`,
          `  vec3 c = ${gsplat}.rgba.rgb;`,
          `  ${gsplat}.rgba.rgb = max(vec3(dot(${row0}.xyz, c), dot(${row1}.xyz, c), dot(${row2}.xyz, c))`,
          `    + vec3(${row0}.w, ${row1}.w, ${row2}.w), vec3(0.0));`,
          `  ${gsplat}.rgba.a = clamp(${gsplat}.rgba.a * ${alpha}, 0.0, 1.0);`,
          `}`,
        ];
      },
    });
  }
}

export class ColorGrade {
  constructor() {
    this.row0 = new dyno.DynoVec4({ value: new THREE.Vector4(1, 0, 0, 0) });
    this.row1 = new dyno.DynoVec4({ value: new THREE.Vector4(0, 1, 0, 0) });
    this.row2 = new dyno.DynoVec4({ value: new THREE.Vector4(0, 0, 1, 0) });
    this.alpha = new dyno.DynoFloat({ value: 1 });
    this.params = { ...NEUTRAL };

    const { row0, row1, row2, alpha } = this;
    this.modifier = {
      apply: ({ gsplat }) => ({ gsplat: new ColorGradeDyno({ gsplat, row0, row1, row2, alpha }).outputs.gsplat }),
    };
  }

  // Recompute the uniforms from `params` (SuperSplat's gradeTerms + gradeRows).
  set(params) {
    const p = Object.assign(this.params, params);
    // SuperSplat uses the picker's values as-is, so skip three's sRGB -> linear decode.
    const tint = new THREE.Color().setStyle(p.tint, THREE.LinearSRGBColorSpace);

    const range = 1 / Math.max(p.whitePoint - p.blackPoint, 1e-4);
    const s = [
      range * tint.r * (1 + p.temperature),
      range * tint.g,
      range * tint.b * (1 - p.temperature),
    ];
    const sat = p.saturation;
    const offset = -p.blackPoint + p.brightness;

    // row i, column j of A * diag(s), where A = sat * I + (1 - sat) * 1 * LUMA^T
    const rows = [this.row0, this.row1, this.row2];
    for (let i = 0; i < 3; ++i) {
      const m = [0, 1, 2].map((j) => (1 - sat) * LUMA[j] * s[j] + (i === j ? sat * s[j] : 0));
      rows[i].value.set(m[0], m[1], m[2], offset);
    }
    this.alpha.value = Math.exp(p.transparency);
  }

  reset() {
    this.set(NEUTRAL);
  }
}
```

### `src/collision.js`

```js
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { MeshBVH } from "three-mesh-bvh";

// Collision meshes from `splat-transform --collision-mesh` (.collision.glb) are written in
// PlayCanvas/SuperSplat space, which is the PLY data rotated 180° about Z. Spark renders the
// PLY data as-is, so the mesh needs that rotation undone before the splat's own transform.
export const PC_TO_PLY = new THREE.Matrix4().makeRotationZ(Math.PI);

// Player capsule, matching splat-transform's default `--voxel-carve 1.6,0.2`.
export const EYE_HEIGHT = 1.6;
const RADIUS = 0.2;
const GRAVITY = -9.8;
const JUMP_SPEED = 4;
const WALK_SPEED = 2;
const RUN_SPEED = 5;

// Load a .glb and merge all its meshes into one position-only geometry (PlayCanvas space).
export async function loadCollisionGeometry(source) {
  const loader = new GLTFLoader();
  const gltf = typeof source === "string" ? await loader.loadAsync(source) : await loader.parseAsync(source, "");
  gltf.scene.updateMatrixWorld(true);

  const parts = [];
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    let g = new THREE.BufferGeometry();
    g.setAttribute("position", obj.geometry.getAttribute("position"));
    if (obj.geometry.index) g.setIndex(obj.geometry.index);
    g = g.index ? g.toNonIndexed() : g.clone();
    g.applyMatrix4(obj.matrixWorld);
    parts.push(g);
  });
  if (!parts.length) throw new Error("no meshes in collision file");
  return parts.length === 1 ? parts[0] : mergeGeometries(parts);
}

export class Walker {
  constructor(camera, canvas) {
    this.camera = camera;
    this.canvas = canvas;
    this.enabled = false;
    this.bvh = null;
    this.debugMesh = null;

    this.feet = new THREE.Vector3(); // bottom of the capsule
    this.velocity = new THREE.Vector3();
    this.onGround = false;
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();

    window.addEventListener("keydown", (e) => {
      if (!this.enabled || e.target.closest?.("input, select, textarea")) return;
      this.keys.add(e.code);
      if (e.code === "Space") {
        e.preventDefault(); // don't press a focused panel button
        if (this.onGround) this.velocity.y = JUMP_SPEED;
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());

    canvas.addEventListener("click", () => {
      if (this.enabled && document.pointerLockElement !== canvas) canvas.requestPointerLock();
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.enabled || document.pointerLockElement !== canvas) return;
      this.yaw -= e.movementX * 0.002;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.002, -1.5, 1.5);
    });
  }

  // `geometry` is in PlayCanvas space; `splatMatrix` is the splat mesh's matrixWorld.
  setCollider(geometry, splatMatrix) {
    this.bvh?.geometry.dispose();
    const world = geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(splatMatrix, PC_TO_PLY));
    world.computeBoundingBox();
    this.bvh = new MeshBVH(world);

    const visible = this.debugMesh?.visible ?? false;
    this.debugMesh?.removeFromParent();
    this.debugMesh = new THREE.Mesh(world, new THREE.MeshBasicMaterial({ color: 0x3dd6ff, wireframe: true, transparent: true, opacity: 0.35 }));
    this.debugMesh.visible = visible;
    return this.debugMesh;
  }

  clearCollider() {
    this.bvh?.geometry.dispose();
    this.bvh = null;
    this.debugMesh?.removeFromParent();
    this.debugMesh = null;
  }

  // Find a spawn point (feet position), or null with no collider. With a `hint` (world space)
  // drop straight down from it to the first floor. Without one, search the middle of the
  // collision mesh for the open floor (lowest surface with head room) closest to the centre,
  // so we don't land on a table or inside furniture.
  findSpawn(hint) {
    if (!this.bvh) return null;
    if (hint) return this.dropToFloor(hint) ?? hint.clone().sub(new THREE.Vector3(0, EYE_HEIGHT, 0));

    const box = this.bvh.geometry.boundingBox;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const reach = Math.min(size.x, size.z) * 0.3;
    const step = Math.max(reach / 8, RADIUS);
    const candidates = [];
    for (let x = -reach; x <= reach; x += step) {
      for (let z = -reach; z <= reach; z += step) {
        const feet = this.dropToFloor(new THREE.Vector3(center.x + x, center.y, center.z + z));
        if (feet && this.hasHeadroom(feet)) candidates.push({ feet, dist: x * x + z * z });
      }
    }
    if (!candidates.length) return this.dropToFloor(center) ?? center.sub(new THREE.Vector3(0, EYE_HEIGHT, 0));

    const floorY = Math.min(...candidates.map((c) => c.feet.y));
    const onFloor = candidates.filter((c) => c.feet.y < floorY + 0.15);
    return onFloor.reduce((a, b) => (b.dist < a.dist ? b : a)).feet;
  }

  dropToFloor(from) {
    const hit = this.bvh.raycastFirst(new THREE.Ray(from, new THREE.Vector3(0, -1, 0)), THREE.DoubleSide);
    return hit ? hit.point.add(new THREE.Vector3(0, 0.05, 0)) : null;
  }

  hasHeadroom(feet) {
    const up = new THREE.Ray(feet.clone().add(new THREE.Vector3(0, 0.1, 0)), new THREE.Vector3(0, 1, 0));
    const hit = this.bvh.raycastFirst(up, THREE.DoubleSide);
    if (hit && hit.distance < EYE_HEIGHT) return false;
    // Keep clear of walls and furniture edges at knee, waist and head height.
    for (const h of [0.3, 0.9, EYE_HEIGHT]) {
      const at = feet.clone().add(new THREE.Vector3(0, h, 0));
      for (let i = 0; i < 8; i++) {
        const dir = new THREE.Vector3(Math.cos(i * Math.PI / 4), 0, Math.sin(i * Math.PI / 4));
        const side = this.bvh.raycastFirst(new THREE.Ray(at, dir), THREE.DoubleSide);
        if (side && side.distance < RADIUS * 2) return false;
      }
    }
    return true;
  }

  // Place the player with feet at `feet`, looking along the camera's current heading.
  teleport(feet) {
    this.feet.copy(feet);
    this.velocity.set(0, 0, 0);
    const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, "YXZ");
    this.yaw = euler.y;
    this.pitch = 0;
    this.applyCamera();
  }

  applyCamera() {
    this.camera.position.copy(this.feet).y += EYE_HEIGHT;
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
  }

  update(dt) {
    dt = Math.min(dt, 0.05);
    const k = this.keys;
    const speed = k.has("ShiftLeft") || k.has("ShiftRight") ? RUN_SPEED : WALK_SPEED;
    const move = new THREE.Vector3(
      (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0),
      0,
      (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0) - (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0),
    );
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * dt).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);

    // Without collision data, walk mode just glides at eye height (no gravity).
    if (!this.bvh) {
      this.feet.add(move);
      this.applyCamera();
      return;
    }

    // Sub-step so fast movement can't tunnel through thin walls.
    const steps = 5;
    move.divideScalar(steps);
    for (let i = 0; i < steps; i++) this.step(dt / steps, move);
    this.applyCamera();
  }

  step(dt, move) {
    // Keep a small downward pull while grounded so ground contact is detected every step.
    if (this.onGround && this.velocity.y <= 0) this.velocity.y = GRAVITY * dt;
    else this.velocity.y += GRAVITY * dt;
    this.feet.addScaledVector(this.velocity, dt).add(move);

    // Capsule from just above the feet to the top of the head.
    const segment = new THREE.Line3(
      this.feet.clone().add(new THREE.Vector3(0, RADIUS, 0)),
      this.feet.clone().add(new THREE.Vector3(0, EYE_HEIGHT + 0.1 - RADIUS, 0)),
    );
    const startBefore = segment.start.clone();
    const bounds = new THREE.Box3().setFromPoints([segment.start, segment.end]).expandByScalar(RADIUS);
    const triPoint = new THREE.Vector3();
    const capPoint = new THREE.Vector3();

    this.bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(bounds),
      intersectsTriangle: (tri) => {
        const dist = tri.closestPointToSegment(segment, triPoint, capPoint);
        if (dist < RADIUS) {
          const push = capPoint.sub(triPoint).normalize().multiplyScalar(RADIUS - dist);
          segment.start.add(push);
          segment.end.add(push);
        }
      },
    });

    const delta = segment.start.sub(startBefore);
    // Pushed up more than gravity pulled us down this step -> standing on something.
    this.onGround = delta.y > Math.abs(dt * this.velocity.y * 0.25);
    this.feet.add(delta);

    if (this.onGround) this.velocity.set(0, Math.max(this.velocity.y, 0), 0);
    else if (delta.lengthSq() > 1e-10) {
      delta.normalize();
      this.velocity.addScaledVector(delta, -delta.dot(this.velocity));
    }

    // Fell out of the world: put the player back at a spawn point.
    if (this.feet.y < this.bvh.geometry.boundingBox.min.y - 10) this.teleport(this.findSpawn());
  }
}
```

### `tools/collision.js`

```js
// Collision mesh generation with PlayCanvas splat-transform
// (https://github.com/playcanvas/splat-transform). Shared by the command-line tool
// (tools/make-collision.js) and the viewer's "Generate collision mesh" button
// (tools/collision-plugin.js).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CLI = fileURLToPath(new URL("../node_modules/@playcanvas/splat-transform/bin/cli.mjs", import.meta.url));

export const INPUT_EXTENSIONS = [".ply", ".spz", ".splat", ".ksplat", ".sog", ".lcc"];

export const DEFAULTS = {
  mode: "room", // "room": seal the outside, carve the inside (interiors) · "outdoor": fill the ground
  voxelSize: 0.05, // metres per voxel
  opacity: 0.1, // splats more transparent than this don't block
  height: 1.6, // walker capsule height used to carve walkable space
  radius: 0.2, // walker capsule radius
  shape: "smooth", // "smooth" or "faces" (blocky, watertight)
};

const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
};

export function parseSeed(str) {
  const v = String(str ?? "").split(",").map((s) => num(s, "seed"));
  if (v.length !== 3) throw new Error(`seed must be "x,y,z", got "${str}"`);
  return v;
}

// Build the splat-transform argument list. Everything is validated as a number or a
// fixed keyword, and passed without a shell.
function buildArgs(input, output, opts) {
  // Unset options fall back to the defaults (a plain spread would copy `undefined` over them).
  const o = { ...DEFAULTS };
  for (const [key, value] of Object.entries(opts)) if (value != null) o[key] = value;
  const seed = parseSeed(o.seed).join(",");
  if (!["room", "outdoor"].includes(o.mode)) throw new Error(`mode must be "room" or "outdoor"`);
  if (!["smooth", "faces"].includes(o.shape)) throw new Error(`shape must be "smooth" or "faces"`);

  return [
    "-w",
    "--seed-pos", seed,
    // Drop floaters that aren't connected to the scene around the seed.
    "--filter-cluster",
    "--voxel-size", String(num(o.voxelSize, "voxelSize")),
    "--voxel-opacity", String(num(o.opacity, "opacity")),
    o.mode === "room" ? "--voxel-external-fill" : "--voxel-floor-fill",
    "--voxel-carve", `${num(o.height, "height")},${num(o.radius, "radius")}`,
    "--collision-mesh", o.shape,
    input,
    output,
  ];
}

function run(args, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const log = (chunk) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-4000);
      onLog?.(text);
    };
    child.stdout.on("data", log);
    child.stderr.on("data", log);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`splat-transform exited with code ${code}\n${tail}`))));
  });
}

// splat-transform's `--list-gpus` output, e.g. "[1] llvmpipe (LLVM 20.1.2, 256 bits)".
async function listGpus() {
  let out = "";
  await run(["--list-gpus"], (text) => (out += text)).catch(() => {});
  return [...out.matchAll(/^\[(\d+)\]\s+(.+)$/gm)].map((m) => ({ index: m[1], name: m[2].trim() }));
}

// Generate `<name>.collision.glb` (plus the .voxel.json/.voxel.bin it is derived from)
// from a splat file. Returns the paths of the written files.
export async function generateCollision(input, { outDir, ...opts } = {}, onLog) {
  const ext = path.extname(input).toLowerCase();
  if (!INPUT_EXTENSIONS.includes(ext)) throw new Error(`unsupported input "${ext}" (use ${INPUT_EXTENSIONS.join(" ")})`);

  const base = path.basename(input, ext);
  outDir ??= path.dirname(input);
  await fs.mkdir(outDir, { recursive: true });
  const voxel = path.join(outDir, `${base}.voxel.json`);
  const glb = path.join(outDir, `${base}.collision.glb`);

  const args = buildArgs(input, voxel, opts);
  const gpu = opts.gpu != null && opts.gpu !== "" ? ["-g", String(num(opts.gpu, "gpu"))] : [];
  // Remove a previous result so a failed run can't be mistaken for success.
  await fs.rm(glb, { force: true });
  let error = null;
  await run([...gpu, ...args], onLog).catch((err) => (error = err));

  // Voxelization needs a GPU (there is no CPU path). Some drivers (seen with Intel
  // integrated graphics on Linux) silently voxelize large scenes to nothing, so when the
  // default adapter gives no mesh, retry on the software adapter (llvmpipe): slower, but reliable.
  const empty = !(await fs.stat(glb).catch(() => null));
  if (!gpu.length && (error || empty)) {
    const soft = (await listGpus()).find((g) => /llvmpipe|swiftshader|software/i.test(g.name));
    if (soft) {
      onLog?.(`\nNo mesh from the default GPU, retrying on the software GPU (${soft.name}); this is slower…\n`);
      error = null;
      await run(["-g", soft.index, ...args], onLog).catch((err) => (error = err));
    }
  }
  if (error) throw error;

  // splat-transform still exits successfully when carving leaves nothing (e.g. the seed is
  // inside an object or too close to the floor/ceiling for the capsule), it just skips the GLB.
  if (!(await fs.stat(glb).catch(() => null))) {
    throw new Error(
      "splat-transform produced no collision mesh. The seed is probably not in open space: " +
        `it needs ${opts.height ?? DEFAULTS.height} m of clear height centred on it (try a point mid-way between floor and ceiling), ` +
        "or the scene isn't in metres (a room should be about 2.5 m floor to ceiling).",
    );
  }

  return {
    glb,
    voxelJson: voxel,
    voxelBin: path.join(outDir, `${base}.voxel.bin`),
  };
}

// Same, for splat bytes that aren't on disk yet (e.g. uploaded from the browser).
// Works in a temporary folder and returns the .collision.glb bytes.
export async function generateCollisionFromBytes(bytes, fileName, opts, onLog) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "collision-"));
  try {
    const input = path.join(dir, `scene${path.extname(fileName).toLowerCase()}`);
    await fs.writeFile(input, bytes);
    const { glb } = await generateCollision(input, { ...opts, outDir: dir }, onLog);
    return await fs.readFile(glb);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
```

### `tools/make-collision.js`

```js
#!/usr/bin/env node
// Create a collision mesh for a splat scene with PlayCanvas splat-transform.
//
//   npm run collision -- scene.ply --seed 0,1,0
//
// --seed is a point in the empty, walkable space of the scene (SuperSplat coordinates).
// In the viewer, fly to that spot and press "Set start point here" to read it off.

import { parseArgs } from "node:util";
import { DEFAULTS, generateCollision } from "./collision.js";

const help = `Usage: npm run collision -- <scene.ply|.spz|.splat|.ksplat|.sog> --seed x,y,z [options]

  --seed x,y,z     Point inside the walkable space, in SuperSplat coordinates (required)
  --mode room|outdoor
                   room: seal the outside and carve the inside (default)
                   outdoor: fill the ground below surfaces
  --voxel n        Voxel size in metres (default ${DEFAULTS.voxelSize})
  --opacity n      Opacity below which splats don't block (default ${DEFAULTS.opacity})
  --height n       Walker height used to carve walkable space (default ${DEFAULTS.height})
  --radius n       Walker radius (default ${DEFAULTS.radius})
  --shape smooth|faces
                   Collision mesh style (default ${DEFAULTS.shape})
  --gpu n          GPU adapter index (see: npx splat-transform --list-gpus). By default the
                   default GPU is tried first, then the software GPU if it gives no mesh
  --out dir        Output folder (default: next to the scene)

Writes <scene>.collision.glb (load it in the viewer) plus <scene>.voxel.json/.voxel.bin.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seed: { type: "string" },
    mode: { type: "string", default: DEFAULTS.mode },
    voxel: { type: "string", default: String(DEFAULTS.voxelSize) },
    opacity: { type: "string", default: String(DEFAULTS.opacity) },
    height: { type: "string", default: String(DEFAULTS.height) },
    radius: { type: "string", default: String(DEFAULTS.radius) },
    shape: { type: "string", default: DEFAULTS.shape },
    out: { type: "string" },
    gpu: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || positionals.length !== 1 || !values.seed) {
  console.log(help);
  process.exit(values.help ? 0 : 1);
}

try {
  const out = await generateCollision(
    positionals[0],
    {
      seed: values.seed,
      mode: values.mode,
      voxelSize: values.voxel,
      opacity: values.opacity,
      height: values.height,
      radius: values.radius,
      shape: values.shape,
      outDir: values.out,
      gpu: values.gpu,
    },
    (text) => process.stdout.write(text),
  );
  console.log(`\nCollision mesh: ${out.glb}`);
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
```

### `tools/collision-plugin.js`

```js
// Vite plugin: POST /api/collision lets the viewer generate a collision mesh with
// splat-transform on this machine. Only available under `npm run dev` / `npm run preview`
// (a static build has no server to run it).
//
// Request:  POST /api/collision?name=scene.ply&seed=x,y,z[&mode&voxel&shape&height&radius]
//           body = the splat file bytes
// Response: streamed text. splat-transform's log, then a final line that is either
//           "@@RESULT@@<base64 .collision.glb>" or "@@ERROR@@<message>".

import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { INPUT_EXTENSIONS, generateCollision } from "./collision.js";

export default function collisionPlugin() {
  let busy = false;

  async function handle(req, res) {
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end("POST a splat file");
    }
    if (busy) {
      res.statusCode = 429;
      return res.end("A collision mesh is already being generated, try again when it finishes.");
    }

    const query = new URL(req.url, "http://localhost").searchParams;
    const ext = path.extname(query.get("name") ?? "").toLowerCase();
    if (!INPUT_EXTENSIONS.includes(ext)) {
      res.statusCode = 400;
      return res.end(`Unsupported scene type "${ext}"`);
    }

    busy = true;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "collision-"));
    try {
      const input = path.join(dir, `scene${ext}`);
      await pipeline(req, createWriteStream(input));
      const { glb } = await generateCollision(
        input,
        {
          seed: query.get("seed"),
          mode: query.get("mode") ?? undefined,
          voxelSize: query.get("voxel") ?? undefined,
          shape: query.get("shape") ?? undefined,
          height: query.get("height") ?? undefined,
          radius: query.get("radius") ?? undefined,
        },
        (text) => res.write(text),
      );
      res.end(`\n@@RESULT@@${(await fs.readFile(glb)).toString("base64")}`);
    } catch (err) {
      res.end(`\n@@ERROR@@${err.message}`);
    } finally {
      busy = false;
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  // Block body: Vite treats a function returned from these hooks as a post-hook.
  const mount = (server) => {
    server.middlewares.use("/api/collision", (req, res) => void handle(req, res));
  };
  return { name: "collision-api", configureServer: mount, configurePreviewServer: mount };
}
```

---

## 5. Run it

```sh
npm run dev        # http://localhost:5173 (also on your LAN); collision button works
npm run build      # static site in dist/ (no collision button: needs a server)
npm run preview    # serve dist/ with the collision button
```

### URL parameters

| Parameter | Example | Meaning |
|---|---|---|
| `url` | `?url=/scene.ply` | Scene to load |
| `collision` | `&collision=/scene.collision.glb` | Collision mesh to load |
| `spawn` | `&spawn=1.05,-1.0,1.46` | Start point in SuperSplat coordinates |

Files in a `public/` folder are served from `/` by Vite.

---

## 6. Making a collision mesh (step by step)

### 6.1 Make sure the scene is in metres

The walker is 1.6 m tall and carving uses a 1.6 m capsule, so **a room must be about 2.5 m from floor to ceiling**. Many training outputs (COLMAP, VGGT) are not in metres. If yours isn't, make a scaled copy:

```sh
npx splat-transform scene.ply -s 2.7 scene_metric.ply
```

To pick the factor: real ceiling height ÷ floor-to-ceiling distance in the file. A useful check is that the capture cameras should end up about 1.5 m above the floor.

### 6.2 Pick a seed point

A point in **open air inside the room, about halfway between floor and ceiling**. The 1.6 m capsule is centred on it and must fit.

- **In the viewer:** load the scene, switch to **Fly**, move to the spot, click **Set start point here**, and read `Start: x,y,z`.
- **From your capture:** use a camera position from COLMAP `images.txt` (centre = −Rᵀt). Convert PLY → SuperSplat coordinates as `(−x, −y, z)` and scale it like the scene.

### 6.3 Generate

**From the viewer:** Collision → Scene type → Detail → **Generate collision mesh** → **Download**.

**From the command line:**

```sh
npm run collision -- scene_metric.ply --seed 1.048,-1.0,1.458
npm run collision -- scene_metric.ply --seed 1.048,-1.0,1.458 --voxel 0.1 --gpu 1   # coarse, software GPU
npm run collision -- scene_metric.ply --seed 1.048,-1.0,1.458 --mode outdoor       # scans with open sides
```

Run `npm run collision -- --help` for all options, and `npx splat-transform --list-gpus` to list GPU adapters.

### 6.4 Load and check

Load `scene_metric.ply`, then the `.collision.glb`. Tick **Show collision mesh** and check that the blue wireframe sits on the walls and floor.

### Example: `colorful_room_E_30k`

| Item | Value |
|---|---|
| Original floor → ceiling | ≈ 0.96 units, so scale ×2.7 (≈ 2.6 m) |
| Seed (SuperSplat space, scaled) | `1.048,-1.0,1.458` (a capture camera, lowered to mid-height) |
| GPU | Intel integrated graphics returned nothing; software GPU worked |
| Settings | Room mode, 10 cm voxels |
| Time | ≈ 7.5 min |
| Result | 1.3 K triangles, room ≈ 4.8 × 3.6 × 4 m |

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "produced no collision mesh" | Seed inside an object or too close to floor/ceiling | Move the seed to open space at mid-height |
| Same, even for a plain voxelize (0 triangles) | GPU driver silently fails | `--gpu 1` (software GPU); the tool also retries automatically |
| "seed reachable from outside, skipping exterior fill" | The scan has holes (door, window, missing wall) | Fine if carving still works; otherwise use `--mode outdoor` |
| You're giant or tiny when walking | Scene not in metres | Scale it (6.1) and regenerate |
| Wireframe doesn't line up with walls | Coordinate mismatch (only `.ply` has been verified) | Check the Flip setting; report the file type |
| "No collision server here" | Opened the static build without a server | `npm run dev` or `npm run preview` |
| Splats invisible in headless screenshots | Normal for headless Chrome | Test in a real browser |

---

## 8. Limits and what's next

- The renderer is **Spark/three.js**. A PlayCanvas-only requirement needs a move to SuperSplat Viewer; the `.collision.glb` files carry over unchanged.
- No LOD streaming, `.lcc` loading, touch controls, hotspots, guided tour, dollhouse, floor plan or mini-map yet.
- The software GPU is slow: about 7.5 min at 10 cm for 1.2 M splats. 5 cm takes several times longer.
