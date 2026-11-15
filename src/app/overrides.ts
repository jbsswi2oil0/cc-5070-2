import type { Actor, FramingConstraints, Margins } from '../framing/types';
import { normalizeMargins } from '../framing/sampling';
import { clamp } from '../framing/vector';

export interface OverrideState {
  yawDeg: number;
  workingFovDeg: number;
  fovMaxDeg: number;
  horizontalFovMaxDeg: number;
  distanceMax: number;
  margins: Margins;
}

export function overridesFromConstraints(c: FramingConstraints): OverrideState {
  return {
    yawDeg: c.yawDeg,
    workingFovDeg: c.workingFovDeg,
    fovMaxDeg: c.fovMaxDeg,
    horizontalFovMaxDeg: c.horizontalFovMaxDeg,
    distanceMax: c.distanceMax,
    margins: { ...c.margins },
  };
}

export function applyOverrides(base: FramingConstraints, o: OverrideState): FramingConstraints {
  const fovMaxDeg = clamp(o.fovMaxDeg, 10, 130);
  return {
    ...base,
    yawDeg: (((o.yawDeg + 180) % 360) + 360) % 360 - 180,
    workingFovDeg: clamp(o.workingFovDeg, base.fovMinDeg, fovMaxDeg),
    fovMaxDeg,
    horizontalFovMaxDeg: clamp(o.horizontalFovMaxDeg, 10, 150),
    distanceMax: Math.max(base.distanceMin + 1, o.distanceMax),
    margins: normalizeMargins(o.margins),
  };
}

/**
 * Replay snapshot: actor positions, constraints and the beat the demo is on.
 * Enough to reconstruct the identical frame after a reload or via a shared URL.
 */
export interface ScenarioSnapshot {
  scenario: string;
  aspect: number;
  beatIndex: number;
  actors: Array<{
    id: string;
    x: number;
    y: number;
    z: number;
    height: number;
    radius: number;
    importance: number;
  }>;
  overrides: OverrideState;
}

export function encodeSnapshot(s: ScenarioSnapshot): string {
  const payload = {
    v: 1,
    s: s.scenario,
    a: round(s.aspect, 4),
    b: s.beatIndex,
    x: s.actors.map((a) => [a.id, round(a.x), round(a.y), round(a.z), round(a.height), round(a.radius), a.importance]),
    o: {
      y: round(s.overrides.yawDeg),
      w: round(s.overrides.workingFovDeg),
      f: round(s.overrides.fovMaxDeg),
      h: round(s.overrides.horizontalFovMaxDeg),
      d: round(s.overrides.distanceMax),
      m: [
        round(s.overrides.margins.left, 4),
        round(s.overrides.margins.right, 4),
        round(s.overrides.margins.top, 4),
        round(s.overrides.margins.bottom, 4),
      ],
    },
  };
  return encodeURIComponent(JSON.stringify(payload));
}

export function decodeSnapshot(hash: string): ScenarioSnapshot | null {
  try {
    const cleaned = hash.replace(/^#/, '').replace(/^state=/, '');
    if (!cleaned) return null;
    const raw = JSON.parse(decodeURIComponent(cleaned));
    if (!raw || raw.v !== 1) return null;
    const m = raw.o?.m ?? [0, 0, 0, 0];
    return {
      scenario: String(raw.s),
      aspect: num(raw.a, 16 / 9),
      beatIndex: Math.max(0, Math.min(3, Math.round(num(raw.b, 0)))),
      actors: (raw.x as unknown[][]).map((row) => ({
        id: String(row[0]),
        x: num(row[1]),
        y: num(row[2]),
        z: num(row[3]),
        height: num(row[4], 1.8),
        radius: num(row[5], 0.34),
        importance: num(row[6], 3),
      })),
      overrides: {
        yawDeg: num(raw.o?.y, 0),
        workingFovDeg: num(raw.o?.w, 38),
        fovMaxDeg: num(raw.o?.f, 52),
        horizontalFovMaxDeg: num(raw.o?.h, 92),
        distanceMax: num(raw.o?.d, 42),
        margins: {
          left: num(m[0], 0.07),
          right: num(m[1], 0.07),
          top: num(m[2], 0.07),
          bottom: num(m[3], 0.07),
        },
      },
    };
  } catch {
    return null;
  }
}

const round = (n: number, digits = 3): number => {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
};

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export type { Actor };
