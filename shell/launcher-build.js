/* Release default. local/app/launcher-build.js replaces this in development packages. */
(function (root) {
  var build = { updates: true, channel: 'stable' };
  if (typeof module !== 'undefined' && module.exports) module.exports = build;
  else root.LauncherBuild = build;
})(this);
