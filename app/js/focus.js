/*
 * Minimal grid focus for remote navigation. A "grid" is a list of rows, each row
 * a list of DOM elements. Rows scroll horizontally, the row container vertically.
 */
var Focus = (function () {
  function Grid(rows, opts) {
    this.rows = rows;
    this.opts = opts || {};
    this.r = 0;
    this.c = [];
    for (var i = 0; i < rows.length; i++) this.c.push(0);
  }

  Grid.prototype.current = function () {
    var row = this.rows[this.r];
    return row ? row[this.c[this.r]] : null;
  };

  Grid.prototype.apply = function () {
    var prev = document.querySelectorAll('.focused');
    for (var i = 0; i < prev.length; i++) prev[i].classList.remove('focused');
    var el = this.current();
    if (!el) return;
    el.classList.add('focused');
    if (this.opts.onMove) this.opts.onMove(this.r, this.c[this.r], el);
  };

  Grid.prototype.move = function (dr, dc) {
    if (!this.rows.length) return false;
    if (dr) {
      var nr = this.r + dr;
      if (nr < 0 || nr >= this.rows.length) return false;
      this.r = nr;
    }
    if (dc) {
      var row = this.rows[this.r];
      var nc = this.c[this.r] + dc;
      if (nc < 0 || nc >= row.length) return false;
      this.c[this.r] = nc;
    }
    this.apply();
    return true;
  };

  Grid.prototype.handle = function (key) {
    var K = Keys.codes;
    if (key === K.LEFT) return this.move(0, -1);
    if (key === K.RIGHT) return this.move(0, 1);
    if (key === K.UP) return this.move(-1, 0);
    if (key === K.DOWN) return this.move(1, 0);
    if (key === K.ENTER) {
      var el = this.current();
      if (el && this.opts.onSelect) this.opts.onSelect(el, this.r, this.c[this.r]);
      return true;
    }
    return false;
  };

  return { Grid: Grid };
})();
