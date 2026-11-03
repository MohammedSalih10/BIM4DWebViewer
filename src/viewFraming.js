// Camera framing shared by every viewer in this app.
//
// Both of these were worked out by measuring the real model in a browser, and both
// exist because the obvious approach puts the building at about a third of the size it
// should be. Keep them here rather than copying them per viewer -- the numbers below
// are the result of measurement, not taste, and they should not drift apart.
import * as THREE from "three";

/** The direction the camera sits in from the model centre. */
export const VIEW_DIR = new THREE.Vector3(0.72, 0.5, 0.72).normalize();

/**
 * The bounding box to frame the camera on: the BUILDING, not the site.
 *
 * Measured problem this solves. The full model spans 80.6 x 23.0 x 85.4 while the
 * building itself is a fraction of that, because the terrain "Surface" and the
 * scattered planting/lawn elements sit far out across the site. Dropping the site
 * CATEGORY alone is not enough (it only gets 85.4 down to 62.8); the scattered planting
 * has to go too.
 *
 * So: measure every element's own bounding box, then keep only those whose centroid
 * lies inside the central 96% on all three axes, and union the kept boxes. That is
 * robust to any number of far-flung outliers without needing to name them, and it
 * cannot clip the building itself -- perimeter walls sit at the edge of the dense
 * cluster, not outside it. Falls back to the full box whenever anything is missing.
 *
 * Returns { frame, full }: the box to aim at, and the whole model's box (which callers
 * still need, e.g. to sit a shadow-catcher plane on the real ground).
 */
export function buildingFrameBox(model, excludeIds, label = "view") {
  const full = new THREE.Box3().setFromObject(model);
  const pos = model.geometry?.attributes?.position;
  const idAttr = model.geometry?.attributes?.expressID;
  if (!pos || !idAttr) return { frame: full, full };

  // One bounding box per element, in model space: [minX,minY,minZ, maxX,maxY,maxZ].
  const bounds = new Map();
  for (let i = 0; i < pos.count; i++) {
    const id = idAttr.getX(i);
    if (excludeIds?.has(id)) continue;
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const b = bounds.get(id);
    if (!b) { bounds.set(id, [x, y, z, x, y, z]); continue; }
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (z < b[2]) b[2] = z;
    if (x > b[3]) b[3] = x;
    if (y > b[4]) b[4] = y;
    if (z > b[5]) b[5] = z;
  }
  if (!bounds.size) return { frame: full, full };

  const boxes = [...bounds.values()];
  const centroid = (b, a) => (b[a] + b[a + 3]) / 2;
  const pick = (sorted, p) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

  const lo = [], hi = [];
  for (let a = 0; a < 3; a++) {
    const sorted = boxes.map(b => centroid(b, a)).sort((m, n) => m - n);
    lo.push(pick(sorted, 0.02));
    hi.push(pick(sorted, 0.98));
  }

  const box = new THREE.Box3();
  let kept = 0;
  for (const b of boxes) {
    if ([0, 1, 2].some(a => centroid(b, a) < lo[a] || centroid(b, a) > hi[a])) continue;
    kept++;
    box.expandByPoint(new THREE.Vector3(b[0], b[1], b[2]));
    box.expandByPoint(new THREE.Vector3(b[3], b[4], b[5]));
  }
  if (box.isEmpty()) return { frame: full, full };

  box.applyMatrix4(model.matrixWorld);
  return { frame: box, full };
}

/**
 * Points `camera` at `box` and fits `sun`'s shadow frustum to `shadowBox`.
 *
 * The two boxes are separate on purpose. What you want to LOOK at is the building; what
 * has to be inside the shadow frustum is everything that casts or receives, which on a
 * site model is much larger. Fitting the shadow camera to the framing box leaves the
 * outer two thirds of the terrain receiving no shadow at all.
 *
 * The distance is solved from the box's eight CORNERS projected onto the camera's own
 * axes, not from its bounding sphere. A sphere fit is what left the building filling
 * about a third of the frame: a 35.7 x 17.9 x 29.5 building has a bounding sphere of
 * radius 24.8, and from a three-quarter view its silhouette is nothing like that wide,
 * so the extra radius is pure empty margin. Projecting the corners asks the only
 * question that matters -- how far back must the camera be for every corner to be on
 * screen -- and testing horizontal and vertical fields separately handles the tall,
 * narrow viewports of a split view correctly, where the HORIZONTAL field is the binding
 * constraint and a vertical-only fit leaves the model far too small.
 *
 * Returns { center, radius } so callers can place their own shadow-catcher plane.
 */
export function frameCamera({ camera, controls, sun }, box, shadowBox) {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) || 1;

  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (camera.aspect || 1));
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), VIEW_DIR).normalize();
  const up = new THREE.Vector3().crossVectors(VIEW_DIR, right).normalize();
  const tanH = Math.tan(hFov / 2);
  const tanV = Math.tan(vFov / 2);

  let dist = 0;
  const c = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    c.set(i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z).sub(center);
    const depth = c.dot(VIEW_DIR);                 // toward the camera is positive
    dist = Math.max(dist,
                    depth + Math.abs(c.dot(right)) / tanH,
                    depth + Math.abs(c.dot(up)) / tanV);
  }
  dist = Math.max(dist, radius * 0.5) * 1.06;      // 6% breathing room

  camera.position.copy(center).addScaledVector(VIEW_DIR, dist);
  camera.near = Math.max(radius / 1000, 0.01);
  camera.far = dist * 40;
  camera.updateProjectionMatrix();
  if (controls) {
    controls.target.copy(center);
    controls.update();
  }

  if (sun) {
    // Big enough, measured from the framing centre, to enclose everything that casts or
    // receives -- the shadow camera is centred on `center`, so an offset shadowBox needs
    // the distance to its farthest corner, not just its own half-size.
    let shadowR = radius;
    const sBox = shadowBox || box;
    const p = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? sBox.max.x : sBox.min.x,
            i & 2 ? sBox.max.y : sBox.min.y,
            i & 4 ? sBox.max.z : sBox.min.z);
      shadowR = Math.max(shadowR, p.distanceTo(center));
    }

    sun.position.set(center.x + shadowR, center.y + shadowR * 1.6, center.z + shadowR * 0.7);
    sun.target.position.copy(center);
    const sc = sun.shadow.camera;
    sc.left = -shadowR; sc.right = shadowR;
    sc.top = shadowR; sc.bottom = -shadowR;
    sc.near = 0.1; sc.far = shadowR * 8;
    sc.updateProjectionMatrix();
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.normalBias = shadowR * 0.002;   // DoubleSide geometry self-shadows
  }

  return { center, radius };
}

/**
 * A shadow-catcher plane sized to `radius`, sitting at `groundY`.
 *
 * ONLY add this when the model has no ground surface of its own. If the file carries a
 * terrain, that terrain both casts and receives, and an extra plane underneath it picks
 * up the TERRAIN'S OWN SHADOW -- which renders as a huge hard-edged dark quadrilateral
 * offset from the site in the sun's direction, and reads as a misaligned second
 * footprint. That is a real bug this project hit, not a hypothetical.
 */
export function makeShadowGround(center, radius, groundY) {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 8, radius * 8),
    new THREE.ShadowMaterial({ opacity: 0.28 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(center.x, groundY, center.z);
  ground.receiveShadow = true;
  return ground;
}
