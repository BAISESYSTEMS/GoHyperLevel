import type { Mat4 } from './math';

/**
 * The in-house WebGL2 renderer: textured quads (panels, optionally bent around the viewer) and lines (the pointer rays, the floor
 * ring). That is all a floating-panel UI needs, so there is no 3D library: no npm package, nothing to download except this file.
 *
 * It draws the same scene to a normal canvas (the browser preview, with a mouse-orbit camera) and to an immersive WebXR session's
 * framebuffer (one pass per eye). The frame loop, the session and the input live in session.ts / scene.ts; this file only knows
 * how to put pictures on the screen.
 */

export interface Tex {
  tex: WebGLTexture;
  w: number;
  h: number;
}
export interface View {
  /** x, y, width, height in framebuffer pixels. */
  viewport: [number, number, number, number];
  view: Mat4;
  proj: Mat4;
}
export interface DrawItem {
  model: Mat4;
  /** Panel size in metres before the model's scale. */
  size: [number, number];
  tex: Tex;
  alpha?: number;
  /** 0…1: a soft lift of the colours (the pointer is on it). */
  glow?: number;
  /** Curvature, 1 / radius in 1/metres: 0 is flat. */
  bend?: number;
  /** Corner radius in metres. */
  radius?: number;
}
export interface LineItem {
  /** Pairs of points (x y z, x y z) in scene space. */
  points: Float32Array | number[];
  color: [number, number, number, number];
  model?: Mat4;
}

const QUAD_VS = `#version 300 es
in vec2 a_pos;
uniform mat4 u_proj;
uniform mat4 u_view;
uniform mat4 u_model;
uniform vec2 u_size;
uniform float u_bend;
out vec2 v_uv;
out vec2 v_local;
void main() {
  vec3 p = vec3(a_pos * u_size, 0.0);
  if (u_bend > 0.0001) {
    float r = 1.0 / u_bend;
    float a = p.x / r;
    p = vec3(r * sin(a), p.y, r * (1.0 - cos(a)));
  }
  v_uv = vec2(a_pos.x + 0.5, 0.5 - a_pos.y);
  v_local = a_pos * u_size;
  gl_Position = u_proj * u_view * u_model * vec4(p, 1.0);
}`;

const QUAD_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_alpha;
uniform float u_glow;
uniform vec2 u_size;
uniform float u_radius;
in vec2 v_uv;
in vec2 v_local;
out vec4 o;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec2 q = abs(v_local) - (u_size * 0.5 - vec2(u_radius));
  float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - u_radius;
  float aa = max(fwidth(d), 1e-5);
  float mask = 1.0 - smoothstep(-aa, aa, d);
  float a = c.a * mask * u_alpha;
  if (a < 0.01) discard;
  o = vec4(c.rgb + u_glow * vec3(0.06, 0.1, 0.18), a);
}`;

const LINE_VS = `#version 300 es
in vec3 a_pos;
uniform mat4 u_proj;
uniform mat4 u_view;
uniform mat4 u_model;
void main() { gl_Position = u_proj * u_view * u_model * vec4(a_pos, 1.0); }`;

const LINE_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 o;
void main() { o = u_color; }`;

