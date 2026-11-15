/**
 * DOM-side probes used by the release runner.
 *
 * These are injected into the page. They read the *rendered* UI and the live
 * controller state; they never synthesise a frame. If the shared-framing
 * controller did not run, `window.framingDemo` is absent and everything that
 * depends on it fails loudly.
 */
import type { Page } from 'playwright';

export interface ProbedTargetBox {
  id: string;
  name: string;
  /** Screen-space box in CSS px, relative to the stage frame. */
  x: number;
  y: number;
  w: number;
  h: number;
  insideSafe: boolean;
  maxOverflow: number;
  sampleCount: number;
  pointsBehind: number;
  color: string;
}

export interface ProbedFrame {
  /** Stage frame size in CSS px. */
  width: number;
  height: number;
  /** Safe-area rectangle, screen px relative to the stage frame. */
  safe: { x: number; y: number; w: number; h: number };
  /** Margin band thickness in screen px on each side. */
  marginsPx: { left: number; right: number; top: number; bottom: number };
  targets: ProbedTargetBox[];
  /** Background pixel sampled from the centre of the stage (proves a live GL frame). */
  centerPixel: [number, number, number, number] | null;
}

/**
 * Read the stage geometry plus the actor boxes the diagnostic overlay drew.
 * Bounding boxes come from `framingDemo.getState().reports` (the dense
 * projection pass) and the safe rectangle from the same state, so the numbers
 * are the controller's own, mapped to screen px with the live stage size.
 */
export async function probeFrame(page: Page): Promise<ProbedFrame> {
  return page.evaluate(() => {
    const stage = document.getElementById('stage-frame') as HTMLElement | null;
    const overlay = document.getElementById('diagnostic-overlay') as HTMLCanvasElement | null;
    const gl = document.getElementById('gl-canvas') as HTMLCanvasElement | null;
    if (!stage || !overlay || !gl) throw new Error('stage elements missing');
    const rect = stage.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const demo = (window as unknown as { framingDemo?: { getState: () => any } }).framingDemo;
    if (!demo) throw new Error('framingDemo controller hook missing — controller did not run');
    const st = demo.getState();
    if (!st || !st.safe || !Array.isArray(st.reports)) {
      throw new Error('controller state has no solved frame');
    }
    const toPx = (ndcX: number, ndcY: number): [number, number] => [
      ((ndcX + 1) / 2) * width,
      ((1 - ndcY) / 2) * height,
    ];
    const [sl, stp] = toPx(st.safe.left, st.safe.top);
    const [sr, sb] = toPx(st.safe.right, st.safe.bottom);
    const targets = st.reports.map((r: any) => {
      const [bx, by] = toPx(r.bboxNdc.left, r.bboxNdc.top);
      const [bx2, by2] = toPx(r.bboxNdc.right, r.bboxNdc.bottom);
      return {
        id: r.id,
        name: r.name,
        x: bx,
        y: by,
        w: bx2 - bx,
        h: by2 - by,
        insideSafe: Boolean(r.insideSafe),
        maxOverflow: r.maxOverflow,
        sampleCount: r.sampleCount,
        pointsBehind: r.pointsBehind,
        color: r.color,
      };
    });

    let centerPixel: [number, number, number, number] | null = null;
    const glCtx = gl.getContext('webgl2') ?? gl.getContext('webgl');
    if (glCtx) {
      const px = new Uint8Array(4);
      glCtx.readPixels(
        Math.floor(gl.width / 2),
        Math.floor(gl.height / 2),
        1,
        1,
        glCtx.RGBA,
        glCtx.UNSIGNED_BYTE,
        px,
      );
      centerPixel = [px[0], px[1], px[2], px[3]];
    }

    return {
      width,
      height,
      safe: { x: sl, y: stp, w: sr - sl, h: sb - stp },
      marginsPx: {
        left: sl,
        right: width - sr,
        top: stp,
        bottom: height - sb,
      },
      targets,
      centerPixel,
    };
  });
}

/** Simulate a real left-button drag inside the stage between two points. */
export async function dragWithinStage(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 14,
): Promise<void> {
  const box = await page.evaluate(() => {
    const r = (document.getElementById('stage-frame') as HTMLElement).getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps });
  await page.mouse.up();
}
