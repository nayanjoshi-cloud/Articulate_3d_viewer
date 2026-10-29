import { createViewer } from "@playcanvas/supersplat-viewer/viewer";
import "@playcanvas/supersplat-viewer/viewer.css";
import { DEFAULT_CAMERA_FOV, defaultSettings, importSettings } from "@playcanvas/supersplat-viewer/settings";
import { interiorStartPose } from "./start-pose.js";
import { splatToPly } from "./splat-to-ply.js";

const $ = (id) => document.getElementById(id);
const container = $("viewer");

// What the viewer is showing. The viewer takes its content, collision and settings when it is
// created, so changing any of them re-creates it (see mount()).
const scene = {
  source: null, // { url, fileName, size, bytes } (bytes: the whole file, an ArrayBuffer)
  collision: null, // { url, name }
  settings: null, // imported settings.json, or null for the defaults
  start: parsePose(new URLSearchParams(location.search).get("start")), // { position, target } chosen by the user
};

let viewer = null;
let mountId = 0;
let ownedUrl = null; // blob: URL of a local splat, revoked when replaced

// "px,py,pz,tx,ty,tz" -> { position, target }
function parsePose(str) {
  const v = str?.split(",").map(Number);
  return v?.length === 6 && v.every(Number.isFinite) ? { position: v.slice(0, 3), target: v.slice(3) } : null;
}

// The settings to create the viewer with. The starting camera is, in order: the view saved
// with "Set start view here" (?start=), the settings.json camera, or a point inside the room
// worked out from the PLY.
function buildSettings(source) {
  const settings = structuredClone(scene.settings ?? defaultSettings());
  const pose = scene.start ?? (scene.settings?.cameras?.length ? null : interiorStartPose(source.bytes));
  if (pose) {
    const fov = settings.cameras[0]?.initial.fov ?? DEFAULT_CAMERA_FOV;
    settings.cameras = [{ initial: { ...pose, fov } }];
  }
  return settings;
}

async function mount() {
  const id = ++mountId;
  const { source, collision } = scene;
  if (!source) return;

  viewer?.destroy();
  viewer = null;
  setLoaded(false);
  showStatus(`Loading ${source.fileName}…`, 0);

  try {
    const settings = buildSettings(source);
    const v = await createViewer({
      container,
      settings,
      contentUrl: source.url,
      // Blob URLs have no name, and the viewer picks the format from the extension.
      contentFilename: source.contentName,
      // Already in memory (also needed for the start pose and collision generation).
      contents: Promise.resolve(new Response(source.bytes)),
      collisionUrl: collision?.url,
    });
    if (id !== mountId) return v.destroy(); // superseded by a newer load
    viewer = v;

    v.events.on("progress:changed", (p) => showStatus(`Loading ${source.fileName}… ${Math.round(p)}%`, p / 100));
    v.events.on("cameraMode:changed", (m) => ($("mode").value = m === "anim" ? "orbit" : m));
    v.events.on("walkAllowed:changed", updateCollisionUi);
    v.events.on("hasCollisionOverlay:changed", updateCollisionUi);
    v.events.on("collisionOverlayEnabled:changed", (on) => ($("show-collision").checked = on));
    const onLoaded = () => {
      hideStatus();
      setLoaded(true);
      showInfo(source.fileName, source.size);
      // Inside a room the viewer starts with a slow figure-8 camera drift. Stand still at the
      // start view instead, walking when there is collision data. Authored animations still play.
      if (v.state.cameraMode === "anim" && settings.startMode !== "animTrack") {
        v.state.cameraMode = v.state.walkAllowed ? "walk" : settings.cameras.length ? "fly" : "orbit";
      } else if (collision && v.state.walkAllowed) {
        v.state.cameraMode = "walk";
      }
    };
    if (v.state.loaded) onLoaded();
    else v.events.once("loaded:changed", onLoaded);
  } catch (err) {
    if (id !== mountId) return;
    console.error(err);
    showStatus(`Failed to load ${source.fileName}: ${err?.message ?? err}`, 0, true);
  }
}

function setLoaded(loaded) {
  $("controls").disabled = !loaded;
  $("generate").disabled = !loaded;
  updateCollisionUi();
}

function updateCollisionUi() {
  const loaded = viewer?.state.loaded ?? false;
  $("show-collision").disabled = !loaded || !viewer.state.hasCollisionOverlay;
  $("show-collision").checked = loaded && viewer.state.collisionOverlayEnabled;
  $("mode").querySelector('[value="walk"]').disabled = !loaded || !viewer.state.walkAllowed;
}

// --- Loading -------------------------------------------------------------------