const SEGMENTS = 32;
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}
function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Programm: ${gl.getProgramInfoLog(p)}`);
  return p;
}

export class Renderer {
  private quad: WebGLProgram;
  private line: WebGLProgram;
  private quadVao: WebGLVertexArrayObject;
  private quadCount: number;
  private lineVao: WebGLVertexArrayObject;
  private lineBuf: WebGLBuffer;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private aniso: { ext: any; max: number } | null = null;
  private textures = new Set<WebGLTexture>();

  constructor(readonly gl: WebGL2RenderingContext) {
    this.quad = program(gl, QUAD_VS, QUAD_FS);
    this.line = program(gl, LINE_VS, LINE_FS);
    // the quad: SEGMENTS × 1 cells so that a panel can be bent around the viewer
    const verts: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) verts.push(i / SEGMENTS - 0.5, -0.5, i / SEGMENTS - 0.5, 0.5);
    const idx: number[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.quadCount = idx.length;
    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    const vb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.quad, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.lineVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.lineVao);
    this.lineBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    const lloc = gl.getAttribLocation(this.line, 'a_pos');
    gl.enableVertexAttribArray(lloc);
    gl.vertexAttribPointer(lloc, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) this.aniso = { ext, max: gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) };
  }

  private loc(p: WebGLProgram, name: string) {
    const key = `${p === this.quad ? 'q' : 'l'}.${name}`;
    return key in this.u ? this.u[key] : (this.u[key] = this.gl.getUniformLocation(p, name));
  }

  createTexture(): Tex {
    const { gl } = this;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, this.aniso.max));
    this.textures.add(tex);
    return { tex, w: 1, h: 1 };
  }

  /** A canvas (or image) as the picture of a texture; a new size allocates, the same size only updates. */
  upload(t: Tex, source: TexImageSource, w: number, h: number) {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (t.w === w && t.h === h && w > 1) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    t.w = w;
    t.h = h;
  }

  deleteTexture(t: Tex) {
    this.gl.deleteTexture(t.tex);
    this.textures.delete(t.tex);
  }

  /** One frame: clears the target once, then draws every view (one per eye in a headset, one in the preview). */
  frame(views: View[], items: DrawItem[], lines: LineItem[], o: { clear: [number, number, number, number]; framebuffer?: WebGLFramebuffer | null; size?: [number, number] }) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, o.framebuffer ?? null);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(...o.clear);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    for (const v of views) {
      gl.viewport(...v.viewport);
      this.drawLines(v, lines);
      this.drawQuads(v, items);
    }
  }

  private drawLines(v: View, lines: LineItem[]) {
    if (!lines.length) return;
    const { gl } = this;
    gl.useProgram(this.line);
    gl.uniformMatrix4fv(this.loc(this.line, 'u_proj'), false, v.proj);
    gl.uniformMatrix4fv(this.loc(this.line, 'u_view'), false, v.view);
    gl.bindVertexArray(this.lineVao);
    for (const l of lines) {
      const data = l.points instanceof Float32Array ? l.points : new Float32Array(l.points);
      if (data.length < 6) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.uniformMatrix4fv(this.loc(this.line, 'u_model'), false, l.model ?? IDENTITY);
      gl.uniform4fv(this.loc(this.line, 'u_color'), l.color);
      gl.drawArrays(gl.LINES, 0, data.length / 3);
    }
    gl.bindVertexArray(null);
  }

  private drawQuads(v: View, items: DrawItem[]) {
    if (!items.length) return;
    const { gl } = this;
    gl.useProgram(this.quad);
    gl.uniformMatrix4fv(this.loc(this.quad, 'u_proj'), false, v.proj);
    gl.uniformMatrix4fv(this.loc(this.quad, 'u_view'), false, v.view);
    gl.uniform1i(this.loc(this.quad, 'u_tex'), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.quadVao);
    for (const it of items) {
      gl.bindTexture(gl.TEXTURE_2D, it.tex.tex);
      gl.uniformMatrix4fv(this.loc(this.quad, 'u_model'), false, it.model);
      gl.uniform2f(this.loc(this.quad, 'u_size'), it.size[0], it.size[1]);
      gl.uniform1f(this.loc(this.quad, 'u_alpha'), it.alpha ?? 1);
      gl.uniform1f(this.loc(this.quad, 'u_glow'), it.glow ?? 0);
      gl.uniform1f(this.loc(this.quad, 'u_bend'), it.bend ?? 0);
      gl.uniform1f(this.loc(this.quad, 'u_radius'), it.radius ?? 0.04);
      gl.drawElements(gl.TRIANGLES, this.quadCount, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
  }

  dispose() {
    const { gl } = this;
    for (const t of this.textures) gl.deleteTexture(t);
    this.textures.clear();
    gl.deleteProgram(this.quad);
    gl.deleteProgram(this.line);
  }
}
