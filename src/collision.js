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
