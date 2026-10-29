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
