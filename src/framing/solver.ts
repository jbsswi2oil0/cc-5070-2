import type {
  Actor,
  CameraSolution,
  FramingConstraints,
  FramingSuggestion,
  ReasonCode,
  SafeNdc,
  SolverParams,
  TradeoffInfo,
} from './types';
import { buildPortals, evaluate, toViewSpace, type EvaluateResult } from './evaluate';
import { cameraFromParams, initialParams } from './geometry';
import { frameBasis } from './projection';
import { safeNdcFromMargins } from './sampling';
import { constraintsWithNormalizedMargins, effectiveCaps } from './caps';
import { clamp, type Vec3 } from './vector';

export interface SolveOptions {
  /** Previous chosen pose, used as a search seed and continuity reference. */
  previousParams?: SolverParams;
}

export interface SolveResult {
  camera: CameraSolution;
  evaluation: EvaluateResult;
  constraints: FramingConstraints;
  safe: SafeNdc;
  caps: ReturnType<typeof effectiveCaps>;
  fovCapDeg: number;
  requiredFovDeg: number;
  requiredHorizontalFovDeg: number;
  fitted: boolean;
  status: 'fitted' | 'tradeoff';
  reasons: ReasonCode[];
  tradeoff: TradeoffInfo | null;
  suggestion: FramingSuggestion | null;
  /** 'working' = working lens was enough; 'widened' = cap was needed; 'tradeoff' = cap insufficient. */
  lensMode: 'working' | 'widened' | 'tradeoff';
  evaluations: number;
}

interface PoseOutcome {
  params: SolverParams;
  fovDeg: number;
  distance: number;
  status: 'working' | 'widened' | 'tradeoff';
  evaluation: EvaluateResult;
  score: number;
}

/**
 * Shared-framing solver.
 *
 * Algorithm for a candidate pose (yaw fixed by the user; pitch, lateral shift
 * and height searched):
 *
 *  a. Try the working lens. Find the closest distance in [distanceMin, distanceMax]
 *     at which every body-envelope sample fits the safe rectangle. If one
 *     exists, the lens tightens to the exact minimum needed there, so the group
 *     fills the safe area instead of being arbitrarily far away.
 *  b. If no distance at the working lens fits, take the widest lens the caps
 *     allow at distanceMax. If that is enough, use it; lensMode = widened.
 *  c. If even the cap cannot fit the group, keep distanceMax and the cap lens,
 *     and choose the pose with the least weighted overflow; lensMode = tradeoff.
 *
 * Hard fov caps and distance limits are never exceeded. Fit is evaluated on the
 * sampled capsule surface, never on actor centres.
 */
export type SolveResultModel = SolveResult;

