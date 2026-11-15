import type { Actor, CameraSolution, FramingConstraints, SafeNdc } from '../framing/types';
import type { SolveResult } from '../framing/solver';
import { rad } from '../framing/vector';

export interface PlanViewOptions {
  actors: Actor[];
  camera: CameraSolution | null;
  constraints: FramingConstraints;
  safe: SafeNdc;
  result: SolveResult | null;
  hoveredId: string | null;
}

/**
 * Top-down plan of the camera, actors and their projected envelopes. The point
 * of this pane is to show *why* the frame landed where it did: you can see the
 * group extent, the camera distance and the wide cone the current lens covers
 * before the 3D view.
 */
export function drawPlanView(canvas: HTMLCanvasElement, opts: PlanViewOptions): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const actors = opts.actors;
  const cam = opts.camera;
  const bounds = groupBounds(actors);
  const pad = 0.18;

  // Fit everything, including the camera position, with padding.
  let minX = bounds.minX;
  let maxX = bounds.maxX;
  let minZ = bounds.minZ;
  let maxZ = bounds.maxZ;
  if (cam) {
    minX = Math.min(minX, cam.position.x);
    maxX = Math.max(maxX, cam.position.x);
    minZ = Math.min(minZ, cam.position.z);
    maxZ = Math.max(maxZ, cam.position.z);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanZ = Math.max(1, maxZ - minZ);
  const scale = Math.min((w * (1 - pad * 2)) / spanX, (h * (1 - pad * 2)) / spanZ);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  // World x/z -> canvas x/y. World +Z (the camera's 0-yaw direction) is up.
  const toScreen = (x: number, z: number): [number, number] => [
    w / 2 + (x - cx) * scale,
    h / 2 - (z - cz) * scale,
  ];

  // Background and a 1 m grid.
  ctx.fillStyle = '#0b1017';
  ctx.fillRect(0, 0, w, h);
  const gridStep = niceStep(1, scale);
  ctx.strokeStyle = 'rgba(70, 100, 130, 0.28)';
  ctx.lineWidth = 1;
  ctx.font = '10px "JetBrains Mono Variable", "Noto Sans SC Variable", monospace';
  ctx.fillStyle = 'rgba(140, 168, 195, 0.5)';
  const gx0 = Math.floor(minX / gridStep) * gridStep;
  const gz0 = Math.floor(minZ / gridStep) * gridStep;
  for (let gx = gx0; gx <= maxX + gridStep; gx += gridStep) {
    const [sx] = toScreen(gx, 0);
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
    ctx.stroke();
  }
  for (let gz = gz0; gz <= maxZ + gridStep; gz += gridStep) {
    const [, sy] = toScreen(0, gz);
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
    ctx.stroke();
  }

  // The lens's horizontal half-angle drawn as a cone from the camera. This is
  // the same number the solver uses, so you can sanity-check the projection.
  if (cam) {
    const halfH = rad(cam.horizontalFovDeg) / 2;
    const dirAngle = Math.atan2(cam.forward.x, cam.forward.z);
    const reach = Math.max(spanX, spanZ) * 0.65;
    const [cxp, cyp] = toScreen(cam.position.x, cam.position.z);
    ctx.fillStyle = 'rgba(110, 200, 240, 0.10)';
    ctx.strokeStyle = 'rgba(110, 200, 240, 0.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cxp, cyp);
    for (let i = 0; i <= 24; i++) {
      const a = dirAngle - halfH + (i / 24) * halfH * 2;
      const wx = cam.position.x + Math.sin(a) * reach;
      const wz = cam.position.z + Math.cos(a) * reach;
      const [sx, sy] = toScreen(wx, wz);
      ctx.lineTo(sx, sy);
    }
    ctx.lineTo(cxp, cyp);
    ctx.fill();
    // Centre axis dashed.
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(cxp, cyp);
    const [ax, ay] = toScreen(cam.position.x + cam.forward.x * reach, cam.position.z + cam.forward.z * reach);
    ctx.lineTo(ax, ay);
    ctx.stroke();
    ctx.setLineDash([]);

    // Camera glyph.
    ctx.save();
    ctx.translate(cxp, cyp);
    ctx.rotate(-dirAngle);
    ctx.fillStyle = '#7fd4ff';
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 4);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Actor footprints (capsule radius circles), with an importance halo.
  for (const a of actors) {
    const [sx, sy] = toScreen(a.position.x, a.position.z);
    const rp = Math.max(2.2, a.radius * scale);
    const hovered = opts.hoveredId === a.id;
    ctx.beginPath();
    ctx.arc(sx, sy, rp, 0, Math.PI * 2);
    ctx.fillStyle = hovered ? a.color : hexAlpha(a.color, 0.28);
    ctx.fill();
    ctx.lineWidth = hovered ? 2.2 : 1.4;
    ctx.strokeStyle = a.color;
    ctx.stroke();

    // Importance as ring segments.
    ctx.strokeStyle = hexAlpha(a.color, 0.9);
    ctx.lineWidth = 1;
    for (let i = 0; i < a.importance; i++) {
      const ang = -Math.PI / 2 + (i / Math.max(1, a.importance)) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(sx, sy, rp + 4, ang, ang + 0.5);
      ctx.stroke();
    }

    label(ctx, a.name, sx, sy - rp - 16, a.color, hovered);
  }

  // Status text in the corner.
  ctx.fillStyle = 'rgba(150, 176, 200, 0.7)';
  ctx.font = '10px "JetBrains Mono Variable", "Noto Sans SC Variable", monospace';
  ctx.fillText('俯视平面 · 世界 +Z 向上', 10, 16);
  if (cam) {
    ctx.fillText(
      `机位 (${cam.position.x.toFixed(1)}, ${cam.position.z.toFixed(1)}) · 距离 ${cam.distance.toFixed(1)} m · 水平视场 ${cam.horizontalFovDeg.toFixed(1)}°`,
      10,
      30,
    );
  }

  // Safe-area mini marker: which edges currently report overflow.
  if (opts.result && opts.result.status === 'tradeoff') {
    ctx.fillStyle = 'rgba(240, 120, 90, 0.9)';
    ctx.fillText(`取舍进行中 · ${opts.result.tradeoff?.clippedActors.length ?? 0} 角色越界`, 10, h - 12);
  } else if (opts.result) {
    ctx.fillStyle = 'rgba(120, 210, 160, 0.9)';
    ctx.fillText('全部角色在安全区内', 10, h - 12);
  }
}

function groupBounds(actors: Actor[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  if (actors.length === 0) return { minX: -5, maxX: 5, minZ: -5, maxZ: 5 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const a of actors) {
    minX = Math.min(minX, a.position.x - a.radius);
    maxX = Math.max(maxX, a.position.x + a.radius);
    minZ = Math.min(minZ, a.position.z - a.radius);
    maxZ = Math.max(maxZ, a.position.z + a.radius);
  }
  return { minX, maxX, minZ, maxZ };
}

function niceStep(target: number, scale: number): number {
  const desiredPx = 46;
  const worldStep = desiredPx / Math.max(scale, 1e-3);
  const pow = Math.pow(10, Math.floor(Math.log10(worldStep)));
  const norm = worldStep / pow;
  const nice = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  void target;
  return nice * pow;
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, strong: boolean): void {
  ctx.font = strong ? '600 11px "Noto Sans SC Variable", system-ui' : '10px "Noto Sans SC Variable", system-ui';
  const width = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(8, 13, 20, 0.82)';
  ctx.fillRect(x - width / 2 - 4, y - 10, width + 8, 14);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
}

function hexAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export type { SafeNdc };
