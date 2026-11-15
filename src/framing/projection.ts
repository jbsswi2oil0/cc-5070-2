import type { CameraSolution, SafeNdc } from './types';
import { type Vec3, add, rad, scale, cross, dot, normalize, sub, v3 } from './vector';

export interface FrameBasis {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

/**
 * Builds an orthonormal camera basis.

 * Forward = (sin yaw * cos pitch, sin pitch, cos yaw * cos pitch); 0 yaw looks
 * toward +Z, matching a Three.js camera at default orientation.
 * Right is always horizontal so the horizon stays level (no roll).
 */
export function frameBasis(yawDeg: number, pitchDeg: number): FrameBasis {
  const yaw = rad(yawDeg);
  const pitch = rad(pitchDeg);
  const forward = normalize(
    v3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)),
  );
  // Matches a Three.js camera: looking toward +Z means screen-right is -X.
  // Deriving right from the forward axis keeps the horizon level (no roll).
  let right = cross(forward, v3(0, 1, 0));
  if (Math.abs(dot(right, right)) < 1e-9) {
    right = v3(1, 0, 0);
  }
  right = normalize(right);
  const up = normalize(cross(right, forward));
  return { forward, right, up };
}

export interface Projected {
  /** NDC x, +1 at right edge. */
  x: number;
  /** NDC y, +1 at top edge. */
  y: number;
  /** View-space depth, positive in front of the camera. */
  depth: number;
  behind: boolean;
}

export function projectPoint(
  point: Vec3,
  cameraPos: Vec3,
  basis: FrameBasis,
  tanHalfV: number,
  aspect: number,
): Projected {
  const rel = sub(point, cameraPos);
  const depth = dot(rel, basis.forward);
  const xCam = dot(rel, basis.right);
  const yCam = dot(rel, basis.up);
  if (depth <= 1e-4) {
    return { x: 0, y: 0, depth, behind: true };
  }
  const tanHalfH = tanHalfV * aspect;
  return {
    x: xCam / (depth * tanHalfH),
    y: yCam / (depth * tanHalfV),
    depth,
    behind: false,
  };
}

/**
 * Vertical fov required to reach `ndcTarget` for a view-space offset.
 * For the horizontal axis pass offset xCam and `ndcTarget = safe.right`; the
 * returned value is the vertical fov that puts that sample exactly on the
 * horizontal safe edge at the current aspect.
 */
export function fovToReachNdc(
  offset: number,
  depth: number,
  ndcTarget: number,
  axis: 'x' | 'y',
  aspect: number,
): number {
  const t = Math.abs(offset) / (Math.max(depth, 1e-4) * Math.abs(ndcTarget));
  const half = Math.atan(t);
  const vHalf = axis === 'y' ? half : Math.atan(t / aspect);
  return (2 * vHalf * 180) / Math.PI;
}

export function solutionFromParams(
  anchor: Vec3,
  params: { r: number; s: number; h: number; pitchDeg: number },
  yawDeg: number,
  fovDeg: number,
  aspect: number,
): CameraSolution {
  const basis = frameBasis(yawDeg, params.pitchDeg);
  const position = add(
    add(add(anchor, scale(basis.forward, -params.r)), scale(basis.right, params.s)),
    scale(basis.up, params.h),
  );
  const horizontalFovDeg =
    (2 * Math.atan(Math.tan(rad(fovDeg) / 2) * aspect) * 180) / Math.PI;
  return {
    position,
    forward: basis.forward,
    right: basis.right,
    up: basis.up,
    target: add(position, scale(basis.forward, params.r)),
    yawDeg,
    pitchDeg: params.pitchDeg,
    fovDeg,
    horizontalFovDeg,
    distance: params.r,
    aspect,
    params: { ...params },
  };
}

export function safeRectContains(safe: SafeNdc, x: number, y: number): boolean {
  return x >= safe.left - 1e-9 && x <= safe.right + 1e-9 && y >= safe.bottom - 1e-9 && y <= safe.top + 1e-9;
}
