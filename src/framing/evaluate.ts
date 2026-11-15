import type {
  Actor,
  ActorFitReport,
  CameraSolution,
  FramingConstraints,
  SafeNdc,
} from './types';
import { sampleActorBody } from './sampling';
import { rad, type Vec3 } from './vector';

export interface ActorPortal {
  actor: Actor;
  samples: Vec3[];
}

export function buildPortals(actors: Actor[], density: 'solve' | 'report'): ActorPortal[] {
  return actors.map((actor) => ({
    actor,
    samples: sampleActorBody(
      actor,
      density === 'report' ? 31 : 15,
      density === 'report' ? 48 : 24,
    ).map((s) => s.point),
  }));
}

export interface ActorRel {
  actor: Actor;
  xCam: Float64Array;
  yCam: Float64Array;
  depth: Float64Array;
  behind: number;
}

export function toViewSpace(camera: CameraSolution, portals: ActorPortal[]): ActorRel[] {
  const { position, forward, right, up } = camera;
  const out: ActorRel[] = [];
  for (const { actor, samples } of portals) {
    const n = samples.length;
    const xCam = new Float64Array(n);
    const yCam = new Float64Array(n);
    const depth = new Float64Array(n);
    let behind = 0;
    for (let i = 0; i < n; i++) {
      const dx = samples[i].x - position.x;
      const dy = samples[i].y - position.y;
      const dz = samples[i].z - position.z;
      xCam[i] = dx * right.x + dy * right.y + dz * right.z;
      yCam[i] = dx * up.x + dy * up.y + dz * up.z;
      depth[i] = dx * forward.x + dy * forward.y + dz * forward.z;
      if (depth[i] <= 1e-4) behind++;
    }
    out.push({ actor, xCam, yCam, depth, behind });
  }
  return out;
}

export interface ActorEvaluation {
  report: ActorFitReport;
  /** Vertical fov that would put this actor's envelope exactly on the vertical safe edges. */
  requiredVerticalFovDeg: number;
  /** Horizontal fov required for its envelope, actual horizontal fov. */
  requiredHorizontalFovDeg: number;
  /** Max NDC overflow across all samples, 0 when fully inside. */
  overflow: number;
}

/**
 * Minimum fov containing the whole envelope for a fixed pose. Thresholds are
 * sign-aware: a point above the axis only needs to clear the top safe edge, a
 * point below only the bottom edge. With symmetric margins this is the same as
 * the simple max, but asymmetric margins would otherwise be over-constrained.
 * Because fov does not affect view-space coordinates, this threshold is exact.
 */
export function requiredFovForActor(
  rel: ActorRel,
  safe: SafeNdc,
  aspect: number,
): { vertical: number; horizontal: number } {
  let needV = 0;
  let needH = 0;
  const n = rel.depth.length;
  for (let i = 0; i < n; i++) {
    const d = rel.depth[i];
    if (d <= 1e-4) {
      needV = Math.max(needV, 179);
      continue;
    }
    const x = rel.xCam[i];
    const y = rel.yCam[i];
    // Vertical: tan(V/2) >= |y| / (d * |edge|)
    const vEdge = y >= 0 ? Math.abs(safe.top) : Math.abs(safe.bottom);
    needV = Math.max(
      needV,
      (2 * Math.atan(Math.abs(y) / (d * Math.max(1e-6, vEdge))) * 180) / Math.PI,
    );
    // Horizontal: tan(H/2) >= |x| / (d * |edge|)
    const hEdge = x >= 0 ? Math.abs(safe.right) : Math.abs(safe.left);
    needH = Math.max(
      needH,
      (2 * Math.atan(Math.abs(x) / (d * Math.max(1e-6, hEdge))) * 180) / Math.PI,
    );
  }
  // Express the horizontal requirement as the vertical fov that produces the
  // same horizontal half-angle at this aspect.
  const verticalFromHorizontal =
    (2 * Math.atan(Math.tan(rad(needH) / 2) / Math.max(0.05, aspect)) * 180) / Math.PI;
  return {
    vertical: Math.max(needV, verticalFromHorizontal),
    horizontal: needH,
  };
}

