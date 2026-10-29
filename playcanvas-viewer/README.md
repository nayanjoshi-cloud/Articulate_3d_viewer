# Splat Viewer (PlayCanvas)

A 3D Gaussian Splat viewer built on [`@playcanvas/supersplat-viewer`](https://github.com/playcanvas/supersplat-viewer)
(the SuperSplat viewer, on the PlayCanvas engine). It opens interior scans (rooms, houses)
from inside the room.

```sh
npm install
npm run dev        # http://localhost:5173 (also on the LAN)
```

Open a `.ply`, `.compressed.ply`, `.sog` or `.splat` (button, drag & drop, or URL). A `.splat` is
converted to a `.ply` in the browser first (the engine doesn't read `.splat`). Drop a `.glb` collision mesh or a SuperSplat
`settings.json` onto the page to load those too.

## Starting inside the room

The starting camera is, in order:

1. The view saved with **Set start view here** (stored in the page URL as `?start=`, so a link opens there).
2. The camera in a loaded `settings.json`.
3. Automatic: the centre of the room at about 1.6 m eye height, looking along the room's
   longer side. It is worked out from the PLY's splat positions, ignoring the outer 3 % (floaters).

The viewer opens in Fly mode, or Walk mode when a collision mesh is loaded.

## URL parameters

| Parameter   | Example                                   |
| ----------- | ----------------------------------------- |
| `url`       | `?url=/scenes/house.ply`                  |
| `start`     | `&start=px,py,pz,tx,ty,tz` (camera position, look-at target) |
| `collision` | `&collision=/scenes/house.collision.glb`  |
| `settings`  | `&settings=/scenes/settings.json`         |

## Collision (Walk mode)

Fly to a spot in the open middle of a room and press **Generate collision mesh**. This runs
PlayCanvas splat-transform on this machine, so it only works under `npm run dev` or
`npm run preview`. From the command line:

```sh
npm run collision -- house.ply --seed x,y,z
```

`x,y,z` is a camera position from this viewer: its world space is the same space splat-transform uses.
