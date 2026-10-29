// Pick a starting camera inside an interior scan (a room or a house), from the PLY's splat
// positions, before the viewer is created. The viewer treats a scene whose initial camera
// is inside its bounding box as an interior: it starts in fly/walk instead of orbiting.

const TYPE_SIZES = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
};

const EYE_HEIGHT = 1.6;
const MAX_SAMPLES = 200_000;

// Positions (x, y, z per splat, sampled) of a binary little-endian PLY, or null when the file
// isn't one with plain float positions (e.g. a .compressed.ply).
function readPlyPositions(buffer) {
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 64 * 1024)));
  const end = head.indexOf("end_header\n");
  if (!head.startsWith("ply") || end < 0 || !head.includes("format binary_little_endian")) return null;

  // Elements in file order, each with its properties' offsets within a row.
  const elements = [];
  for (const line of head.slice(0, end).split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words[0] === "element") elements.push({ name: words[1], count: Number(words[2]), props: {}, stride: 0 });
    else if (words[0] === "property") {
      const el = elements.at(-1);
      const size = TYPE_SIZES[words[1]];
      if (!el || !size) return null; // list properties aren't used by splat PLYs
      el.props[words[2]] = { type: words[1], offset: el.stride };
      el.stride += size;
    }
  }

  let offset = end + "end_header\n".length;
  for (const el of elements) {
    if (el.name !== "vertex") {
      offset += el.count * el.stride;
      continue;
    }
    const { x, y, z } = el.props;
    if (![x, y, z].every((p) => p?.type === "float" || p?.type === "float32")) return null;
    if (offset + el.count * el.stride > buffer.byteLength) return null;

    const view = new DataView(buffer, offset);
    const step = Math.max(1, Math.floor(el.count / MAX_SAMPLES));
    const n = Math.floor(el.count / step);
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const row = i * step * el.stride;
      out[i * 3] = view.getFloat32(row + x.offset, true);
      out[i * 3 + 1] = view.getFloat32(row + y.offset, true);
      out[i * 3 + 2] = view.getFloat32(row + z.offset, true);
    }
    return out;
  }
  return null;
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// { position, target } in the viewer's world space, or null if the file can't be read.
export function interiorStartPose(buffer) {
  const points = readPlyPositions(buffer);
  if (!points?.length) return null;

  // The viewer rotates the PLY 180° about Z: world = (-x, -y, z). That turns the usual Y-down
  // capture (COLMAP/INRIA) Y-up.
  const axes = [[], [], []];
  for (let i = 0; i < points.length; i += 3) {
    const vals = [-points[i], -points[i + 1], points[i + 2]];
    if (!vals.every(Number.isFinite)) continue;
    for (let a = 0; a < 3; a++) axes[a].push(vals[a]);
  }
  if (!axes[0].length) return null;
  // Robust extents: ignore the outermost few percent, where floaters and sky splats live.
  const [lo, hi] = axes.map((v) => {
    v.sort((a, b) => a - b);
    return [percentile(v, 0.03), percentile(v, 0.97)];
  }).reduce(([l, h], [a, b]) => [[...l, a], [...h, b]], [[], []]);

  const center = lo.map((v, i) => (v + hi[i]) / 2);
  const floor = lo[1];
  const height = hi[1] - lo[1];
  // Eye height above the floor, kept below the ceiling when the scan is small or not in metres.
  const eye = floor + Math.min(EYE_HEIGHT, height * 0.6);

  // Look along the longer horizontal side of the space.
  const alongX = hi[0] - lo[0] >= hi[2] - lo[2];
  const reach = Math.max(alongX ? hi[0] - lo[0] : hi[2] - lo[2], 0.1) / 2;
  const position = [center[0], eye, center[2]];
  const target = alongX ? [center[0] + reach, eye, center[2]] : [center[0], eye, center[2] + reach];
  return { position, target };
}
