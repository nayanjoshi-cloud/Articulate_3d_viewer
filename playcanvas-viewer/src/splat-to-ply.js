// Convert a .splat file (the antimatter15/splat format) to a standard 3DGS .ply, which the
// PlayCanvas engine can load. Each splat is 32 bytes:
//   position float32 x3 · scale float32 x3 (linear) · colour uint8 RGBA · rotation uint8 x4 (w, x, y, z)
// The positions are in the same space as the PLY the .splat was made from, so no axis change.

const SH_C0 = 0.28209479177387814;
const ROW = 32;
const PROPS = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];

export function splatToPly(buffer) {
  if (buffer.byteLength % ROW !== 0) throw new Error(`not a .splat file (size isn't a multiple of ${ROW} bytes)`);
  const count = buffer.byteLength / ROW;
  if (!count) throw new Error("empty .splat file");

  const header = new TextEncoder().encode(
    `ply\nformat binary_little_endian 1.0\nelement vertex ${count}\n${PROPS.map((p) => `property float ${p}`).join("\n")}\nend_header\n`,
  );
  const out = new ArrayBuffer(header.length + count * PROPS.length * 4);
  new Uint8Array(out).set(header);

  const src = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // Rows are written as bytes: the header length isn't 4-aligned in general.
  const values = new Float32Array(PROPS.length);
  const rowBytes = new Uint8Array(values.buffer);
  const dstBytes = new Uint8Array(out, header.length);

  for (let i = 0; i < count; i++) {
    const s = i * ROW;
    values[0] = src.getFloat32(s, true);
    values[1] = src.getFloat32(s + 4, true);
    values[2] = src.getFloat32(s + 8, true);
    // colour = 0.5 + SH_C0 * f_dc
    for (let c = 0; c < 3; c++) values[3 + c] = (bytes[s + 24 + c] / 255 - 0.5) / SH_C0;
    // alpha = sigmoid(opacity)
    const a = Math.min(Math.max(bytes[s + 27] / 255, 1e-4), 1 - 1e-4);
    values[6] = -Math.log(1 / a - 1);
    // PLY scales are log scales
    for (let c = 0; c < 3; c++) values[7 + c] = Math.log(Math.max(src.getFloat32(s + 12 + c * 4, true), 1e-8));
    // rotation: byte = q * 128 + 128
    let len = 0;
    for (let c = 0; c < 4; c++) {
      values[10 + c] = (bytes[s + 28 + c] - 128) / 128;
      len += values[10 + c] ** 2;
    }
    len = Math.sqrt(len) || 1;
    for (let c = 0; c < 4; c++) values[10 + c] /= len;
    dstBytes.set(rowBytes, i * PROPS.length * 4);
  }
  return out;
}
