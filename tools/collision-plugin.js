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
