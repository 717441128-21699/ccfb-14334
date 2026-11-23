/**
 * WebGL2 上下文与资源封装。
 * 浮点纹理使用 RG32F（需 EXT_color_buffer_float），
 * 这是本系统所有频域计算的精度基础。
 */

export interface GLCapabilities {
  floatLinear: boolean;
  maxTextureSize: number;
  renderer: string;
}

export class GLContext {
  readonly gl: WebGL2RenderingContext;
  readonly caps: GLCapabilities;
  private programs = new Map<string, WebGLProgram>();
  private quadVao: WebGLVertexArrayObject;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    const ext = gl.getExtension('EXT_color_buffer_float');
    if (!ext) throw new Error('缺少 EXT_color_buffer_float，无法使用浮点渲染目标');
    this.gl = gl;
    const linear = !!gl.getExtension('OES_texture_float_linear');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.caps = {
      floatLinear: linear,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '(未知 GPU)',
    };
    this.quadVao = this.createQuadVAO();
  }

  private createQuadVAO(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // 三角形覆盖全屏：位置 + uv
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1, 0, 0,
        3, -1, 2, 0,
        -1, 3, 0, 2,
      ]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
    return vao;
  }

  compileProgram(name: string, vsSource: string, fsSource: string): WebGLProgram {
    const cached = this.programs.get(name);
    if (cached) return cached;
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aUv');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      throw new Error(`程序链接失败 [${name}]: ${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.programs.set(name, prog);
    return prog;
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      throw new Error(`着色器编译失败: ${log}\n${source}`);
    }
    return sh;
  }

  /**
   * 创建 N×N 的 RG32F 计算纹理（R=数据，G=备用/虚部）。
   * 关键：WebGL2 规范中 R32F 的可渲染性是可选的，部分驱动（如 AMD ANGLE）
   * 不支持把 R32F 作为渲染目标，而 RG32F 在 EXT_color_buffer_float 下
   * 强制可渲染。因此所有计算纹理统一使用 RG32F。
   */
  createFloatTexture(n: number, linear = false): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, n, n, 0, gl.RG, gl.FLOAT, null);
    const filter = linear && this.caps.floatLinear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** 从 Float32Array 上传灰度到 RG32F（R=灰度，G=0）。 */
  uploadGrayTexture(data: Float32Array, w: number, h: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const rg = new Float32Array(w * h * 2);
    for (let i = 0; i < data.length; i++) rg[i * 2] = data[i];
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, w, h, 0, gl.RG, gl.FLOAT, rg);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  createFramebuffer(): WebGLFramebuffer {
    return this.gl.createFramebuffer()!;
  }

  /** 绑定纹理到帧缓冲并设视口，返回解绑函数。 */
  renderTo(tex: WebGLTexture, n: number): void {
    const gl = this.gl;
    const fb = this.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, n, n);
  }

  /** 单次全屏绘制。uniforms 在回调中设置。 */
  draw(
    program: WebGLProgram,
    bindings: Array<{ tex: WebGLTexture; unit: number; name: string }>,
    setUniforms?: (loc: (n: string) => WebGLUniformLocation | null) => void,
  ): void {
    const gl = this.gl;
    gl.useProgram(program);
    gl.bindVertexArray(this.quadVao);
    for (const b of bindings) {
      gl.activeTexture(gl.TEXTURE0 + b.unit);
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      const loc = gl.getUniformLocation(program, b.name);
      if (loc) gl.uniform1i(loc, b.unit);
    }
    setUniforms?.((n) => gl.getUniformLocation(program, n));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** 读回 R 通道为 Float32Array（内部纹理均为 RG32F，读 RG 取 R）。 */
  readRed(n: number): Float32Array {
    const gl = this.gl;
    const rg = new Float32Array(n * n * 2);
    gl.readPixels(0, 0, n, n, gl.RG, gl.FLOAT, rg);
    const px = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) px[i] = rg[i * 2];
    return px;
  }

  /** 读回 RG 通道（FFT 复数组）。 */
  readRG(n: number): Float32Array {
    const gl = this.gl;
    const px = new Float32Array(n * n * 2);
    gl.readPixels(0, 0, n, n, gl.RG, gl.FLOAT, px);
    return px;
  }

  destroyTexture(tex: WebGLTexture): void {
    this.gl.deleteTexture(tex);
  }

  checkFramebuffer(): void {
    const gl = this.gl;
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`帧缓冲不完整，状态码 ${status}`);
    }
  }
}

export const FULLSCREEN_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;
