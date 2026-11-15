/**
 * Pure acceptance policy for the shared-framing release.
 *
 * These functions are the single source of truth the runner and the unit tests
 * both use. They take plain data, return a verdict, and never touch the DOM or a
 * browser — so the "missing actor data fails" and "do not adopt on failure"
 * rules are provable without a live run.
 */

export interface FovLimits {
  verticalMaxDeg: number;
  horizontalMaxDeg: number;
  verticalMinDeg: number;
}

export interface ScreenRange {
  safeLeft: [number, number];
  safeRightEdge: [number, number];
  safeTop: [number, number];
  safeBottomEdge: [number, number];
  targetInsideSafeTolerancePx: number;
}

export interface BodySizeRule {
  minHeightSpreadMeters: number;
  minRadiusSpreadMeters: number;
}

export interface Verdict {
  ok: boolean;
  detail: string;
}

const inRange = (v: number, [lo, hi]: [number, number]): boolean => v >= lo - 1e-9 && v <= hi + 1e-9;

/**
 * Every required actor id must be present. A missing actor is a hard failure:
 * a shared frame that silently dropped a character is not the requested shot.
 */
export function checkActorsPresent(
  requiredIds: string[],
  actors: Array<{ id: string }>,
): Verdict {
  const ids = new Set(actors.map((a) => a.id));
  const missing = requiredIds.filter((id) => !ids.has(id));
  if (missing.length > 0) {
    return { ok: false, detail: `缺少角色 ${missing.join(', ')}（数据不齐，拒绝验收）` };
  }
  return { ok: true, detail: `${requiredIds.length} 名必需角色齐全` };
}

/**
 * The deployed cast must actually vary in body size. Sampling one template for
 * everyone would not exercise the envelope, so the height and radius spreads
 * both have to clear the configured minimums.
 */
export function checkBodySizeSpread(
  actors: Array<{ height: number; radius: number }>,
  rule: BodySizeRule,
): Verdict {
  if (actors.length === 0) return { ok: false, detail: '没有角色，无法评估体型' };
  const heights = actors.map((a) => a.height);
  const radii = actors.map((a) => a.radius);
  const hSpread = Math.max(...heights) - Math.min(...heights);
  const rSpread = Math.max(...radii) - Math.min(...radii);
  const ok = hSpread >= rule.minHeightSpreadMeters && rSpread >= rule.minRadiusSpreadMeters;
  return {
    ok,
    detail: `身高差 ${hSpread.toFixed(2)}m≥${rule.minHeightSpreadMeters} · 半径差 ${rSpread.toFixed(2)}m≥${rule.minRadiusSpreadMeters}`,
  };
}

/**
 * The controller's output must sit inside both the configured limits and the
 * scenario's own caps, and must never run past the distance bound.
 */
export function checkFovLimits(
  camera: { fovDeg: number; horizontalFovDeg: number; distance: number },
  constraints: { fovMaxDeg: number; horizontalFovMaxDeg: number },
  limits: FovLimits,
): Verdict {
  const vMax = Math.min(limits.verticalMaxDeg, constraints.fovMaxDeg);
  const hMax = Math.min(limits.horizontalMaxDeg, constraints.horizontalFovMaxDeg);
  const ok =
    camera.fovDeg <= vMax + 1e-6 &&
    camera.fovDeg >= limits.verticalMinDeg - 1e-6 &&
    camera.horizontalFovDeg <= hMax + 1e-4;
  return {
    ok,
    detail: `fov=${camera.fovDeg.toFixed(2)}°∈[${limits.verticalMinDeg},${vMax}] h=${camera.horizontalFovDeg.toFixed(2)}°≤${hMax} d=${camera.distance.toFixed(2)}`,
  };
}

/** Normalised safe rectangle must sit at the configured screen fractions. */
export function checkSafeScreenRange(
  safe: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
  range: ScreenRange,
): Verdict {
  if (width <= 0 || height <= 0) return { ok: false, detail: '画布尺寸无效' };
  const fx = safe.x / width;
  const fr = (safe.x + safe.w) / width;
  const fy = safe.y / height;
  const fb = (safe.y + safe.h) / height;
  const ok =
    inRange(fx, range.safeLeft) &&
    inRange(fr, range.safeRightEdge) &&
    inRange(fy, range.safeTop) &&
    inRange(fb, range.safeBottomEdge);
  return {
    ok,
    detail: `left=${fx.toFixed(3)} right=${fr.toFixed(3)} top=${fy.toFixed(3)} bottom=${fb.toFixed(3)}`,
  };
}

/**
 * A target box the controller reports as inside must be drawn inside the safe
 * rectangle (±tolerance); one it reports as clipped must actually cross an edge.
 * This binds the visible bounds to the verdict instead of trusting either alone.
 */
export function checkTargetBoundsCorrespond(
  targets: Array<{
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    insideSafe: boolean;
    maxOverflow: number;
  }>,
  safe: { x: number; y: number; w: number; h: number },
  tolerancePx: number,
): Verdict {
  let ok = true;
  for (const t of targets) {
    const drawnInside =
      t.x >= safe.x - tolerancePx &&
      t.x + t.w <= safe.x + safe.w + tolerancePx &&
      t.y >= safe.y - tolerancePx &&
      t.y + t.h <= safe.y + safe.h + tolerancePx;
    if (t.insideSafe && !drawnInside) ok = false;
    if (!t.insideSafe && drawnInside && t.maxOverflow > 4.5e-3) ok = false;
  }
  return {
    ok,
    detail: targets.map((t) => `${t.id}:${t.insideSafe ? 'in' : 'out'}`).join(' '),
  };
}

/** An artifact is adoptable only when every check passed. */
export function shouldAdoptArtifact(checks: Array<{ ok: boolean }>): boolean {
  return checks.length > 0 && checks.every((c) => c.ok);
}
