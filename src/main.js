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
