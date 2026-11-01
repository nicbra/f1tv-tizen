/*
 * Multiview layouts (experiment), shared by the app (hdr.js, app.js) and the stream helper
 * (service/stitch-hevc.js). F1's HEVC feeds are made of 960x544 tiles: 540p is one, 1080p 2x2,
 * 1620p 3x3, 2160p 4x4. A layout is a grid of cols x rows such cells, each taken from [feed, tile]
 * (in reading order), and `feeds` gives each feed's height. Feed 0 is the big one.
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
    // 3840x1632 (1620p beside three 540p): the TV only plays 3840-wide pictures 2160 tall. Not offered.
    side3: { feeds: [1620, 540, 540, 540], cols: 4, rows: 3, cells: [[0, 0], [0, 1], [0, 2], [1, 0], [0, 3], [0, 4], [0, 5], [2, 0], [0, 6], [0, 7], [0, 8], [3, 0]] }
  };

  /** The layouts the app offers, in the order it shows them. */
  var ORDER = ['grid2x2', 'grid2x2hd', 'side2', 'side5', 'pip', 'pip3', 'pip4'];

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
      var n = TILES[l.feeds[c[0]]], x = k % l.cols, y = Math.floor(k / l.cols);
      if (!rects[c[0]]) rects[c[0]] = { x: x - c[1] % n, y: y - Math.floor(c[1] / n), w: n, h: n };
    });
    var width = l.cols * 960;
    return { cols: l.cols, rows: l.rows, width: width, height: width >= 3840 ? 2160 : l.rows * 544 - 4, rects: rects };
  }

  return { layouts: LAYOUTS, order: ORDER, shape: shape };
});