export function solveFraming(
  actors: Actor[],
  rawConstraints: FramingConstraints,
  options: SolveOptions = {},
): SolveResult {
  const constraints = constraintsWithNormalizedMargins(rawConstraints);
  const caps = effectiveCaps(constraints);
  const safe = safeNdcFromMargins(constraints.margins);
  // Solve against a slightly inset safe rectangle. The solver samples the body
  // envelope more coarsely than the report pass, and a body that lands exactly
  // on the boundary can read as a fraction of a percent outside. The inset
  // absorbs that discretisation so "fitted" also passes the dense check.
  const inset = 0.008;
  const solveSafe: SafeNdc = {
    left: safe.left + inset,
    right: safe.right - inset,
    top: safe.top - inset,
    bottom: safe.bottom + inset,
  };
  const portals = buildPortals(actors, 'solve');
  const aspect = constraints.aspect;
  const anchor = anchorPoint(actors);
  const working = clamp(constraints.workingFovDeg, constraints.fovMinDeg, caps.verticalFovCapDeg);
  let evaluations = 0;

  const makeCamera = (params: SolverParams, fovDeg: number): CameraSolution => {
    const cam = cameraFromParams(anchor, constraints.yawDeg, params, fovDeg, aspect);
    if (cam.position.y >= constraints.minCameraHeight - 1e-9) return cam;
    const lift = (constraints.minCameraHeight - cam.position.y) / Math.max(1e-6, cam.up.y);
    return cameraFromParams(
      anchor,
      constraints.yawDeg,
      { ...params, h: params.h + lift },
      fovDeg,
      aspect,
    );
  };

  const requiredAt = (params: SolverParams, safeRect: SafeNdc = solveSafe): { v: number; h: number; fitted: boolean } => {
    // Fov does not enter view-space coordinates, so any comfortably wide probe
    // gives the same required-fov thresholds; 85deg keeps samples in front.
    const probe = makeCamera(params, 85);
    const ev = evaluate(probe, toViewSpace(probe, portals), constraints, safeRect);
    evaluations++;
    return { v: ev.requiredFovDeg, h: ev.requiredHorizontalFovDeg, fitted: ev.fits };
  };

  /** Closest distance in range at which the pose needs at most `lens`. Null if none. */
  const closestFitDistance = (params: SolverParams, lens: number): number | null => {
    if (requiredAt({ ...params, r: constraints.distanceMin }).v <= lens + 1e-6) {
      return constraints.distanceMin;
    }
    const steps = 22;
    let lo = constraints.distanceMin;
    let hi = -1;
    for (let i = 1; i <= steps; i++) {
      const r = constraints.distanceMin + ((constraints.distanceMax - constraints.distanceMin) * i) / steps;
      if (requiredAt({ ...params, r }).v <= lens + 1e-6) {
        hi = r;
        break;
      }
      lo = r;
    }
    if (hi < 0) return null;
    // Bisect the boundary; `lo` is infeasible, `hi` feasible.
    for (let k = 0; k < 10; k++) {
      const mid: number = (lo + hi) / 2;
      if (requiredAt({ ...params, r: mid }).v <= lens + 1e-6) hi = mid;
      else lo = mid;
    }
    return hi;
  };

  const evaluatePose = (params: SolverParams): PoseOutcome => {
    const rWorking = closestFitDistance(params, working);
    if (rWorking !== null) {
      const need = requiredAt({ ...params, r: rWorking });
      const fovDeg = clamp(need.v + 0.3, constraints.fovMinDeg, working);
      return finishPose({ ...params, r: rWorking }, fovDeg, rWorking, 'working');
    }
    // Working lens cannot fit anywhere in range; try the hard cap at max distance.
    const atMax = { ...params, r: constraints.distanceMax };
    const needMax = requiredAt(atMax);
    if (needMax.v <= caps.verticalFovCapDeg + 1e-6) {
      const fovDeg = clamp(needMax.v + 0.3, working, caps.verticalFovCapDeg);
      return finishPose(atMax, fovDeg, constraints.distanceMax, 'widened');
    }
    return finishPose(atMax, caps.verticalFovCapDeg, constraints.distanceMax, 'tradeoff');
  };

  const finishPose = (
    params: SolverParams,
    fovDeg: number,
    distance: number,
    status: 'working' | 'widened' | 'tradeoff',
  ): PoseOutcome => {
    const cam = makeCamera(params, fovDeg);
    const ev = evaluate(cam, toViewSpace(cam, portals), constraints, solveSafe);
    evaluations++;
    let score: number;
    if (status === 'tradeoff') {
      // Lexicographic by design: first keep the most importance fully inside the
      // safe area, then share out the unavoidable overflow, then keep the camera
      // near the group axis. A squared overflow term would let one badly clipped
      // minor actor outvote saving the star of the shot, so the primary term
      // dominates and the rest is linear.
      let lostImportance = 0;
      let overflow = 0;
      for (const a of ev.actors) {
        const w = Math.max(1, a.report.importance);
        if (!a.report.insideSafe) lostImportance += w;
        overflow += w * a.report.maxOverflow;
      }
      const unionCx = (ev.union.left + ev.union.right) / 2;
      const unionCy = (ev.union.top + ev.union.bottom) / 2;
      score =
        lostImportance * 100 +
        overflow * 2 +
        Math.abs(params.s) * 0.3 +
        Math.abs(unionCx) * 0.4 +
        Math.abs(unionCy) * 0.4 +
        Math.max(0, params.h) * 0.4;
    } else {
      score = fitScore(params, cam, ev, safe, constraints, options.previousParams);
    }
    return { params, fovDeg, distance, status, evaluation: ev, score };
  };

  const seed: SolverParams = options.previousParams
    ? {
        ...options.previousParams,
        r: clamp(options.previousParams.r, constraints.distanceMin, constraints.distanceMax),
      }
    : initialParams(actors, constraints, constraints.yawDeg);

  // Greedy coordinate descent over lateral shift, height and pitch. Distance is
  // solved analytically per pose, so it is not a search dimension.
  let best = evaluatePose(seed);

  // In a tradeoff the useful question is *which* actors to keep fully framed, so
  // sweep the lateral axis across the whole group before descending. A local
  // gradient from the importance-weighted anchor can otherwise miss the pose
  // that saves the most important actor while only sacrificing the least.
  if (best.status === 'tradeoff') {
    const rightAt = frameBasis(constraints.yawDeg, 0).right;
    const laterals = actors.map(
      (a) => (a.position.x - anchor.x) * rightAt.x + (a.position.z - anchor.z) * rightAt.z,
    );
    const lo = Math.min(...laterals) - 2;
    const hi = Math.max(...laterals) + 2;
    for (let i = 0; i <= 10; i++) {
      const s = lo + ((hi - lo) * i) / 10;
      const cand = evaluatePose({ ...seed, s: clampParam('s', s, constraints) });
      if (isBetter(cand, best)) best = cand;
    }
  }
  const dims: Array<{ key: keyof SolverParams; step: number }> = [
    { key: 's', step: 1.4 },
    { key: 'h', step: 0.9 },
    { key: 'pitchDeg', step: 4.5 },
  ];
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const dim of dims) {
      for (const sign of [-1, 1]) {
        const trial: SolverParams = {
          ...best.params,
          [dim.key]: clampParam(dim.key, best.params[dim.key] + sign * dim.step, constraints),
        };
        if (nearlySame(trial, best.params)) continue;
        const cand = evaluatePose(trial);
        if (isBetter(cand, best)) {
          best = cand;
          moved = true;
        }
      }
    }
    if (!moved) for (const dim of dims) dim.step *= 0.5;
  }
  for (const dim of dims) {
    for (const sign of [-1, 1]) {
      const trial: SolverParams = {
        ...best.params,
        [dim.key]: clampParam(dim.key, best.params[dim.key] + sign * dim.step * 0.5, constraints),
      };
      if (nearlySame(trial, best.params)) continue;
      const cand = evaluatePose(trial);
      if (isBetter(cand, best)) best = cand;
    }
  }

  // Final lens: the dense, full-safe requirement at the chosen pose, padded so
  // no body edge sits exactly on a safe boundary. The working lens is a
  // preference, not a hard cap: if the dense check needs a little more, the
  // lens opens toward the hard cap and lensMode reports 'widened'.
  const finalNeed = requiredAt(best.params, safe);
  let finalLens = clamp(finalNeed.v + 0.4, constraints.fovMinDeg, caps.verticalFovCapDeg);
  if (best.status === 'tradeoff') finalLens = caps.verticalFovCapDeg;
  const camera = makeCamera(best.params, finalLens);
  const reportPortals = buildPortals(actors, 'report');
  const finalPair = { cam: camera, ev: evaluate(camera, toViewSpace(camera, reportPortals), constraints, safe) };
  const evaluation = finalPair.ev;
  evaluations++;

  const fitted = evaluation.fits && maxOverflow(evaluation) <= 2e-3;
  const reasons = diagnose(evaluation, constraints, caps, camera);
  const tradeoff = fitted ? null : buildTradeoff(evaluation, reasons, constraints, caps);
  const suggestion = fitted ? null : suggestFix(evaluation, camera, constraints, caps);
  const lensMode: SolveResult['lensMode'] = !fitted
    ? 'tradeoff'
    : best.status === 'working'
      ? 'working'
      : 'widened';

  return {
    camera,
    evaluation,
    constraints,
    safe,
    caps,
    fovCapDeg: caps.verticalFovCapDeg,
    requiredFovDeg: evaluation.requiredFovDeg,
    requiredHorizontalFovDeg: evaluation.requiredHorizontalFovDeg,
    fitted,
    status: fitted ? 'fitted' : 'tradeoff',
    reasons,
    tradeoff,
    suggestion,
    lensMode,
    evaluations,
  };
}

