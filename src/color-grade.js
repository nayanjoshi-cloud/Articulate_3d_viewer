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
