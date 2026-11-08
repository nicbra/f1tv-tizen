/*
 * Build switches for diagnostics. record: the local log (js/diag.js), personal builds only. server: where the
 * upload (js/diag-upload.js) sends; release builds get it from the DIAG_SERVER Actions variable
 * (scripts/build-release.sh writes it here), and without it nothing is sent or asked. Personal builds can replace
 * this file (scripts/deploy.sh copies local/app/ over app/), e.g.:
 *   var DIAG_BUILD = { record: true, label: 'dev', server: 'https://diagnostics.example/diag/v1' };
 */
var DIAG_BUILD = { record: false };