let fetchId = 0;

// `keepScene`: keep the collision mesh and start view (for the ?url= link they came with).
function setSource(source, keepScene = false) {
  // The engine reads .ply and .sog; a .splat is converted to a .ply first.
  source.contentName = source.fileName;
  if (/\.splat$/i.test(source.fileName)) {
    try {
      source.bytes = splatToPly(source.bytes);
      source.contentName = source.fileName.replace(/\.splat$/i, ".ply");
    } catch (err) {
      console.error(err);
      return showStatus(`Failed to load ${source.fileName}: ${err?.message ?? err}`, 0, true);
    }
  }
  if (ownedUrl && ownedUrl !== source.url) URL.revokeObjectURL(ownedUrl);
  ownedUrl = source.url.startsWith("blob:") ? source.url : null;
  scene.source = source;
  // A collision mesh and start view belong to the scene they were made for.
  if (!keepScene) {
    if (scene.collision) setCollision(null);
    setStart(null);
  }
  mount();
}

async function loadFile(file) {
  if (!file) return;
  const id = ++fetchId;
  showStatus(`Reading ${file.name}…`, null);
  const bytes = await file.arrayBuffer();
  if (id !== fetchId) return;
  setSource({ url: URL.createObjectURL(file), fileName: file.name, size: file.size, bytes });
}

async function loadUrl(url, keepScene = false) {
  const id = ++fetchId;
  const fileName = decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || url);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const total = Number(res.headers.get("Content-Length")) || 0;
    const chunks = [];
    let loaded = 0;
    for await (const chunk of res.body) {
      if (id !== fetchId) return;
      chunks.push(chunk);
      loaded += chunk.length;
      showStatus(`Downloading ${fileName}… ${total ? `${Math.round((loaded / total) * 100)}%` : `${(loaded / 1048576).toFixed(0)} MB`}`, total ? loaded / total : null);
    }
    const bytes = await new Blob(chunks).arrayBuffer();
    if (id !== fetchId) return;
    setSource({ url, fileName, size: bytes.byteLength, bytes }, keepScene);
  } catch (err) {
    if (id !== fetchId) return;
    console.error(err);
    showStatus(`Failed to download ${fileName}: ${err?.message ?? err}`, 0, true);
  }
}

// Remember the start view, and put it in the page URL so a link opens the scene from there.
function setStart(pose) {
  scene.start = pose;
  const params = new URLSearchParams(location.search);
  if (pose) params.set("start", [...pose.position, ...pose.target].map((v) => v.toFixed(3)).join(","));
  else params.delete("start");
  const query = params.toString().replace(/%2C/g, ",");
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
  $("start-pos").textContent = pose ? `Start: ${pose.position.map((v) => v.toFixed(2)).join(", ")}` : "Start: centre of the room (automatic)";
}

// The viewer treats a collision URL ending in .glb as a mesh (anything else as voxel data),
// so local .glb bytes go in as a percent-encoded data: URL with ".glb" appended. The GLB
// parser reads only as many bytes as the file's header says, so the 4 extra bytes are ignored.
const HEX = Array.from({ length: 256 }, (_, i) => `%${i.toString(16).padStart(2, "0")}`);
function glbDataUrl(bytes) {
  const u8 = new Uint8Array(bytes);
  const parts = new Array(u8.length);
  for (let i = 0; i < u8.length; i++) parts[i] = HEX[u8[i]];
  return `data:model/gltf-binary,${parts.join("")}.glb`;
}

function setCollision(collision) {
  scene.collision = collision;
  $("collision-name").textContent = collision?.name ?? "None";
}

function loadCollision(url, name) {
  setCollision({ url, name });
  mount();
}

function loadSettings(json, name) {
  try {
    scene.settings = importSettings(json);
    $("settings-name").textContent = name;
    mount();
  } catch (err) {
    console.error(err);
    showStatus(`Invalid settings ${name}: ${err?.message ?? err}`, 0, true);
  }
}

// --- Collision generation ------------------------------------------------------

// The active camera entity. Its world space is the splat rotated 180° about Z, the same space
// splat-transform works in, so its position is directly usable as --seed-pos.
function cameraEntity() {
  return viewer.app.root.findComponents("camera").find((c) => c.enabled).entity;
}

function cameraPosition() {
  return cameraEntity().getPosition();
}

