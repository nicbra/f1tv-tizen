/* What the "Up next" card says about the next part of a broadcast (see offerNextPart in app.js). */
var UpNext = {
  /**
   * The card's text for a next part that is live ('live'), a replay ('done') or not on air yet:
   * left is the countdown in seconds, or null while it waits for the start; starts is the start time.
   */
  lines: function (title, state, left, starts) {
    return {
      title: title,
      sub: left == null ? 'Starts ' + starts : (state === 'live' ? '' : 'Replay · ') + (state === 'live' ? 'Starts' : 'starts') + ' in ' + left + ' s'
    };
  }
};
