// H.264 onboards: classify the helper's extra marker row on the GPU, then update
// only that feed's rectangle in the visible, retained canvas. No ImageBitmap copies.
// Never request OES_EGL_image_external or EXT_disjoint_timer_query on this TV.
var running = true;
onmessage = function (e) {
  var m = e.data;
  if (m.stop) { running = false; return; }
  if (!m.start) return;
  var T = self.tizentvwasm.SideThreadElementaryMediaTrack, id = m.trackId;
  var canvas = m.canvas, W = m.width, H = m.height, tag = m.feedTag;
  var stats = { mode: 'retained-onboard-tag', pulled: 0, frames: 0, perFeed: [0, 0, 0], invalid: 0,
    errors: [], getMs: 0, drawMs: 0, yieldMs: 0, yields: 0 };
  var channel, pictureOutstanding = false, stopped = false, gl, counters, previous = [0, 0, 0];
  var lastReport = performance.now(), yieldAt = 0, px = new Uint8Array(4);
  function report() {
    if (gl && counters && stats.pulled) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, counters[(stats.pulled - 1) % 2].f);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (var k = 0; k < 3; k++) stats.perFeed[k] += (px[k] - previous[k] + 256) % 256;
      previous = Array.prototype.slice.call(px, 0, 3);
      stats.invalid = stats.pulled - stats.perFeed[0] - stats.perFeed[1] - stats.perFeed[2];
      var error = gl.getError();
      if (error) throw new Error('GL ' + error);
    }
    if (gl) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); }
    stats.reportAtMs = performance.now();
    postMessage({ stats: stats });
  }
  function stopReport() {
    if (stopped || pictureOutstanding) return;
    stopped = true;
    try { report(); } catch (err) { postMessage({ error: err.message }); }
    if (channel) { channel.port1.onmessage = null; channel.port1.close(); channel.port2.close(); }
    postMessage({ stopped: true });
  }
  function failed(err) {
    running = false; stats.errors.push(String(err.message || err));
    if (stats.errors.length > 10) stats.errors.shift();
    postMessage({ error: stats.errors[stats.errors.length - 1] });
    // A failed recycle is not a safe stop: never acknowledge a borrowed picture.
    stopReport();
  }
  try {
    if (!canvas || !tag || m.feeds < 1 || m.feeds > 3) throw new Error('missing canvas or unsupported feed marker');
    gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL unavailable');
    T.setWebGLRenderingContext(id, gl);
    var EXT = '#extension GL_OES_EGL_image_external : require\nprecision highp float;\n';
    var VS = 'attribute vec2 a; void main(){gl_Position=vec4(a*2.0-1.0,0.0,1.0);}';
    function program(vs, fs, names) {
      var p = gl.createProgram(); gl.bindAttribLocation(p, 0, 'a');
      [vs, fs].forEach(function (src, i) {
        var s = gl.createShader(i ? gl.FRAGMENT_SHADER : gl.VERTEX_SHADER);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
      });
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      var o = { p: p }; names.forEach(function (n) { o[n] = gl.getUniformLocation(p, n); }); return o;
    }
    var vals = tag.values.map(function (y) { return ((y - 16) / 219).toFixed(10); });
    while (vals.length < 3) vals.push('9.0');
    var count = program(VS, EXT + 'uniform samplerExternalOES s; uniform sampler2D prev; uniform vec2 uv; void main(){' +
      'float g=texture2D(s,uv).g; vec3 d=abs(vec3(g)-vec3(' + vals.slice(0, 3).join(',') + '));' +
      'float k=d.x<=d.y&&d.x<=d.z?0.0:d.y<=d.z?1.0:2.0; float valid=min(d.x,min(d.y,d.z))<0.11?1.0:0.0;' +
      'vec3 inc=vec3(k<0.5?1.0:0.0,k>0.5&&k<1.5?1.0:0.0,k>1.5?1.0:0.0)*valid;' +
      'vec3 b=texture2D(prev,vec2(0.5)).rgb;' +
      'gl_FragColor=vec4(mod(floor(b*255.0+0.5)+inc,256.0)/255.0,(k+1.0)*0.25*valid);}', ['s', 'prev', 'uv']);
    var route = program('attribute vec2 a; uniform sampler2D state; uniform vec4 rects[3]; uniform float visible; varying vec2 t;' +
      'void main(){float k=floor(texture2D(state,vec2(0.5)).a*4.0+0.5)-1.0;' +
      'vec4 r=k<0.5?rects[0]:k<1.5?rects[1]:rects[2]; t=vec2(a.x,(1.0-a.y)*visible);' +
      'gl_Position=k<0.0?vec4(2.0,2.0,0.0,1.0):vec4((r.xy+a*r.zw)*2.0-1.0,0.0,1.0);}',
      EXT + 'uniform samplerExternalOES s; varying vec2 t; void main(){gl_FragColor=vec4(texture2D(s,t).rgb,1.0);}', ['state', 'rects', 'visible', 's']);
    var vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND); gl.disable(gl.DITHER);
    function counter() {
      var t = gl.createTexture(); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      var f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('incomplete marker framebuffer');
      gl.viewport(0, 0, 1, 1); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      return { t: t, f: f };
    }
    counters = [counter(), counter()];
    var rects = new Float32Array(12);
    m.rects.forEach(function (r, k) { rects.set([r[0], 1 - r[1] - r[3], r[2], r[3]], 4 * k); });
    gl.useProgram(count.p); gl.uniform1i(count.s, 0); gl.uniform1i(count.prev, 1); gl.uniform2f(count.uv, 8 / W, (tag.row + 8) / H);
    gl.useProgram(route.p); gl.uniform1i(route.s, 0); gl.uniform1i(route.state, 1);
    gl.uniform4fv(route.rects, rects); gl.uniform1f(route.visible, m.visibleRows / H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    var tex = gl.createTexture();
    channel = new MessageChannel(); channel.port1.onmessage = step;
    postMessage({ ready: true }); channel.port2.postMessage(0);
  } catch (err) { failed(err); }
  function step() {
    try {
      if (yieldAt) { stats.yieldMs += performance.now() - yieldAt; stats.yields++; yieldAt = 0; }
      if (!running) { stopReport(); return; }
      var until = performance.now() + 25;
      while (running && performance.now() < until) {
        var asked = performance.now(), pic;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.activeTexture(gl.TEXTURE0);
        try { pic = T.getPictureSync(id, tex); }
        catch (err) { if (err.name === 'AlreadyInProgressError') break; throw err; }
        pictureOutstanding = true;
        var got = performance.now(); stats.getMs += got - asked;
        try {
          gl.bindTexture(36197, pic.texture);
          var dst = counters[stats.pulled % 2], prev = counters[(stats.pulled + 1) % 2];
          gl.bindFramebuffer(gl.FRAMEBUFFER, dst.f); gl.viewport(0, 0, 1, 1); gl.useProgram(count.p);
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, prev.t); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); gl.useProgram(route.p);
          gl.bindTexture(gl.TEXTURE_2D, dst.t); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          stats.pulled++;
        } finally { T.recyclePictureSync(id, pic); pictureOutstanding = false; }
        stats.drawMs += performance.now() - got;
        if (stats.pulled % m.feeds === 0) { stats.frames++; break; }
      }
      if (performance.now() - lastReport > 500) { report(); lastReport = performance.now(); }
      yieldAt = performance.now(); channel.port2.postMessage(0);
    } catch (err) { failed(err); }
  }
};