// Generate a collision mesh with PlayCanvas splat-transform, run by the dev/preview server
// (tools/collision-plugin.js).
async function generateCollisionMesh() {
  if (!viewer?.state.loaded) return;
  const { source } = scene;
  const p = cameraPosition();
  const seed = [p.x, p.y, p.z].map((v) => v.toFixed(3)).join(",");
  $("generate").disabled = true;
  showStatus("Generating collision mesh… (this can take a minute)", null);

  try {
    const body = source.bytes;
    const params = new URLSearchParams({
      name: source.contentName,
      seed,
      mode: $("gen-mode").value,
      voxel: $("gen-voxel").value,
    });
    const res = await fetch(`/api/collision?${params.toString().replace(/%2C/g, ",")}`, { method: "POST", body });
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

    const name = `${source.fileName.replace(/(\.compressed)?\.[^.]+$/, "")}.collision.glb`;
    const link = $("collision-download");
    URL.revokeObjectURL(link.href);
    link.href = URL.createObjectURL(new Blob([glb], { type: "model/gltf-binary" }));
    link.download = name;
    link.textContent = `Download ${name}`;
    link.hidden = false;

    loadCollision(glbDataUrl(glb), name);
  } catch (err) {
    console.error(err);
    showStatus(`Collision generation failed: ${err?.message ?? err}`, 0, true);
    $("generate").disabled = false;
  }
}

// --- UI ------------------------------------------------------------------------

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

function showInfo(name, size) {
  $("info").hidden = false;
  $("info-name").textContent = name;
  $("info-name").title = name;
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

$("mode").addEventListener("change", (e) => {
  if (viewer?.state.loaded) viewer.state.cameraMode = e.target.value;
  e.target.blur(); // so WASD/arrow keys move the camera instead of the dropdown
});

// Hide/show the side panel; remembered per browser.
function setPanelHidden(hidden) {
  document.body.classList.toggle("panel-hidden", hidden);
  $("show-panel").hidden = !hidden;
  try {
    localStorage.setItem("panelHidden", hidden ? "1" : "0");
  } catch {}
}

$("hide-panel").addEventListener("click", () => setPanelHidden(true));
$("show-panel").addEventListener("click", () => setPanelHidden(false));
try {
  if (localStorage.getItem("panelHidden") === "1") setPanelHidden(true);
} catch {}

$("frame").addEventListener("click", () => viewer?.state.loaded && viewer.frameScene());
$("reset").addEventListener("click", () => viewer?.state.loaded && viewer.resetCamera());

// Open the scene from the current view next time (and from links to this page).
$("set-start").addEventListener("click", () => {
  if (!viewer?.state.loaded) return;
  const entity = cameraEntity();
  const p = entity.getPosition();
  const f = entity.forward;
  setStart({ position: [p.x, p.y, p.z], target: [p.x + f.x * 2, p.y + f.y * 2, p.z + f.z * 2] });
});

$("collision-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) loadCollision(glbDataUrl(await file.arrayBuffer()), file.name);
});

$("gen-run").addEventListener("click", generateCollisionMesh);

$("show-collision").addEventListener("change", (e) => {
  if (viewer?.state.loaded) viewer.state.collisionOverlayEnabled = e.target.checked;
});

$("settings-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    loadSettings(JSON.parse(await file.text()), file.name);
  } catch (err) {
    showStatus(`Invalid settings ${file.name}: ${err?.message ?? err}`, 0, true);
  }
});

// Drag & drop anywhere on the page: a splat, a .glb collision mesh or a settings.json.
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (++dragDepth === 1) $("drop-overlay").hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth === 0) $("drop-overlay").hidden = true;
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop-overlay").hidden = true;
  const file = e.dataTransfer.files[0];
  const name = file?.name.toLowerCase() ?? "";
  if (name.endsWith(".glb")) loadCollision(glbDataUrl(await file.arrayBuffer()), file.name);
  else if (name.endsWith(".json")) loadSettings(JSON.parse(await file.text()), file.name);
  else loadFile(file);
});

// Allow ?url=...&collision=...&settings=... for quick linking.
const query = new URLSearchParams(location.search);
const collisionUrl = query.get("collision");
if (collisionUrl) setCollision({ url: collisionUrl, name: decodeURIComponent(collisionUrl.split("/").pop()) });
const settingsUrl = query.get("settings");
if (settingsUrl) {
  try {
    scene.settings = importSettings(await (await fetch(settingsUrl)).json());
    $("settings-name").textContent = decodeURIComponent(settingsUrl.split("/").pop());
  } catch (err) {
    console.error(err);
    showStatus(`Failed to load settings ${settingsUrl}: ${err?.message ?? err}`, 0, true);
  }
}
if (scene.start) setStart(scene.start);
const initialUrl = query.get("url");
if (initialUrl) {
  $("url").value = initialUrl;
  loadUrl(initialUrl, true);
}