function isBetter(a: PoseOutcome, b: PoseOutcome): boolean {
  if (a.status !== b.status) {
    // working > widened > tradeoff
    const rank = { working: 0, widened: 1, tradeoff: 2 } as const;
    return rank[a.status] < rank[b.status];
  }
  return a.score < b.score - 1e-9;
}

/**
 * Composition quality for a pose that already fits. The primary term centres the
 * union of every body-envelope edge (not actor centres) in the safe rectangle;
 * the remaining terms keep the camera natural — near-level and not needlessly
 * high — and preserve continuity when scrubbing.
 */
function fitScore(
  params: SolverParams,
  cam: CameraSolution,
  ev: EvaluateResult,
  safe: SafeNdc,
  constraints: FramingConstraints,
  prev: SolverParams | undefined,
): number {
  const safeW = Math.max(1e-6, safe.right - safe.left);
  const safeH = Math.max(1e-6, safe.top - safe.bottom);
  const safeCx = (safe.left + safe.right) / 2;
  const safeCy = (safe.top + safe.bottom) / 2;
  const ucx = (ev.union.left + ev.union.right) / 2;
  const ucy = (ev.union.top + ev.union.bottom) / 2;
  let score = ((ucx - safeCx) / safeW) ** 2 + ((ucy - safeCy) / safeH) ** 2;

  // A weak, importance-weighted pull so the starring actors sit near the middle
  // of the frame rather than only the outer envelope being centred.
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (const a of ev.actors) {
    const w = Math.max(1, a.report.importance);
    sx += a.report.centerNdc.x * w;
    sy += a.report.centerNdc.y * w;
    sw += w;
  }
  if (sw > 0) {
    score += 0.25 * (((sx / sw - safeCx) / safeW) ** 2 + ((sy / sw - safeCy) / safeH) ** 2);
  }

  // Natural camera: prefer a level-ish gaze over a steep top-down so the actors
  // read as people rather than a plan view. The height term only bites once the
  // camera climbs above standing eye level.
  score += (params.pitchDeg / 18) ** 2 * 0.5;
  const eye = constraints.minCameraHeight + 1.55;
  score += (Math.max(0, cam.position.y - eye) / 4) ** 2 * 0.12;

  score += continuityCost(params, prev, constraints);
  return score;
}

