/**
 * WebGL2 molecular renderer.
 *
 * Draws a ribbon mesh plus instanced spheres and cylinders into a multisampled framebuffer, then
 * runs one screen-space pass for contact shadows, outlines and depth fog. The canvas keeps a
 * transparent background so the page (and the glass panels over it) show through.
 */
import type { Vec3 } from '../core/types';
import { cylinder, icosphere } from './geometry';
import { add, orbitView, perspective, quatConjugate, quatFromAxisAngle, quatMultiply, quatNormalize, quatRotate, scale, sub, type Quat } from './math';
import { HIGHLIGHT } from './palette';
import type { SceneData } from './scene';
import { CYLINDER_VS, HALO_FS, MESH_VS, POST_FS, POST_VS, SPHERE_VS, SURFACE_FS } from './shaders';

export interface PickHit {
  layer: number;
  atom: number;
}

export interface ViewPadding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface RendererOptions {
  /** Mouse / touch navigation and picking. Default true. */
  interactive?: boolean;
}

interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

const FOV = (24 * Math.PI) / 180;
const DEFAULT_ROTATION: Quat = quatNormalize(quatMultiply(quatFromAxisAngle([1, 0, 0], 0.32), quatFromAxisAngle([0, 1, 0], -0.5)));

export class WebGLUnavailableError extends Error {
  constructor() {
    super('This browser cannot start WebGL2, which the 3D view needs.');
    this.name = 'WebGLUnavailableError';
  }
}

export class Renderer {
  onHover: ((hit: PickHit | null, clientX: number, clientY: number) => void) | null = null;
  onPick: ((hit: PickHit | null) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private readonly interactive: boolean;
  private disposed = false;
  private contextLost = false;

  // GL objects
  private programs!: { mesh: Program; sphere: Program; cylinder: Program; halo: Program; post: Program };
  private meshVao: WebGLVertexArrayObject | null = null;
  private sphereVao: WebGLVertexArrayObject | null = null;
  private cylinderVao: WebGLVertexArrayObject | null = null;
  private haloVao: WebGLVertexArrayObject | null = null;
  private emptyVao: WebGLVertexArrayObject | null = null;
  private haloBuffer: WebGLBuffer | null = null;
  private sceneBuffers: WebGLBuffer[] = [];
  private sphereIndexCount = 0;
  private cylinderIndexCount = 0;
  private haloIndexCount = 0;
  private msaaFbo: WebGLFramebuffer | null = null;
  private msaaColor: WebGLRenderbuffer | null = null;
  private msaaDepth: WebGLRenderbuffer | null = null;
  private resolveFbo: WebGLFramebuffer | null = null;
  private resolveColor: WebGLTexture | null = null;
  private resolveDepth: WebGLTexture | null = null;
  private fbWidth = 0;
  private fbHeight = 0;

  // scene
  private scene: SceneData | null = null;
  private highlights: Float32Array = new Float32Array(0);
  private highlightCount = 0;

  // camera
  private rotation: Quat = DEFAULT_ROTATION;
  private target: Vec3 = [0, 0, 0];
  private distance = 100;
  private padding: ViewPadding = { left: 0, right: 0, top: 0, bottom: 0 };
  private spin = false;
  /** True while the camera still frames the whole scene (so resizes can re-frame it). */
  private fitted = false;
  private spinVelocity: [number, number] = [0, 0];
  private tween: { from: { target: Vec3; distance: number }; to: { target: Vec3; distance: number }; start: number; duration: number } | null = null;

  // loop
  private frame = 0;
  private dirty = true;
  private lastTime = 0;
  private readonly resizeObserver: ResizeObserver;
  private readonly reducedMotion: boolean;
  private cleanup: Array<() => void> = [];

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    this.interactive = options.interactive ?? true;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) throw new WebGLUnavailableError();
    this.gl = gl;
    this.reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.initGl();

    const onLost = (e: Event) => {
      e.preventDefault();
      this.contextLost = true;
    };
    const onRestored = () => {
      this.contextLost = false;
      this.fbWidth = this.fbHeight = 0;
      this.initGl();
      if (this.scene) this.uploadScene(this.scene);
      this.uploadHighlights();
      this.invalidate();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    this.cleanup.push(() => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    });

