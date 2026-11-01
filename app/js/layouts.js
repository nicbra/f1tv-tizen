/*
 * Multiview layouts (experiment), shared by the app (hdr.js, app.js) and the stream helper
 * (service/stitch-hevc.js). F1's HEVC feeds are made of 960x544 tiles: 540p is one, 1080p 2x2,
 * 1620p 3x3, 2160p 4x4. A layout is a grid of cols x rows such cells, each taken from [feed, tile]
 * (in reading order), and `feeds` gives each feed's height. Feed 0 is the big one. A null cell is empty
 * (gray filler, which the app's overlay covers with black).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MultiviewLayouts = factory();
})(this, function () {
  'use strict';
  var LAYOUTS = {
    grid2x2: { feeds: [540, 540, 540, 540], cols: 2, rows: 2, cells: [[0, 0], [1, 0], [2, 0], [3, 0]] },
    grid2x2hd: { feeds: [1080, 1080, 1080, 1080], cols: 4, rows: 4, cells: [
      [0, 0], [0, 1], [1, 0], [1, 1], [0, 2], [0, 3], [1, 2], [1, 3],
      [2, 0], [2, 1], [3, 0], [3, 1], [2, 2], [2, 3], [3, 2], [3, 3]] },
    // Picture in picture: the inset takes the place of one of the big feed's tiles.
    pip: { feeds: [1080, 540], cols: 2, rows: 2, cells: [[0, 0], [0, 1], [0, 2], [1, 0]] },
    pip3: { feeds: [1620, 540], cols: 3, rows: 3, cells: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [1, 0]] },
    pip4: { feeds: [2160, 540], cols: 4, rows: 4, cells: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7],
      [0, 8], [0, 9], [0, 10], [0, 11], [0, 12], [0, 13], [0, 14], [1, 0]] },
    side2: { feeds: [1080, 540, 540], cols: 3, rows: 2, cells: [[0, 0], [0, 1], [1, 0], [0, 2], [0, 3], [2, 0]] },
    side5: { feeds: [1080, 540, 540, 540, 540, 540], cols: 3, rows: 3, cells: [[0, 0], [0, 1], [1, 0], [0, 2], [0, 3], [2, 0], [3, 0], [4, 0], [5, 0]] },
    // Big top left, three small ones down the right, the cells under the big one empty: 2880x1632.
    big3: { feeds: [1080, 540, 540, 540], cols: 3, rows: 3, cells: [[0, 0], [0, 1], [1, 0], [0, 2], [0, 3], [2, 0], null, null, [3, 0]] },
    // 3840x1632 (1620p beside three 540p): the TV only plays 3840-wide pictures 2160 tall. Not offered.
    side3wide: { feeds: [1620, 540, 540, 540], cols: 4, rows: 3, cells: [[0, 0], [0, 1], [0, 2], [1, 0], [0, 3], [0, 4], [0, 5], [2, 0], [0, 6], [0, 7], [0, 8], [3, 0]] }
  };

  /*
   * The layouts the app offers, in the order it shows them. At most four feeds: F1 TV Premium's own multiview
   * shows four, and with six (side5) the CDN stopped serving two of them after ~2 minutes (HTTP 402, the
   * account's limit on streams at once; Mexico 2026 race).
   */
  var ORDER = ['grid2x2', 'grid2x2hd', 'side2', 'big3', 'pip', 'pip3', 'pip4'];

  var TILES = { 540: 1, 1080: 2, 1620: 3, 2160: 4 };

  /**
   * Where each feed shows: { cols, rows, width, height (pixels shown), rects: [{ x, y, w, h }] in cells,
   * in feed order }. A feed covers its whole tile block, also where an inset (a later feed) sits on it.
   */
  function shape(name) {
    var l = LAYOUTS[name];
    if (!l) return null;
    var rects = l.feeds.map(function () { return null; });
    l.cells.forEach(function (c, k) {
      if (!c) return;   // empty
      var n = TILES[l.feeds[c[0]]], x = k % l.cols, y = Math.floor(k / l.cols);
      if (!rects[c[0]]) rects[c[0]] = { x: x - c[1] % n, y: y - Math.floor(c[1] / n), w: n, h: n };
    });
    // The picture the helper makes: cols x rows cells, less the first cell's feed's cropped lines (4 per tile row of
    // it: 540p is 544 coded, 1080p 1088), at most 2160 tall (the TV's 4K path refuses taller ones).
    var lead = l.cells[0] ? TILES[l.feeds[l.cells[0][0]]] : 1;
    return { cols: l.cols, rows: l.rows, width: l.cols * 960, height: Math.min(l.rows * 544 - 4 * lead, 2160), rects: rects };
  }

  /**
   * Where each feed's picture lands on a screen of w x h pixels (the grid letterboxed into it):
   * [{ left, top, width, height }] in feed order. A feed shows 540 of each 544 lines per tile (the rest is
   * the encoder's padding), so its height leaves those out.
   */
  /**
   * Where the grid's picture lands on a w x h screen: { left, top, width, height, scale }, letterboxed in the
   * middle, or at the top (align 'top': room for data below a picture wider than the screen).
   */
  function area(name, w, h, align) {
    var sh = shape(name);
    if (!sh) return null;
    var scale = Math.min(w / sh.width, h / sh.height), pw = sh.width * scale, ph = sh.height * scale;
    return { left: (w - pw) / 2, top: align === 'top' ? 0 : (h - ph) / 2, width: pw, height: ph, scale: scale };
  }

  function onScreen(name, w, h, align) {
    var sh = shape(name), a = area(name, w, h, align);
    if (!sh) return null;
    var scale = a.scale, left = a.left, top = a.top;
    return sh.rects.map(function (r) {
      return { left: left + r.x * 960 * scale, top: top + r.y * 544 * scale, width: r.w * 960 * scale, height: r.h * 540 * scale };
    });
  }

  /**
   * The screen space a layout leaves free (w x h screen): the black bands where the grid is letterboxed, and
   * each run of empty cells in a row. [{ left, top, width, height }], largest first.
   */
  function freeSpace(name, w, h, align) {
    var l = LAYOUTS[name], a = area(name, w, h, align);
    if (!l) return [];
    var scale = a.scale, pw = a.width, ph = a.height, left = a.left, top = a.top, out = [];
    if (top >= 1) out.push({ left: 0, top: 0, width: w, height: top });
    if (h - top - ph >= 1) out.push({ left: 0, top: top + ph, width: w, height: h - top - ph });
    if (left >= 1) out.push({ left: 0, top: 0, width: left, height: h }, { left: left + pw, top: 0, width: w - left - pw, height: h });
    for (var row = 0; row < l.rows; row++) {
      for (var col = 0; col < l.cols; col++) {
        if (l.cells[row * l.cols + col]) continue;
        var run = 1;
        while (col + run < l.cols && !l.cells[row * l.cols + col + run]) run++;
        out.push({ left: left + col * 960 * scale, top: top + row * 544 * scale, width: run * 960 * scale, height: Math.min(544 * scale, h - top - row * 544 * scale) });
        col += run - 1;
      }
    }
    return out.sort(function (a, b) { return b.width * b.height - a.width * a.height; });
  }

  return { layouts: LAYOUTS, order: ORDER, shape: shape, area: area, onScreen: onScreen, freeSpace: freeSpace };
});
