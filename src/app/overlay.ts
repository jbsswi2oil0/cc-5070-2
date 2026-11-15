import type { ActorFitReport, CameraSolution, SafeNdc } from '../framing/types';

export interface OverlayLayout {
  width: number;
  height: number;
  camera: CameraSolution;
  safe: SafeNdc;
  reports: ActorFitReport[];
  /** Zero-based index used for canvas colours per actor. */
  actorIds: string[];
}

/**
 * Draws the true projected boundaries: every actor's screen bounding box (from
 * the body envelope, not its centre), its four margin gaps, and the safe area.
 * This canvas sits exactly over the WebGL canvas, so the boxes are what the
 * solver measured.
 */
export function drawDiagnosticOverlay(canvas: HTMLCanvasElement, layout: OverlayLayout): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { width, height } = layout;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const toPx = (ndcX: number, ndcY: number): [number, number] => [
    ((ndcX + 1) / 2) * width,
    ((1 - ndcY) / 2) * height,
  ];

  // Outer frame boundary (the render viewport), then the safe rectangle.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

  const [sl, st] = toPx(layout.safe.left, layout.safe.top);
  const [sr, sb] = toPx(layout.safe.right, layout.safe.bottom);
  ctx.save();
  // Shade the margin band so it is visibly excluded from framing.
  ctx.fillStyle = 'rgba(10, 18, 26, 0.36)';
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.rect(sl, st, sr - sl, sb - st);
  ctx.fill('evenodd');
  ctx.strokeStyle = 'rgba(127, 212, 255, 0.85)';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([7, 5]);
  ctx.strokeRect(sl, st, sr - sl, sb - st);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(127, 212, 255, 0.9)';
  ctx.font = '10px "JetBrains Mono Variable", "Noto Sans SC Variable", monospace';
  ctx.fillText('安全区', sl + 6, st + 13);
  ctx.restore();

  for (const r of layout.reports) {
    const [bx, by] = toPx(r.bboxNdc.left, r.bboxNdc.top);
    const [bx2, by2] = toPx(r.bboxNdc.right, r.bboxNdc.bottom);
    const boxW = bx2 - bx;
    const boxH = by2 - by;
    const clipped = !r.insideSafe || r.pointsBehind > 0;
    ctx.strokeStyle = clipped ? 'rgba(255, 122, 92, 0.95)' : r.color;
    ctx.lineWidth = clipped ? 2 : 1.6;
    ctx.strokeRect(bx, by, boxW, boxH);

    // Corner brackets emphasise that this is the full body extent.
    const corner = Math.min(14, boxW * 0.4, boxH * 0.4);
    if (corner > 2) {
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(bx, by + corner);
      ctx.lineTo(bx, by);
      ctx.lineTo(bx + corner, by);
      ctx.moveTo(bx2 - corner, by);
      ctx.lineTo(bx2, by);
      ctx.lineTo(bx2, by + corner);
      ctx.moveTo(bx2, by2 - corner);
      ctx.lineTo(bx2, by2);
      ctx.lineTo(bx2 - corner, by2);
      ctx.moveTo(bx + corner, by2);
      ctx.lineTo(bx, by2);
      ctx.lineTo(bx, by2 - corner);
      ctx.stroke();
    }

    // Label chip with body size in pixels.
    const chip = `${r.name}  ${Math.round(boxW)}×${Math.round(boxH)}px`;
    ctx.font = '10px "JetBrains Mono Variable", "Noto Sans SC Variable", monospace';
    const chipW = ctx.measureText(chip).width + 10;
    const chipX = Math.max(2, Math.min(width - chipW - 2, bx));
    const chipY = Math.max(2, by - 18);
    ctx.fillStyle = clipped ? 'rgba(70, 20, 12, 0.9)' : 'rgba(8, 14, 20, 0.85)';
    ctx.fillRect(chipX, chipY, chipW, 15);
    ctx.fillStyle = clipped ? '#ffb49e' : r.color;
    ctx.fillText(chip, chipX + 5, chipY + 11);

    // Overflow hatch on the sides the body leaves the safe area.
    if (clipped) {
      const sides = r.clippedSides;
      ctx.fillStyle = 'rgba(255, 110, 80, 0.22)';
      if (sides.includes('left')) {
        const x = Math.max(0, toPx(r.bboxNdc.left, 0)[0]);
        ctx.fillRect(x, by, Math.max(0, sl - x), boxH);
      }
      if (sides.includes('right')) {
        const x = toPx(r.bboxNdc.right, 0)[0];
        ctx.fillRect(sr, by, Math.max(0, Math.min(width, x) - sr), boxH);
      }
      if (sides.includes('top')) {
        const y = Math.max(0, toPx(0, r.bboxNdc.top)[1]);
        ctx.fillRect(bx, y, boxW, Math.max(0, st - y));
      }
      if (sides.includes('bottom')) {
        const y = toPx(0, r.bboxNdc.bottom)[1];
        ctx.fillRect(bx, sb, boxW, Math.max(0, Math.min(height, y) - sb));
      }
    }
  }

  // Margin read-out along the four edges of the safe area.
  ctx.font = '10px "JetBrains Mono Variable", "Noto Sans SC Variable", monospace';
  ctx.fillStyle = 'rgba(170, 198, 220, 0.75)';
  const marginPx = {
    left: Math.round(sl),
    right: Math.round(width - sr),
    top: Math.round(st),
    bottom: Math.round(height - sb),
  };
  ctx.fillText(`${marginPx.left}px`, 8, height / 2);
  ctx.textAlign = 'right';
  ctx.fillText(`${marginPx.right}px`, width - 8, height / 2);
  ctx.textAlign = 'center';
  // Sit inside the safe area so the read-out is never clipped by the frame edge
  // or overlapped by the corner badges.
  const topLabelY = Math.max(st + 11, 12);
  ctx.fillText(`上 ${marginPx.top}px`, width / 2, topLabelY);
  ctx.fillText(`下 ${marginPx.bottom}px`, width / 2, Math.min(sb - 5, height - 6));
  ctx.textAlign = 'left';
}
