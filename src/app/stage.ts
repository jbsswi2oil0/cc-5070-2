import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Actor, CameraSolution, FramingConstraints, SafeNdc } from '../framing/types';
import { sampleActorBody, safeNdcFromMargins } from '../framing/sampling';
import { rad } from '../framing/vector';

export interface ActorVisual {
  actor: Actor;
  group: THREE.Group;
  body: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>;
  selectRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  label: HTMLDivElement;
}

const COLORS = {
  bg: 0x0c1118,
  grid: 0x1b2635,
  platform: 0x24313f,
  platformEdge: 0x3d5266,
  ground: 0x111820,
};

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;
  readonly actorsLayer = new THREE.Group();
  readonly framingLayer = new THREE.Group();
  private platformsLayer = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private labelLayer: HTMLDivElement;
  private actorVisuals: ActorVisual[] = [];
  private dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private dragOffset = new THREE.Vector3();
  private dragging: ActorVisual | null = null;
  private hovered: ActorVisual | null = null;
  private selectedId: string | null = null;
  private safeRect: SafeNdc | null = null;
  private safeFrameMesh: THREE.Group;
  private safeCorners: THREE.Mesh[] = [];
  private lastSize = { w: 0, h: 0 };

  onActorDrag: ((id: string, position: { x: number; y: number; z: number }) => void) | null = null;
  onActorSelect: ((id: string) => void) | null = null;
  onActorDragEnd: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, labelLayer: HTMLDivElement) {
    this.labelLayer = labelLayer;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(COLORS.bg, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(COLORS.bg, 30, 90);

    this.camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 400);
    this.camera.position.set(0, 6, -16);

    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.target.set(0, 1.2, 1);
    this.orbit.enabled = false;

    this.buildWorld();
    this.safeFrameMesh = this.buildSafeFrame();
    this.scene.add(this.safeFrameMesh);
    this.scene.add(this.actorsLayer, this.framingLayer, this.platformsLayer);

    this.attachPointer();
    this.resize();
  }

  private buildWorld(): void {
    const hemi = new THREE.HemisphereLight(0xa9c8e8, 0x1a222c, 0.9);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(9, 16, -7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 60;
    key.shadow.camera.left = -22;
    key.shadow.camera.right = 22;
    key.shadow.camera.top = 22;
    key.shadow.camera.bottom = -22;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6aa8ff, 0.55);
    rim.position.set(-10, 8, 12);
    this.scene.add(rim);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160),
      new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(80, 40, COLORS.grid, COLORS.grid);
    grid.position.y = 0.002;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.85;
    this.scene.add(grid);

    // Two low platforms (0.55 m and 1.15 m) that anchor the high/low actors.
    // They are static set dressing; actor feet heights are independent of them
    // so a dragged actor can sit anywhere, including mid-air.
    this.addPlatform(-3.1, 0.55, 1.4, 2.6, 2.6);
    this.addPlatform(2.9, 1.15, 2.6, 2.4, 2.4);
  }

  private addPlatform(x: number, y: number, z: number, w: number, d: number): void {
    const geo = new THREE.BoxGeometry(w, y, d);
    const mat = new THREE.MeshStandardMaterial({ color: COLORS.platform, roughness: 0.8, metalness: 0.05 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y / 2, z);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: COLORS.platformEdge, transparent: true, opacity: 0.6 }),
    );
    edges.position.copy(mesh.position);
    this.platformsLayer.add(mesh, edges);
  }

  private buildSafeFrame(): THREE.Group {
    const group = new THREE.Group();
    const lineMat = new THREE.LineDashedMaterial({
      color: 0x7fd4ff,
      dashSize: 0.06,
      gapSize: 0.035,
      transparent: true,
      opacity: 0.75,
    });
    const quad = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1, -1, 0),
      new THREE.Vector3(1, -1, 0),
      new THREE.Vector3(1, 1, 0),
      new THREE.Vector3(-1, 1, 0),
      new THREE.Vector3(-1, -1, 0),
    ]);
    const border = new THREE.Line(quad, lineMat);
    border.computeLineDistances();
    group.add(border);
    this.safeCorners = [];
    const cornerMat = new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
    for (let i = 0; i < 4; i++) {
      const c = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.07), cornerMat);
      group.add(c);
      this.safeCorners.push(c);
    }
    // Four edge ticks that show the safe rectangle is the real margin, not a
    // decorative HUD border.
    const tickMat = new THREE.LineBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.5 });
    const crossGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1, 0, -0.02),
      new THREE.Vector3(1, 0, -0.02),
      new THREE.Vector3(0, -1, -0.01),
      new THREE.Vector3(0, 1, -0.01),
    ]);
    group.add(new THREE.LineSegments(crossGeo, tickMat));
    return group;
  }

  setSafeRect(safe: SafeNdc | null): void {
    this.safeRect = safe;
    this.safeFrameMesh.visible = safe !== null;
    if (!safe) return;
    const xs = [safe.left, safe.right];
    const ys = [safe.top, safe.bottom];
    const corners = [
      [xs[0], ys[0]],
      [xs[1], ys[0]],
      [xs[1], ys[1]],
      [xs[0], ys[1]],
    ];
    this.safeCorners.forEach((m, i) => m.position.set(corners[i][0], corners[i][1], 1.01));
  }

  /** Place the overlay at the camera's near plane using clip-space coordinates. */
  updateFramingOverlay(solution: CameraSolution): void {
    const distance = Math.min(0.6, Math.max(0.25, solution.distance * 0.06));
    const tanHalfV = Math.tan(rad(solution.fovDeg) / 2);
    const tanHalfH = tanHalfV * solution.aspect;
    this.safeFrameMesh.position.copy(solution.position).addScaledVector(solution.forward, distance);
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(solution.right.x, solution.right.y, solution.right.z),
      new THREE.Vector3(solution.up.x, solution.up.y, solution.up.z),
      new THREE.Vector3(-solution.forward.x, -solution.forward.y, -solution.forward.z),
    );
    this.safeFrameMesh.setRotationFromMatrix(basis);
    const sx = tanHalfH * distance;
    const sy = tanHalfV * distance;
    this.safeFrameMesh.scale.set(sx, sy, 1);
  }

  setActors(actors: Actor[]): void {
    const keep = new Map(this.actorVisuals.map((v) => [v.actor.id, v]));
    for (const v of this.actorVisuals) {
      if (!actors.some((a) => a.id === v.actor.id)) {
        this.actorsLayer.remove(v.group);
        v.label.remove();
      }
    }
    this.actorVisuals = actors.map((actor, index) => {
      const existing = keep.get(actor.id);
      if (existing) {
        existing.actor = actor;
        return existing;
      }
      return this.makeActorVisual(actor, index);
    });
    for (const v of this.actorVisuals) {
      this.positionActor(v);
      v.body.material.color.set(v.actor.color);
      v.selectRing.material.color.set(v.actor.color);
    }
    this.restyleSelection();
  }

  private makeActorVisual(actor: Actor, index: number): ActorVisual {
    const group = new THREE.Group();
    const radius = actor.radius;
    const usableHeight = Math.max(0.2, actor.height - radius * 2);
    const geo = new THREE.CapsuleGeometry(radius, usableHeight, 8, 20);
    const mat = new THREE.MeshStandardMaterial({
      color: actor.color,
      roughness: 0.42,
      metalness: 0.05,
      emissive: new THREE.Color(actor.color).multiplyScalar(0.08),
    });
    const body = new THREE.Mesh(geo, mat);
    body.castShadow = true;
    body.receiveShadow = true;
    // Capsule is centred; lift it so the geometric bottom sits at y = 0
    // relative to the group, which is placed at the actor's feet.
    body.position.y = actor.height / 2;
    body.userData.actorId = actor.id;
    group.add(body);

    const headRadius = Math.max(0.1, radius * 0.62);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(headRadius, 20, 16),
      new THREE.MeshStandardMaterial({ color: 0xf3e9dc, roughness: 0.6 }),
    );
    head.position.y = actor.height - headRadius * 0.9;
    head.castShadow = true;
    group.add(head);

    const selectRing = new THREE.Mesh(
      new THREE.RingGeometry(radius * 1.5, radius * 1.85, 40),
      new THREE.MeshBasicMaterial({
        color: actor.color,
        transparent: true,
        opacity: 0.0,
        side: THREE.DoubleSide,
        depthTest: false,
      }),
    );
    selectRing.rotation.x = -Math.PI / 2;
    selectRing.position.y = 0.01;
    selectRing.renderOrder = 5;
    group.add(selectRing);

    const label = document.createElement('div');
    label.className = 'actor-label';
    label.dataset.actorId = actor.id;
    label.innerHTML = `<span class="actor-dot" style="background:${actor.color}"></span><span class="actor-name">${actor.name}</span><span class="actor-imp">★${actor.importance}</span>`;
    this.labelLayer.appendChild(label);

    group.userData.actorId = actor.id;
    this.actorsLayer.add(group);
    return { actor, group, body, selectRing, label };
  }

  positionActor(v: ActorVisual): void {
    v.group.position.set(v.actor.position.x, v.actor.position.y, v.actor.position.z);
    const radius = v.actor.radius;
    const usableHeight = Math.max(0.2, v.actor.height - radius * 2);
    v.body.geometry.dispose();
    v.body.geometry = new THREE.CapsuleGeometry(radius, usableHeight, 8, 20);
    v.body.position.y = v.actor.height / 2;
    v.selectRing.scale.setScalar(Math.max(0.9, v.actor.height / 1.8));
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    this.restyleSelection();
  }

  private restyleSelection(): void {
    for (const v of this.actorVisuals) {
      const selected = v.actor.id === this.selectedId;
      v.selectRing.material.opacity = selected ? 0.85 : 0;
      v.label.classList.toggle('is-selected', selected);
      v.label.classList.toggle('is-hovered', v.actor.id === this.hovered?.actor.id);
    }
  }

  /** Screen-space actor labels follow the projected 3D positions. */
  updateLabels(camera: CameraSolution): void {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const tanHalfV = Math.tan(rad(camera.fovDeg) / 2);
    const tanHalfH = tanHalfV * camera.aspect;
    for (const v of this.actorVisuals) {
      const p = v.actor.position;
      const rel = {
        x: p.x - camera.position.x,
        y: p.y + v.actor.height + 0.28 - camera.position.y,
        z: p.z - camera.position.z,
      };
      const depth = rel.x * camera.forward.x + rel.y * camera.forward.y + rel.z * camera.forward.z;
      const xc = rel.x * camera.right.x + rel.y * camera.right.y + rel.z * camera.right.z;
      const yc = rel.x * camera.up.x + rel.y * camera.up.y + rel.z * camera.up.z;
      if (depth <= 0.05) {
        v.label.style.opacity = '0';
        v.label.style.pointerEvents = 'none';
        continue;
      }
      const ndcX = xc / (depth * tanHalfH);
      const ndcY = yc / (depth * tanHalfV);
      v.label.style.opacity = '1';
      v.label.style.pointerEvents = 'none';
      v.label.style.transform = `translate(-50%, -100%) translate(${((ndcX + 1) / 2) * width}px, ${((1 - ndcY) / 2) * height - 8}px)`;
      v.label.style.left = '0px';
      v.label.style.top = '0px';
    }
  }

  /** Move the main camera to the solved pose. */
  applySolution(solution: CameraSolution, aspect: number): void {
    this.camera.fov = solution.fovDeg;
    this.camera.aspect = aspect;
    this.camera.position.set(solution.position.x, solution.position.y, solution.position.z);
    this.camera.up.set(solution.up.x, solution.up.y, solution.up.z);
    this.camera.lookAt(
      solution.target.x,
      solution.target.y,
      solution.target.z,
    );
    this.camera.updateProjectionMatrix();
    this.updateFramingOverlay(solution);
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    if (w === this.lastSize.w && h === this.lastSize.h) return;
    this.lastSize = { w, h };
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private attachPointer(): void {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    canvas.addEventListener('pointerup', () => this.endDrag());
    canvas.addEventListener('pointerleave', () => this.endDrag());
  }

  private updatePointer(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private pick(event: PointerEvent): ActorVisual | null {
    this.updatePointer(event);
    const bodies = this.actorVisuals.map((v) => v.body);
    const hits = this.raycaster.intersectObjects(bodies, false);
    if (hits.length === 0) return null;
    const id = hits[0].object.userData.actorId as string;
    return this.actorVisuals.find((v) => v.actor.id === id) ?? null;
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const hit = this.pick(event);
    if (!hit) {
      this.onActorSelect?.(null as unknown as string);
      return;
    }
    this.onActorSelect?.(hit.actor.id);
    this.dragging = hit;
    this.dragPlane.set(new THREE.Vector3(0, 1, 0), -hit.actor.position.y);
    const p = this.raycaster.ray.intersectPlane(this.dragPlane, new THREE.Vector3());
    this.dragOffset.set(0, 0, 0);
    if (p) this.dragOffset.set(hit.actor.position.x - p.x, 0, hit.actor.position.z - p.z);
    this.renderer.domElement.setPointerCapture(event.pointerId);
    this.renderer.domElement.style.cursor = 'grabbing';
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.dragging) {
      this.updatePointer(event);
      this.dragPlane.set(new THREE.Vector3(0, 1, 0), -this.dragging.actor.position.y);
      const p = this.raycaster.ray.intersectPlane(this.dragPlane, new THREE.Vector3());
      if (p) {
        const raw = {
          x: p.x + this.dragOffset.x,
          y: this.dragging.actor.position.y,
          z: p.z + this.dragOffset.z,
        };
        const snapped = {
          x: Math.round(raw.x * 20) / 20,
          y: raw.y,
          z: Math.round(raw.z * 20) / 20,
        };
        this.dragging.actor.position = snapped;
        this.positionActor(this.dragging);
        this.onActorDrag?.(this.dragging.actor.id, snapped);
      }
      return;
    }
    const hit = this.pick(event);
    if (hit !== this.hovered) {
      this.hovered = hit;
      this.renderer.domElement.style.cursor = hit ? 'grab' : 'default';
      this.restyleSelection();
    }
  }

  private endDrag(): void {
    if (this.dragging) {
      this.dragging = null;
      this.renderer.domElement.style.cursor = 'default';
      this.onActorDragEnd?.();
    }
  }

  /** 2D projection of the body envelope used by the result panel. */
  projectActorEnvelope(actor: Actor, solution: CameraSolution): Array<[number, number]> {
    const samples = sampleActorBody(actor, 25, 40);
    const tanHalfV = Math.tan(rad(solution.fovDeg) / 2);
    const tanHalfH = tanHalfV * solution.aspect;
    const pts: Array<[number, number]> = [];
    for (const s of samples) {
      const rel = {
        x: s.point.x - solution.position.x,
        y: s.point.y - solution.position.y,
        z: s.point.z - solution.position.z,
      };
      const depth = rel.x * solution.forward.x + rel.y * solution.forward.y + rel.z * solution.forward.z;
      if (depth <= 0.05) continue;
      const xc = rel.x * solution.right.x + rel.y * solution.right.y + rel.z * solution.right.z;
      const yc = rel.x * solution.up.x + rel.y * solution.up.y + rel.z * solution.up.z;
      pts.push([xc / (depth * tanHalfH), yc / (depth * tanHalfV)]);
    }
    return pts;
  }

  dispose(): void {
    this.renderer.dispose();
    for (const v of this.actorVisuals) v.label.remove();
  }
}