    this.resizeObserver = new ResizeObserver(() => {
      if (this.fitted && this.scene && !this.tween) this.distance = this.fitDistance(this.scene.radius);
      this.invalidate();
    });
    this.resizeObserver.observe(canvas);
    if (this.interactive) this.bindInput();
    this.invalidate();
  }

  /* ---------------------------------------------------------------- public API */

  /** Replace what is drawn. With `fit`, the camera is re-framed around the new content. */
  setScene(scene: SceneData, fit: boolean): void {
    this.scene = scene;
    if (!this.contextLost) this.uploadScene(scene);
    if (fit) {
      this.tween = null;
      this.target = scene.center;
      this.distance = this.fitDistance(scene.radius);
      this.fitted = true;
    }
    this.invalidate();
  }

  /** Glowing markers: x, y, z, radius for each. */
  setHighlights(spheres: Float32Array): void {
    this.highlights = spheres;
    this.highlightCount = spheres.length / 4;
    if (!this.contextLost) this.uploadHighlights();
    this.invalidate();
  }

  /** Space (in CSS pixels) covered by panels, so the molecule is centred in what is left. */
  setPadding(padding: ViewPadding): void {
    const p = this.padding;
    if (p.left === padding.left && p.right === padding.right && p.top === padding.top && p.bottom === padding.bottom) return;
    this.padding = padding;
    if (this.fitted && this.scene && !this.tween) this.distance = this.fitDistance(this.scene.radius);
    this.invalidate();
  }

  setSpin(on: boolean): void {
    this.spin = on;
    this.invalidate();
  }

  setRotation(q: Quat): void {
    this.rotation = quatNormalize(q);
    this.invalidate();
  }

  /** Glide back to the default framing of the whole scene. */
  resetView(): void {
    if (!this.scene) return;
    this.rotation = DEFAULT_ROTATION;
    this.spinVelocity = [0, 0];
    this.glideTo(this.scene.center, this.fitDistance(this.scene.radius));
    this.fitted = true;
  }

  /** Glide to centre a point, framing a sphere of `radius` around it. */
  focus(point: Vec3, radius: number): void {
    this.fitted = false;
    this.glideTo(point, this.fitDistance(radius));
  }

  /** PNG of the current view on a solid background colour, without panel offsets or markers. */
  snapshot(background: string): Promise<Blob> {
    const padding = this.padding;
    const distance = this.distance;
    const markers = this.highlightCount;
    this.padding = { left: 0, right: 0, top: 0, bottom: 0 };
    if (this.fitted && this.scene && !this.tween) this.distance = this.fitDistance(this.scene.radius);
    this.highlightCount = 0;
    this.draw();
    const out = document.createElement('canvas');
    out.width = this.canvas.width;
    out.height = this.canvas.height;
    const ctx = out.getContext('2d');
    if (ctx) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(this.canvas, 0, 0);
    }
    // put the live view back exactly as it was
    this.padding = padding;
    this.distance = distance;
    this.highlightCount = markers;
    this.draw();
    if (!ctx) return Promise.reject(new Error('Could not create an image of the view.'));
    return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create an image of the view.'))), 'image/png'));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.cleanup.forEach((fn) => fn());
    this.cleanup = [];
    this.onHover = null;
    this.onPick = null;

    // free GPU memory right away instead of waiting for garbage collection
    const gl = this.gl;
    for (const b of this.sceneBuffers) gl.deleteBuffer(b);
    this.sceneBuffers = [];
    gl.deleteBuffer(this.haloBuffer);
    for (const vao of [this.meshVao, this.sphereVao, this.cylinderVao, this.haloVao, this.emptyVao]) if (vao) gl.deleteVertexArray(vao);
    this.meshVao = this.sphereVao = this.cylinderVao = this.haloVao = this.emptyVao = null;
    for (const p of Object.values(this.programs)) gl.deleteProgram(p.program);
    gl.deleteFramebuffer(this.msaaFbo);
    gl.deleteFramebuffer(this.resolveFbo);
    gl.deleteRenderbuffer(this.msaaColor);
    gl.deleteRenderbuffer(this.msaaDepth);
    gl.deleteTexture(this.resolveColor);
    gl.deleteTexture(this.resolveDepth);
    this.msaaFbo = this.resolveFbo = null;
    this.scene = null;
    // once the canvas has left the page, release the whole context as well
    const canvas = this.canvas;
    setTimeout(() => {
      if (!canvas.isConnected) gl.getExtension('WEBGL_lose_context')?.loseContext();
    }, 0);
  }

  /* ---------------------------------------------------------------- camera */

  private fitDistance(radius: number): number {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    const availW = Math.max(0.25, 1 - (this.padding.left + this.padding.right) / w);
    const availH = Math.max(0.25, 1 - (this.padding.top + this.padding.bottom) / h);
    const tanY = Math.tan(FOV / 2) * availH;
    const tanX = Math.tan(FOV / 2) * (w / h) * availW;
    const half = Math.atan(Math.min(tanX, tanY));
    return (Math.max(radius, 4) / Math.sin(half)) * 1.04;
  }

  private glideTo(target: Vec3, distance: number): void {
    if (this.reducedMotion) {
      this.target = target;
      this.distance = distance;
      this.tween = null;
    } else {
      this.tween = { from: { target: this.target, distance: this.distance }, to: { target, distance }, start: performance.now(), duration: 520 };
    }
    this.invalidate();
  }

  /** Horizontal / vertical shift of the projection centre, in NDC, caused by the padding. */
  private ndcShift(): [number, number] {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    return [(this.padding.left - this.padding.right) / w, (this.padding.bottom - this.padding.top) / h];
  }

  private rotateBy(dx: number, dy: number): void {
    const qy = quatFromAxisAngle([0, 1, 0], dx);
    const qx = quatFromAxisAngle([1, 0, 0], dy);
    this.rotation = quatNormalize(quatMultiply(quatMultiply(qy, qx), this.rotation));
  }

  /* ---------------------------------------------------------------- input */

  private bindInput(): void {
    const el = this.canvas;
    const pointers = new Map<number, { x: number; y: number }>();
    let moved = 0;
    let mode: 'rotate' | 'pan' = 'rotate';
    let pinch = 0;
    let hoverFrame = 0;

    const unitsPerPixel = () => (2 * this.distance * Math.tan(FOV / 2)) / Math.max(1, el.clientHeight);
    const pan = (dx: number, dy: number) => {
      const k = unitsPerPixel();
      const inverse = quatConjugate(this.rotation);
      this.target = add(this.target, quatRotate(inverse, [-dx * k, dy * k, 0]));
      this.fitted = false;
    };
    const zoom = (factor: number) => {
      const r = this.scene ? this.scene.radius : 50;
      this.distance = Math.min(this.fitDistance(r) * 6, Math.max(6, this.distance * factor));
      this.fitted = false;
    };

    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = 0;
      this.tween = null;
      this.spinVelocity = [0, 0];
      mode = e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey || e.metaKey ? 'pan' : 'rotate';
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
      this.onHover?.(null, e.clientX, e.clientY);
    };
    const move = (e: PointerEvent) => {
      const p = pointers.get(e.pointerId);
      if (!p) {
        // plain hover: find the atom under the cursor, at most once per frame
        if (e.pointerType === 'mouse' && this.onHover && !hoverFrame) {
          const { clientX, clientY } = e;
          hoverFrame = requestAnimationFrame(() => {
            hoverFrame = 0;
            if (!this.disposed) this.onHover?.(this.pick(clientX, clientY), clientX, clientY);
          });
        }
        return;
      }
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0 && d > 0) zoom(pinch / d);
        pinch = d;
        pan(dx / 2, dy / 2);
      } else if (mode === 'pan') pan(dx, dy);
      else {
        const k = Math.PI / Math.max(240, Math.min(el.clientWidth, el.clientHeight));
        this.rotateBy(dx * k, dy * k);
        this.spinVelocity = [dx * k, dy * k];
      }
      this.invalidate();
    };
    const up = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      pinch = 0;
      if (moved < 5 && e.type === 'pointerup' && e.button === 0) {
        this.spinVelocity = [0, 0];
        this.onPick?.(this.pick(e.clientX, e.clientY));
      } else if (mode !== 'rotate' || this.reducedMotion || Math.hypot(...this.spinVelocity) < 0.004) {
        this.spinVelocity = [0, 0];
      }
      this.invalidate();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.tween = null;
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoom(Math.exp(Math.max(-120, Math.min(120, delta)) * (e.ctrlKey ? 0.01 : 0.0022)));
      this.invalidate();
    };
    const leave = () => this.onHover?.(null, 0, 0);
    const context = (e: Event) => e.preventDefault();

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('contextmenu', context);
    this.cleanup.push(() => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', context);
      cancelAnimationFrame(hoverFrame);
    });
  }

  /** Nearest drawn atom under a screen position, or null. */
  pick(clientX: number, clientY: number): PickHit | null {
    const scene = this.scene;
    if (!scene || scene.pick.count === 0) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
    const [sx, sy] = this.ndcShift();
    const tanY = Math.tan(FOV / 2);
    const tanX = tanY * (rect.width / rect.height);
    const inverse = quatConjugate(this.rotation);
    const dir = quatRotate(inverse, normalize3([(nx - sx) * tanX, (ny - sy) * tanY, -1]));
    const origin = add(this.target, quatRotate(inverse, [0, 0, this.distance]));

    const { xyz, radius, count } = scene.pick;
    let best = -1;
    let bestT = Infinity;
    for (let i = 0; i < count; i++) {
      const ox = xyz[i * 3] - origin[0];
      const oy = xyz[i * 3 + 1] - origin[1];
      const oz = xyz[i * 3 + 2] - origin[2];
      const t = ox * dir[0] + oy * dir[1] + oz * dir[2];
      if (t <= 0 || t >= bestT + 4) continue;
      const d2 = ox * ox + oy * oy + oz * oz - t * t;
      const r = radius[i];
      if (d2 > r * r) continue;
      const hit = t - Math.sqrt(r * r - d2);
      if (hit < bestT) {
        bestT = hit;
        best = i;
      }
    }
    return best < 0 ? null : { layer: scene.pick.layer[best], atom: scene.pick.atom[best] };
  }

  /* ---------------------------------------------------------------- GL setup */

  private initGl(): void {
    const gl = this.gl;
    const make = (vs: string, fs: string, names: string[]): Program => {
      const compile = (type: number, source: string): WebGLShader => {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
          throw new Error('Shader failed to compile: ' + gl.getShaderInfoLog(shader));
        }
        return shader;
      };
      const program = gl.createProgram()!;
      const v = compile(gl.VERTEX_SHADER, vs);
      const f = compile(gl.FRAGMENT_SHADER, fs);
      gl.attachShader(program, v);
      gl.attachShader(program, f);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
        throw new Error('Shader program failed to link: ' + gl.getProgramInfoLog(program));
      }
      gl.deleteShader(v);
      gl.deleteShader(f);
      const uniforms: Record<string, WebGLUniformLocation | null> = {};
      for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
      return { program, uniforms };
    };
    const camera = ['uView', 'uProjection'];
    this.programs = {
      mesh: make(MESH_VS, SURFACE_FS, camera),
      sphere: make(SPHERE_VS, SURFACE_FS, [...camera, 'uRadiusScale']),
      cylinder: make(CYLINDER_VS, SURFACE_FS, camera),
      halo: make(SPHERE_VS, HALO_FS, [...camera, 'uRadiusScale']),
      post: make(POST_VS, POST_FS, ['uColor', 'uDepth', 'uTexel', 'uNear', 'uFar', 'uPixelsPerUnit', 'uFog', 'uFogColor', 'uOutline', 'uAo']),
    };
    this.emptyVao = gl.createVertexArray();
    this.meshVao = this.sphereVao = this.cylinderVao = null;
    this.sceneBuffers = [];

    // halo: its own copy of the sphere template with a small dynamic instance buffer
    const ball = icosphere(2);
    this.haloVao = gl.createVertexArray();
    gl.bindVertexArray(this.haloVao);
    this.staticBuffer(gl.ARRAY_BUFFER, ball.positions, false);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    this.haloBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.haloBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.disableVertexAttribArray(2);
    gl.vertexAttrib4f(2, HIGHLIGHT[0] / 255, HIGHLIGHT[1] / 255, HIGHLIGHT[2] / 255, 1);
    this.staticBuffer(gl.ELEMENT_ARRAY_BUFFER, ball.indices, false);
    this.haloIndexCount = ball.indices.length;
    gl.bindVertexArray(null);
  }

  private staticBuffer(target: number, data: ArrayBufferView, track: boolean): WebGLBuffer {
    const gl = this.gl;
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    if (track) this.sceneBuffers.push(buffer);
    return buffer;
  }

  private uploadScene(scene: SceneData): void {
    const gl = this.gl;
    for (const b of this.sceneBuffers) gl.deleteBuffer(b);
    this.sceneBuffers = [];
    for (const vao of [this.meshVao, this.sphereVao, this.cylinderVao]) if (vao) gl.deleteVertexArray(vao);
    this.meshVao = this.sphereVao = this.cylinderVao = null;

    if (scene.mesh) {
      this.meshVao = gl.createVertexArray();
      gl.bindVertexArray(this.meshVao);
      this.staticBuffer(gl.ARRAY_BUFFER, scene.mesh.positions, true);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      this.staticBuffer(gl.ARRAY_BUFFER, scene.mesh.normals, true);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      this.staticBuffer(gl.ARRAY_BUFFER, scene.mesh.colors, true);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      this.staticBuffer(gl.ELEMENT_ARRAY_BUFFER, scene.mesh.indices, true);
    }

    if (scene.spheres.count > 0) {
      // fewer triangles per ball once there are very many of them
      const ball = icosphere(scene.spheres.count > 60000 ? 1 : 2);
      this.sphereIndexCount = ball.indices.length;
      this.sphereVao = gl.createVertexArray();
      gl.bindVertexArray(this.sphereVao);
      this.staticBuffer(gl.ARRAY_BUFFER, ball.positions, true);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      this.staticBuffer(gl.ARRAY_BUFFER, scene.spheres.data, true);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(1, 1);
      this.staticBuffer(gl.ARRAY_BUFFER, scene.spheres.colors, true);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.vertexAttribDivisor(2, 1);
      this.staticBuffer(gl.ELEMENT_ARRAY_BUFFER, ball.indices, true);
    }

    if (scene.cylinders.count > 0) {
      const rod = cylinder(scene.cylinders.count > 60000 ? 8 : 12);
      this.cylinderIndexCount = rod.indices.length;
      this.cylinderVao = gl.createVertexArray();
      gl.bindVertexArray(this.cylinderVao);
      this.staticBuffer(gl.ARRAY_BUFFER, rod.positions, true);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      this.staticBuffer(gl.ARRAY_BUFFER, scene.cylinders.data, true);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 28, 12);
      gl.vertexAttribDivisor(2, 1);
      this.staticBuffer(gl.ARRAY_BUFFER, scene.cylinders.colors, true);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.vertexAttribDivisor(3, 1);
      this.staticBuffer(gl.ELEMENT_ARRAY_BUFFER, rod.indices, true);
    }
    gl.bindVertexArray(null);
  }

  private uploadHighlights(): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.haloBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.highlightCount > 0 ? this.highlights : new Float32Array(4), gl.DYNAMIC_DRAW);
  }

  private resizeTargets(width: number, height: number): void {
    const gl = this.gl;
    if (width === this.fbWidth && height === this.fbHeight && this.msaaFbo) return;
    this.fbWidth = width;
    this.fbHeight = height;
    if (this.msaaFbo) gl.deleteFramebuffer(this.msaaFbo);
    if (this.resolveFbo) gl.deleteFramebuffer(this.resolveFbo);
    if (this.msaaColor) gl.deleteRenderbuffer(this.msaaColor);
    if (this.msaaDepth) gl.deleteRenderbuffer(this.msaaDepth);
    if (this.resolveColor) gl.deleteTexture(this.resolveColor);
    if (this.resolveDepth) gl.deleteTexture(this.resolveDepth);

    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
    this.msaaColor = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msaaColor);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
    this.msaaDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msaaDepth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, width, height);
    this.msaaFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaaFbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.msaaColor);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.msaaDepth);

    const texture = (internal: number): WebGLTexture => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, internal, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.resolveColor = texture(gl.RGBA8);
    this.resolveDepth = texture(gl.DEPTH_COMPONENT24);
    this.resolveFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.resolveFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.resolveColor, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.resolveDepth, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* ---------------------------------------------------------------- frame loop */

  private invalidate(): void {
    this.dirty = true;
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(this.tick);
  }

  private tick = (time: number): void => {
    this.frame = 0;
    if (this.disposed) return;
    const dt = this.lastTime ? Math.min(0.05, (time - this.lastTime) / 1000) : 0.016;
    this.lastTime = time;
    let animating = false;

    if (this.tween) {
      const t = Math.min(1, (time - this.tween.start) / this.tween.duration);
      const e = 1 - Math.pow(1 - Math.max(0, t), 3);
      const { from, to } = this.tween;
      this.target = add(from.target, scale(sub(to.target, from.target), e));
      this.distance = from.distance + (to.distance - from.distance) * e;
      if (t >= 1) this.tween = null;
      else animating = true;
      this.dirty = true;
    }
    if (this.spin && !this.reducedMotion) {
      this.rotateBy(dt * 0.3, 0);
      animating = true;
      this.dirty = true;
    } else if (Math.hypot(...this.spinVelocity) > 0.0004) {
      // coast to a stop after a flick
      this.rotateBy(this.spinVelocity[0], this.spinVelocity[1]);
      this.spinVelocity = [this.spinVelocity[0] * 0.93, this.spinVelocity[1] * 0.93];
      animating = true;
      this.dirty = true;
    }

    if (this.dirty) {
      this.dirty = false;
      this.draw();
    }
    if (animating) this.frame = requestAnimationFrame(this.tick);
    else this.lastTime = 0;
  };

  private draw(): void {
    const gl = this.gl;
    if (this.contextLost || gl.isContextLost()) return;
    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    this.resizeTargets(width, height);

    const scene = this.scene;
    const radius = scene ? scene.radius : 10;
    // clip planes hug the scene for depth precision, with room to zoom and pan
    const toCentre = scene ? Math.hypot(...sub(this.target, scene.center)) : 0;
    const near = Math.max(1, this.distance - radius - toCentre - 4);
    const far = this.distance + radius + toCentre + 4;
    const projection = perspective(FOV, width / height, near, far);
    const [sx, sy] = this.ndcShift();
    projection[8] = -sx;
    projection[9] = -sy;
    const view = orbitView(this.rotation, this.target, this.distance);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaaFbo);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    const use = (p: Program) => {
      gl.useProgram(p.program);
      gl.uniformMatrix4fv(p.uniforms.uView, false, view);
      gl.uniformMatrix4fv(p.uniforms.uProjection, false, projection);
    };

    if (scene) {
      if (this.meshVao && scene.mesh) {
        use(this.programs.mesh);
        gl.bindVertexArray(this.meshVao);
        gl.drawElements(gl.TRIANGLES, scene.mesh.indexCount, gl.UNSIGNED_INT, 0);
      }
      if (this.sphereVao && scene.spheres.count > 0) {
        use(this.programs.sphere);
        gl.uniform1f(this.programs.sphere.uniforms.uRadiusScale, 1);
        gl.bindVertexArray(this.sphereVao);
        gl.drawElementsInstanced(gl.TRIANGLES, this.sphereIndexCount, gl.UNSIGNED_SHORT, 0, scene.spheres.count);
      }
      if (this.cylinderVao && scene.cylinders.count > 0) {
        use(this.programs.cylinder);
        gl.bindVertexArray(this.cylinderVao);
        gl.drawElementsInstanced(gl.TRIANGLES, this.cylinderIndexCount, gl.UNSIGNED_SHORT, 0, scene.cylinders.count);
      }
      if (this.highlightCount > 0 && this.haloVao) {
        use(this.programs.halo);
        gl.uniform1f(this.programs.halo.uniforms.uRadiusScale, 1);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.bindVertexArray(this.haloVao);
        gl.drawElementsInstanced(gl.TRIANGLES, this.haloIndexCount, gl.UNSIGNED_SHORT, 0, this.highlightCount);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
    }

    // resolve multisampling into textures the finishing pass can read
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaaFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolveFbo);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const post = this.programs.post;
    gl.useProgram(post.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.resolveColor);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.resolveDepth);
    gl.uniform1i(post.uniforms.uColor, 0);
    gl.uniform1i(post.uniforms.uDepth, 1);
    gl.uniform2f(post.uniforms.uTexel, 1 / width, 1 / height);
    gl.uniform1f(post.uniforms.uNear, near);
    gl.uniform1f(post.uniforms.uFar, far);
    gl.uniform1f(post.uniforms.uPixelsPerUnit, height / (2 * Math.tan(FOV / 2)));
    // fog follows the scene itself, so zooming in on one residue does not darken everything
    const c = scene ? scene.center : this.target;
    const centreDepth = -(view[2] * c[0] + view[6] * c[1] + view[10] * c[2] + view[14]);
    gl.uniform2f(post.uniforms.uFog, centreDepth - radius * 0.25, centreDepth + radius * 1.15);
    gl.uniform3f(post.uniforms.uFogColor, 0.085, 0.14, 0.122);
    gl.uniform1f(post.uniforms.uOutline, 1.1 * dpr);
    gl.uniform1f(post.uniforms.uAo, 0.62);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}

function normalize3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
