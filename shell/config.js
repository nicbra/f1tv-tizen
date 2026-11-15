/* Shell ABI: raise this for config.xml, keys or incompatible boot/updater changes. */
(function (root) {
  var config = {
    SHELL_LEVEL: 1,
    keys: { 'f1tv-2026': 'xAIbni2qyhIKpC/pWDBvfR58Sk5qP3vJ2S580IMwLG4=' },
    repo: 'nicbra/f1tv-tizen',
    packageId: 'F1TVtizen1'
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = config;
  else root.LauncherConfig = config;
})(this);