export function evaluateActor(
  rel: ActorRel,
  camera: CameraSolution,
  constraints: FramingConstraints,
  safe: SafeNdc,
  densityForReports = true,
): ActorEvaluation {
  const tanHalfV = Math.tan(rad(camera.fovDeg) / 2);
  const tanHalfH = tanHalfV * constraints.aspect;
  const n = rel.depth.length;
  let bLeft = Infinity;
  let bRight = -Infinity;
  let bTop = -Infinity;
  let bBottom = Infinity;
  let overflow = 0;
  let insideCount = 0;
  let visible = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let behind = 0;
  let minDepth = Infinity;
  for (let i = 0; i < n; i++) {
    const d = rel.depth[i];
    if (d <= 1e-4) {
      behind++;
      continue;
    }
    minDepth = Math.min(minDepth, d);
    visible++;
    const x = rel.xCam[i] / (d * tanHalfH);
    const y = rel.yCam[i] / (d * tanHalfV);
    cx += x;
    cy += y;
    cz += d;
    if (x < bLeft) bLeft = x;
    if (x > bRight) bRight = x;
    if (y > bTop) bTop = y;
    if (y < bBottom) bBottom = y;
    if (x >= safe.left && x <= safe.right && y >= safe.bottom && y <= safe.top) insideCount++;
    overflow = Math.max(
      overflow,
      x < safe.left ? safe.left - x : 0,
      x > safe.right ? x - safe.right : 0,
      y > safe.bottom ? safe.bottom - y : 0,
      y > safe.top ? safe.top - y : 0,
    );
  }

  const clippedSides: ActorFitReport['clippedSides'] = [];
  if (behind > 0) clippedSides.push('behind');
  if (bLeft < safe.left) clippedSides.push('left');
  if (bRight > safe.right) clippedSides.push('right');
  if (bTop > safe.top) clippedSides.push('top');
  if (bBottom < safe.bottom) clippedSides.push('bottom');

  const req = requiredFovForActor(rel, safe, constraints.aspect);
  void densityForReports;
  void minDepth;
  return {
    report: {
      id: rel.actor.id,
      name: rel.actor.name,
      importance: rel.actor.importance,
      color: rel.actor.color,
      bboxNdc: { left: bLeft, right: bRight, top: bTop, bottom: bBottom },
      centerNdc: {
        x: cx / Math.max(1, visible),
        y: cy / Math.max(1, visible),
        z: cz / Math.max(1, visible),
      },
      insideSafe: insideCount === n && behind === 0,
      pointsBehind: behind,
      clippedSides,
      overflow: {
        left: Math.max(0, safe.left - bLeft),
        right: Math.max(0, bRight - safe.right),
        top: Math.max(0, bTop - safe.top),
        bottom: Math.max(0, safe.bottom - bBottom),
      },
      maxOverflow: overflow,
      coverage: insideCount / n,
      sampleCount: n,
      projectedArea: Math.max(0, bRight - bLeft) * Math.max(0, bTop - bBottom),
    },
    requiredVerticalFovDeg: req.vertical,
    requiredHorizontalFovDeg: req.horizontal,
    overflow,
  };
}

export interface EvaluateResult {
  actors: ActorEvaluation[];
  fits: boolean;
  cost: number;
  worstId: string | null;
  worstOverflow: number;
  requiredFovDeg: number;
  requiredHorizontalFovDeg: number;
  union: { left: number; right: number; top: number; bottom: number };
  behind: boolean;
  cameraFloorViolation: number;
}

export function evaluate(
  camera: CameraSolution,
  rel: ActorRel[],
  constraints: FramingConstraints,
  safe: SafeNdc,
  { densityForReports = false }: { densityForReports?: boolean } = {},
): EvaluateResult {
  const evals = rel.map((r) => evaluateActor(r, camera, constraints, safe, densityForReports));
  let fits = true;
  let cost = 0;
  let worstId: string | null = null;
  let worstOverflow = 0;
  let requiredFovDeg = 0;
  let requiredHorizontalFovDeg = 0;
  let uLeft = Infinity;
  let uRight = -Infinity;
  let uTop = -Infinity;
  let uBottom = Infinity;
  let behind = false;
  let behindCount = 0;
  for (const ev of evals) {
    if (!ev.report.insideSafe) fits = false;
    if (ev.report.pointsBehind > 0) {
      behind = true;
      behindCount += ev.report.pointsBehind;
    }
    const ov = ev.overflow;
    cost += ev.report.importance * ov * ov;
    if (ov > worstOverflow) {
      worstOverflow = ov;
      worstId = ev.report.id;
    }
    requiredFovDeg = Math.max(requiredFovDeg, ev.requiredVerticalFovDeg);
    requiredHorizontalFovDeg = Math.max(requiredHorizontalFovDeg, ev.requiredHorizontalFovDeg);
    uLeft = Math.min(uLeft, ev.report.bboxNdc.left);
    uRight = Math.max(uRight, ev.report.bboxNdc.right);
    uTop = Math.max(uTop, ev.report.bboxNdc.top);
    uBottom = Math.min(uBottom, ev.report.bboxNdc.bottom);
  }
  const safeW = safe.right - safe.left;
  const safeH = safe.top - safe.bottom;
  if (Number.isFinite(uLeft) && Number.isFinite(uRight)) {
    const cx = (uLeft + uRight) / 2;
    const cy = (uTop + uBottom) / 2;
    const dx = (cx - (safe.left + safe.right) / 2) / safeW;
    const dy = (cy - (safe.top + safe.bottom) / 2) / safeH;
    cost += (dx * dx + dy * dy) * 2e-3;
  } else {
    cost += 1;
  }
  cost += behindCount * 0.5;
  const cameraFloorViolation = Math.max(0, constraints.minCameraHeight - camera.position.y);
  cost += cameraFloorViolation * cameraFloorViolation * 200;
  return {
    actors: evals,
    fits,
    cost,
    worstId,
    worstOverflow,
    requiredFovDeg,
    requiredHorizontalFovDeg,
    union: { left: uLeft, right: uRight, top: uTop, bottom: uBottom },
    behind,
    cameraFloorViolation,
  };
}
