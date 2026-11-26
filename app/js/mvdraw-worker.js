// The small feeds of the H.264 multiview, drawn (mvsoft.js, engine 'wasm'): pictures come from the feeds' decoder
// workers (mvdec-worker.js) with their time on the feeds' timeline; each feed shows its newest picture that is due by
// the big feed's clock (sent by the page). Y, U and V go into textures; the GPU converts to RGB (BT.709, limited
// range) and scales into the feed's place. Used buffers go back to their decoder.
// (Measured on the QE55Q77A and left out: two texture sets alternating, luma packed four samples a texel, and filtering
// the unfiltered B pictures on the GPU: cheaper or better in isolation, but in the app no smoother or less smooth.)
// Never request OES_EGL_image_external or EXT_disjoint_timer_query on this TV.
var feeds = [], gl = null, prog = null, canvas = null, running = false, clock = { pos: 0, at: 0, playing: false, rate: 1 };
var stats = { shown: 0, frames: 0, perFeed: [], late: [], dropped: [], drift: null, uploads: 0, drawMs: 0, invalid: 0, pulled: 0 };
var lastClockOut = 0, lastReport = 0, firstShown = false;

function now() { return performance.timeOrigin + performance.now(); }
function clockNow() { return clock.pos + (clock.playing ? (now() - clock.at) / 1000 * clock.rate : 0); }

function shader(type, src) {
  var s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function setup(m) {
  canvas = m.canvas;
  gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
  if (!gl) throw new Error('WebGL unavailable');
  var p = gl.createProgram();
  gl.attachShader(p, shader(gl.VERTEX_SHADER, 'attribute vec2 a; uniform vec4 r; varying vec2 t;' +
    'void main(){ t = vec2(a.x, 1.0 - a.y); gl_Position = vec4((r.xy + a * r.zw) * 2.0 - 1.0, 0.0, 1.0); }'));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, 'precision mediump float; varying vec2 t; uniform sampler2D y, u, v;' +
    'void main(){ float Y = 1.16438 * (texture2D(y, t).r - 0.0627451); float U = texture2D(u, t).r - 0.5, V = texture2D(v, t).r - 0.5;' +
    ' gl_FragColor = vec4(Y + 1.79274 * V, Y - 0.21325 * U - 0.53291 * V, Y + 2.11240 * U, 1.0); }'));
  gl.bindAttribLocation(p, 0, 'a');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  prog = { p: p, r: gl.getUniformLocation(p, 'r') };
  gl.useProgram(p);
  gl.uniform1i(gl.getUniformLocation(p, 'y'), 0); gl.uniform1i(gl.getUniformLocation(p, 'u'), 1); gl.uniform1i(gl.getUniformLocation(p, 'v'), 2);
  var vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.disable(gl.BLEND); gl.disable(gl.DITHER);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  m.rects.forEach(function (r, k) {
    var f = { rect: [r[0], 1 - r[1] - r[3], r[2], r[3]], queue: [], shown: null, tex: [], w: 0, h: 0, port: m.ports[k] };
    for (var i = 0; i < 3; i++) {
      var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      f.tex.push(t);
    }
    f.port.onmessage = function (ev) { if (ev.data.pic) add(f, ev.data.pic); };
    feeds.push(f);
    stats.perFeed.push(0); stats.late.push(0); stats.dropped.push(0);
  });
  gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
}

/** A decoded picture into its feed's queue (kept in time order: B frames come after the P frame they precede). */
function add(f, pic) {
  var q = f.queue, i = q.length;
  while (i > 0 && q[i - 1].t > pic.t) i--;
  q.splice(i, 0, pic);
}

function giveBack(f, pic) { if (pic) f.port.postMessage({ free: pic.data }, [pic.data]); }

function upload(f, pic) {
  var w = pic.w, h = pic.h, y = new Uint8Array(pic.data, 0, w * h), u = new Uint8Array(pic.data, w * h, w * h / 4), v = new Uint8Array(pic.data, w * h * 5 / 4, w * h / 4);
  var planes = [[y, w, h], [u, w >> 1, h >> 1], [v, w >> 1, h >> 1]];
  for (var i = 0; i < 3; i++) {
    gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, f.tex[i]);
    var pl = planes[i];
    if (f.w !== w || f.h !== h) gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, pl[1], pl[2], 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, pl[0]);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pl[1], pl[2], gl.LUMINANCE, gl.UNSIGNED_BYTE, pl[0]);
  }
  f.w = w; f.h = h;
  stats.uploads++;
}

function draw() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clear(gl.COLOR_BUFFER_BIT);
  feeds.forEach(function (f) {
    if (!f.w) return;
    for (var i = 0; i < 3; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, f.tex[i]); }
    gl.uniform4fv(prog.r, f.rect);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  });
}

function tick() {
  if (!running) return;
  var t0 = now(), t = clockNow(), changed = false, drift = null;
  feeds.forEach(function (f, k) {
    var q = f.queue, pick = null;
    while (q.length && q[0].t <= t + 0.004) {
      if (pick) { giveBack(f, pick); stats.dropped[k]++; }
      pick = q.shift();
      // Never back in time: a B picture that came after the P picture it precedes was shown (late) is left out.
      if (f.shown && pick.t <= f.shown.t) { giveBack(f, pick); stats.dropped[k]++; pick = null; }
    }
    if (pick) {
      upload(f, pick);
      giveBack(f, f.shown);
      f.shown = pick;
      changed = true;
      stats.perFeed[k]++; stats.pulled++;
      if (t - pick.t > 0.04) stats.late[k]++;
    }
    if (f.shown) drift = drift === null ? t - f.shown.t : Math.max(drift, t - f.shown.t);
  });
  if (changed) {
    draw();
    stats.frames++;
    stats.drawMs += now() - t0;
    if (!firstShown) { firstShown = true; postMessage({ shown: true }); }
  }
  stats.drift = drift;
  if (t0 - lastClockOut > 100) {
    lastClockOut = t0;
    var c = { t: t, at: t0, rate: clock.playing ? clock.rate : 0 };
    feeds.forEach(function (f) { f.port.postMessage({ clock: c }); });
  }
  if (t0 - lastReport > 500) { lastReport = t0; postMessage({ stats: stats }); }
  schedule();
}

var raf = typeof self.requestAnimationFrame === 'function';
function schedule() { if (raf) self.requestAnimationFrame(tick); else setTimeout(tick, 8); }

onmessage = function (e) {
  var m = e.data;
  if (m.clock) { clock = m.clock; return; }
  if (m.start) {
    try { setup(m); running = true; postMessage({ ready: true }); schedule(); }
    catch (err) { postMessage({ error: String(err && err.message || err) }); }
    return;
  }
  if (m.stop) { running = false; postMessage({ stats: stats, stopped: true }); }
};
