import type { Actor, Margins, SafeNdc } from './types';
import type { Vec3 } from './vector';

/** Radius of the capsule surface at a given height above the actor's feet. */
export function radiusAtCapsuleHeight(local: number, height: number, radius: number): number {
  const r = Math.min(radius, height / 2);
  if (local <= 0 || local >= height) return 0;
  if (local < r) return Math.sqrt(Math.max(0, r * r - (r - local) ** 2));
  const topCapStart = height - r;
  if (local > topCapStart) {
    return Math.sqrt(Math.max(0, r * r - (local - topCapStart) ** 2));
  }
  return r;
}

export interface BodySample {
  point: Vec3;
  /** Height above the actor's feet, 0..actor.height. */
  localHeight: number;
  pole: boolean;
}

/**
 * Samples the rendered capsule envelope rather than the actor's centre. Feet
 * are at position.y, the top of the head at position.y + height. The result is
 * the actual surface mesh (rings plus both poles), so body edges participate in
 * framing rather than a single centre point.
 */
export function sampleActorBody(actor: Actor, rings = 15, azimuths = 28): BodySample[] {
  const out: BodySample[] = [];
  const h = actor.height;
  const r = Math.min(actor.radius, h / 2);
  const feet = actor.position;

  for (let i = 0; i < rings; i++) {
    const local = (i / (rings - 1)) * h;
    const ringRadius = radiusAtCapsuleHeight(local, h, r);
    for (let a = 0; a < azimuths; a++) {
      const theta = (a / azimuths) * Math.PI * 2;
      out.push({
        localHeight: local,
        pole: ringRadius < 1e-9,
        point: {
          x: feet.x + Math.cos(theta) * ringRadius,
          y: feet.y + local,
          z: feet.z + Math.sin(theta) * ringRadius,
        },
      });
    }
  }
  out.push({ localHeight: 0, pole: true, point: { x: feet.x, y: feet.y, z: feet.z } });
  out.push({
    localHeight: h,
    pole: true,
    point: { x: feet.x, y: feet.y + h, z: feet.z },
  });
  return out;
}

/** Same envelope as sampleActorBody, flattened for the solver hot loop. */
export function sampleCloud(actor: Actor, rings = 9, azimuths = 18): Float64Array {
  const samples = sampleActorBody(actor, rings, azimuths);
  const out = new Float64Array(samples.length * 3);
  for (let i = 0; i < samples.length; i++) {
    out[i * 3] = samples[i].point.x;
    out[i * 3 + 1] = samples[i].point.y;
    out[i * 3 + 2] = samples[i].point.z;
  }
  return out;
}

export function safeNdcFromMargins(m: Margins): SafeNdc {
  return {
    left: -1 + 2 * m.left,
    right: 1 - 2 * m.right,
    top: 1 - 2 * m.top,
    bottom: -1 + 2 * m.bottom,
  };
}

export function normalizeMargins(m: Margins): Margins {
  const clampM = (v: number) => Math.min(0.45, Math.max(0, Number.isFinite(v) ? v : 0));
  let left = clampM(m.left);
  let right = clampM(m.right);
  let top = clampM(m.top);
  let bottom = clampM(m.bottom);
  if (left + right > 0.9) {
    const k = 0.9 / (left + right);
    left *= k;
    right *= k;
  }
  if (top + bottom > 0.9) {
    const k = 0.9 / (top + bottom);
    top *= k;
    bottom *= k;
  }
  return { left, right, top, bottom };
}
