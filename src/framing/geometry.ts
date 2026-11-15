import type { CameraSolution, FramingConstraints, SolverParams } from './types';
import { frameBasis } from './projection';
import { add, scale, rad, deg, type Vec3, cross, dot, normalize, sub } from './vector';

export function verticalFromHorizontal(hDeg: number, aspect: number): number {
  return deg(2 * Math.atan(Math.tan(rad(hDeg) / 2) / Math.max(0.05, aspect)));
}

export function horizontalFromVertical(vDeg: number, aspect: number): number {
  return deg(2 * Math.atan(Math.tan(rad(vDeg) / 2) * Math.max(0.05, aspect)));
}

export function cameraFromParams(
  anchor: Vec3,
  yawDeg: number,
  params: SolverParams,
  fovDeg: number,
  aspect: number,
): CameraSolution {
  const basis = frameBasis(yawDeg, params.pitchDeg);
  const position = add(
    add(add(anchor, scale(basis.forward, -params.r)), scale(basis.right, params.s)),
    scale(basis.up, params.h),
  );
  // Aiming stays on the forward axis, so screen-right/up match the basis and the
  // project()/unproject() in the renderer agree with the solver.
  const target = add(position, scale(basis.forward, params.r));
  return {
    position,
    forward: basis.forward,
    right: basis.right,
    up: basis.up,
    target,
    yawDeg,
    pitchDeg: params.pitchDeg,
    fovDeg,
    horizontalFovDeg: horizontalFromVertical(fovDeg, aspect),
    distance: params.r,
    aspect,
    params: { ...params },
  };
}

/** Bounding sphere of the actors, used only as a start point for the solver. */
export function actorBoundingSphere(
  actors: Array<{ position: Vec3; height: number; radius: number }>,
): { center: Vec3; radius: number } {
  if (actors.length === 0) return { center: { x: 0, y: 0, z: 0 }, radius: 1 };
  let cx = 0;
  let cz = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  let sumW = 0;
  for (const a of actors) {
    const w = 1;
    cx += a.position.x * w;
    cz += a.position.z * w;
    sumW += w;
    minY = Math.min(minY, a.position.y);
    maxY = Math.max(maxY, a.position.y + a.height);
  }
  const center = { x: cx / sumW, y: (minY + maxY) / 2, z: cz / sumW };
  let radius = 0;
  for (const a of actors) {
    const top = { x: a.position.x, y: a.position.y + a.height, z: a.position.z };
    const feet = { x: a.position.x, y: a.position.y, z: a.position.z };
    radius = Math.max(
      radius,
      Math.hypot(top.x - center.x, top.y - center.y, top.z - center.z) + a.radius,
      Math.hypot(feet.x - center.x, feet.y - center.y, feet.z - center.z) + a.radius,
    );
  }
  return { center, radius };
}

export function distanceForFov(
  sphereRadius: number,
  vFovDeg: number,
  aspect: number,
  hCapDeg: number,
): number {
  // Fit the sphere inside the tighter of the two safe half-angles.
  const vHalf = rad(vFovDeg) / 2;
  const hHalf = rad(verticalFromHorizontal(hCapDeg, aspect)) / 2;
  const half = Math.min(vHalf, hHalf) * 0.92;
  if (half <= 1e-5) return Infinity;
  return sphereRadius / Math.sin(half);
}

export function initialParams(
  actors: Array<{ position: Vec3; height: number; radius: number; importance: number }>,
  constraints: FramingConstraints,
  yawDeg: number,
): SolverParams {
  const sphere = actorBoundingSphere(actors);
  const targetFov = Math.min(
    constraints.fovMaxDeg,
    verticalFromHorizontal(constraints.horizontalFovMaxDeg, constraints.aspect),
    Math.max(constraints.fovMinDeg, constraints.workingFovDeg),
  );
  const r = Math.min(
    constraints.distanceMax,
    Math.max(
      constraints.distanceMin,
      distanceForFov(sphere.radius, targetFov, constraints.aspect, constraints.horizontalFovMaxDeg),
    ),
  );
  // Start near standing eye height rather than high above the group, so the
  // descent begins from a natural shot instead of a plan view.
  const camY = clampRange(
    sphere.center.y + sphere.radius * 0.12,
    constraints.minCameraHeight + 1.45,
    constraints.minCameraHeight + 2.9,
  );
  const pitch = deg(Math.atan2(sphere.center.y - camY, Math.max(1, r)));
  void yawDeg;
  return { r, s: 0, h: 0, pitchDeg: pitch };
}

function clampRange(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Camera aimed at an explicit target, with a level horizon. Used by the
 * renderer and overlay so the displayed frame matches the solver exactly.
 */
export function cameraLookAt(
  position: Vec3,
  target: Vec3,
  fovDeg: number,
  aspect: number,
): CameraSolution {
  const forward = normalize(sub(target, position));
  let right = cross(forward, { x: 0, y: 1, z: 0 });
  if (Math.abs(dot(right, right)) < 1e-9) right = { x: 1, y: 0, z: 0 };
  right = normalize(right);
  const up = normalize(cross(right, forward));
  const pitchDeg = deg(Math.asin(Math.max(-1, Math.min(1, forward.y))));
  const yawDeg = deg(Math.atan2(forward.x, forward.z));
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const dz = target.z - position.z;
  const distance = Math.hypot(dx, dy, dz);
  return {
    position,
    forward,
    right,
    up,
    target,
    yawDeg,
    pitchDeg,
    fovDeg,
    horizontalFovDeg: horizontalFromVertical(fovDeg, aspect),
    distance,
    aspect,
    params: { r: distance, s: 0, h: 0, pitchDeg },
  };
}
