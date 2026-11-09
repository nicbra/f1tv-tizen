/*
 * A static DASH manifest for a stitched stream and its sound, for players that take a URL: AVPlay through the app's
 * helper (http://127.0.0.1:<port>/...), or Shaka. Segment n of the stream is segment n of the feeds ($Number$ from 0).
 *
 *   Dash.mpd({ segments: [seconds, ...], delay: 0.1,
 *     video: { init, media, codecs, width, height, frameRate, bandwidth },
 *     audio: { init, media, codecs, rate, channels, lang, bandwidth } | null }) -> MPD text
 *
 * Timeline: S@t of segment n = its playlist start + delay (the earliest presentation time of its pictures) in the
 * track's timescale (video 90 kHz, audio its sample rate), and presentationTimeOffset = delay: period time = playlist
 * time. The segments start with an IDR (startWithSAP 1).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Dash = factory();
})(this, function () {
  'use strict';

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function iso(sec) { return 'PT' + sec.toFixed(3) + 'S'; }

  // <SegmentTimeline> for segments of `durations` (s) starting at `delay` (s), in `timescale` units; runs of equal
  // durations share one S with @r.
  function timeline(durations, delay, timescale) {
    var at = [], t = delay;
    durations.forEach(function (d) { at.push(Math.round(t * timescale)); t += d; });
    at.push(Math.round(t * timescale));
    var out = [], i = 0;
    while (i < durations.length) {
      var d = at[i + 1] - at[i], r = 0;
      while (i + r + 1 < durations.length && at[i + r + 2] - at[i + r + 1] === d) r++;
      out.push('<S' + (i === 0 ? ' t="' + at[0] + '"' : '') + ' d="' + d + '"' + (r ? ' r="' + r + '"' : '') + '/>');
      i += r + 1;
    }
    return '<SegmentTimeline>' + out.join('') + '</SegmentTimeline>';
  }

  function template(track, timescale, durations, delay) {
    return '<SegmentTemplate timescale="' + timescale + '" presentationTimeOffset="' + Math.round(delay * timescale) +
      '" startNumber="0" initialization="' + esc(track.init) + '" media="' + esc(track.media) + '">' +
      timeline(durations, delay, timescale) + '</SegmentTemplate>';
  }

  function mpd(o) {
    var delay = o.delay == null ? 0.1 : o.delay, total = o.segments.reduce(function (a, b) { return a + b; }, 0), v = o.video, a = o.audio;
    var x = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static" minBufferTime="PT2S"' +
      ' mediaPresentationDuration="' + iso(total) + '">',
      '<Period id="0" start="PT0S">',
      '<AdaptationSet id="0" contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">',
      template(v, 90000, o.segments, delay),
      '<Representation id="stitched" codecs="' + esc(v.codecs) + '" width="' + v.width + '" height="' + v.height + '" frameRate="' +
      esc(v.frameRate || 50) + '" sar="1:1" bandwidth="' + Math.round(v.bandwidth || 6000000) + '"/>',
      '</AdaptationSet>'];
    if (a) {
      x.push('<AdaptationSet id="1" contentType="audio" mimeType="audio/mp4"' + (a.lang ? ' lang="' + esc(a.lang) + '"' : '') +
        ' segmentAlignment="true" startWithSAP="1">',
        template(a, a.rate, o.segments, delay),
        '<Representation id="sound" codecs="' + esc(a.codecs) + '" audioSamplingRate="' + a.rate + '" bandwidth="' + Math.round(a.bandwidth || 128000) + '">',
        '<AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="' + a.channels + '"/>',
        '</Representation>', '</AdaptationSet>');
    }
    x.push('</Period>', '</MPD>');
    return x.join('\n');
  }

  return { mpd: mpd, timeline: timeline };
});