function continuityCost(
  params: SolverParams,
  prev: SolverParams | undefined,
  constraints: FramingConstraints,
): number {
  if (!prev) return 0;
  const dr = (params.r - prev.r) / Math.max(1, constraints.distanceMax - constraints.distanceMin);
  const ds = (params.s - prev.s) / 8;
  const dh = (params.h - prev.h) / 5;
  const dp = (params.pitchDeg - prev.pitchDeg) / 45;
  return (dr * dr + ds * ds + dh * dh + dp * dp) * 0.25;
}

function clampParam(key: keyof SolverParams, value: number, constraints: FramingConstraints): number {
  if (key === 'r') return clamp(value, constraints.distanceMin, constraints.distanceMax);
  if (key === 's') return clamp(value, -24, 24);
  if (key === 'h') return clamp(value, -8, 8);
  return clamp(value, -60, 60);
}

function nearlySame(a: SolverParams, b: SolverParams): boolean {
  return (
    Math.abs(a.r - b.r) < 1e-4 &&
    Math.abs(a.s - b.s) < 1e-4 &&
    Math.abs(a.h - b.h) < 1e-4 &&
    Math.abs(a.pitchDeg - b.pitchDeg) < 1e-4
  );
}

function maxOverflow(ev: EvaluateResult): number {
  let worst = 0;
  for (const a of ev.actors) worst = Math.max(worst, a.report.maxOverflow);
  return worst;
}

function anchorPoint(actors: Actor[]): Vec3 {
  let wx = 0;
  let wy = 0;
  let wz = 0;
  let sum = 0;
  for (const a of actors) {
    const w = Math.max(1, a.importance);
    wx += a.position.x * w;
    wz += a.position.z * w;
    wy += (a.position.y + a.height * 0.5) * w;
    sum += w;
  }
  if (sum === 0) return { x: 0, y: 1, z: 0 };
  return { x: wx / sum, y: Math.max(0.2, wy / sum), z: wz / sum };
}

function diagnose(
  ev: EvaluateResult,
  constraints: FramingConstraints,
  caps: ReturnType<typeof effectiveCaps>,
  camera: CameraSolution,
): ReasonCode[] {
  const out: ReasonCode[] = [];
  if (ev.behind) out.push('actor-behind');
  const vStops = ev.requiredFovDeg > caps.verticalFovCapDeg + 1e-2;
  const hStops = ev.requiredHorizontalFovDeg > constraints.horizontalFovMaxDeg + 1e-2;
  if (vStops || hStops) {
    out.push(caps.binding === 'horizontal' || hStops ? 'horizontal-cap' : 'fov-cap');
  }
  if (vStops || hStops) {
    if (camera.distance >= constraints.distanceMax - 1e-2) out.push('distance-cap');
    if (camera.position.y <= constraints.minCameraHeight + 1e-3) out.push('camera-floor');
  }
  if (ev.actors.some((a) => !a.report.insideSafe) && !vStops && !hStops) out.push('margin');
  return Array.from(new Set(out));
}

