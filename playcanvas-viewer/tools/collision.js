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
