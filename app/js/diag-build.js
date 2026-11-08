/*
 * Build switches for the diagnostics log (js/diag.js). Release builds record nothing unless the viewer
 * opts in. Personal builds can replace this file (scripts/deploy.sh copies local/app/ over app/), e.g.:
 *   var DIAG_BUILD = { record: true, label: 'dev' };
 */
var DIAG_BUILD = { record: false };