function buildTradeoff(
  ev: EvaluateResult,
  reasons: ReasonCode[],
  constraints: FramingConstraints,
  caps: ReturnType<typeof effectiveCaps>,
): TradeoffInfo {
  const clipped = ev.actors
    .filter((a) => !a.report.insideSafe)
    .sort((a, b) => b.report.maxOverflow * b.report.importance - a.report.maxOverflow * a.report.importance);
  const worst = clipped[0]?.report.id ?? ev.worstId ?? null;
  const sentences: string[] = [];

  if (ev.requiredFovDeg > caps.verticalFovCapDeg + 1e-2) {
    const limitText =
      caps.binding === 'horizontal'
        ? `水平视场上限 ${constraints.horizontalFovMaxDeg.toFixed(0)}°（等价 ${caps.verticalFovCapDeg.toFixed(1)}° 垂直）`
        : `垂直视场上限 ${constraints.fovMaxDeg.toFixed(0)}°`;
    sentences.push(
      `完整框入全部身体边缘需 ${ev.requiredFovDeg.toFixed(1)}° 垂直视场（水平 ${ev.requiredHorizontalFovDeg.toFixed(1)}°），而${limitText}是硬上限。`,
    );
    sentences.push('镜头不越过上限扩张，改在边界内优先保住高重要性角色。');
  }
  if (reasons.includes('distance-cap')) {
    sentences.push(`距离已到上限 ${constraints.distanceMax.toFixed(1)} m。`);
  }
  if (reasons.includes('camera-floor')) {
    sentences.push(`机位受高度下限 ${constraints.minCameraHeight.toFixed(2)} m 限制。`);
  }
  if (reasons.includes('actor-behind')) {
    sentences.push('有角色落在机位后方，当前朝向无法同时包含。');
  }
  if (clipped.length > 0) {
    const detail = clipped
      .slice(0, 3)
      .map(
        (a) =>
          `${a.report.name}（${a.report.clippedSides.join('/')}，越界 ${(a.report.maxOverflow * 100).toFixed(1)}% 画面）`,
      )
      .join('；');
    sentences.push(`越界角色：${detail}。`);
    sentences.push(
      `取舍：按重要性从低到高接受越界，${clipped.length} 名角色未完整入画；仍保留共同构图，不以箭头或中心点代替取景。`,
    );
  }
  return {
    reasonCodes: reasons,
    clippedActors: clipped.map((a) => a.report.id),
    worstActorId: worst,
    summary: sentences.join(''),
    requiredFovDeg: ev.requiredFovDeg,
    requiredHorizontalFovDeg: ev.requiredHorizontalFovDeg,
    capDeg: caps.verticalFovCapDeg,
  };
}

function suggestFix(
  ev: EvaluateResult,
  camera: CameraSolution,
  constraints: FramingConstraints,
  caps: ReturnType<typeof effectiveCaps>,
): FramingSuggestion {
  const needV = Math.max(ev.requiredFovDeg, caps.verticalFovCapDeg);
  const needH = Math.max(ev.requiredHorizontalFovDeg, constraints.horizontalFovMaxDeg);
  const fovDelta = Math.max(1, Math.ceil(needV - caps.verticalFovCapDeg));
  const halfNow = Math.max(1e-4, (Math.min(camera.fovDeg, caps.verticalFovCapDeg) * Math.PI) / 360);
  const halfNeed = Math.max(1e-4, (ev.requiredFovDeg * Math.PI) / 360);
  const distToFit = (camera.distance * Math.tan(halfNow)) / Math.tan(halfNeed);
  const distanceDelta = Math.max(1, Math.ceil(distToFit - camera.distance));
  return {
    verticalFovDeg: Math.min(150, Math.ceil(needV * 10) / 10),
    horizontalFovDeg: Math.min(170, Math.ceil(needH * 10) / 10),
    distanceMax: Math.min(250, Math.ceil((constraints.distanceMax + distanceDelta) * 10) / 10),
    cheaper: fovDelta <= distanceDelta ? 'fov' : 'distance',
  };
}
