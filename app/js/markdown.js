/*
 * Markdown for the app's own documents (PRIVACY.md, which the README links to as well): headings, paragraphs, lists,
 * **bold**, `code` and links. A link shows its text, and a web address after it (nothing can be clicked on a TV).
 * Everything becomes text nodes in plain elements: nothing in a file is ever read as HTML.
 */
var Markdown = (function () {
  'use strict';

  function node(tag) { return document.createElement(tag); }

  /** Inline text: **bold**, `code`, [text](url). */
  function inline(parent, text) {
    var re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1] != null) inline(parent.appendChild(node('strong')), m[1]);
      else if (m[2] != null) parent.appendChild(node('code')).textContent = m[2];
      else {
        inline(parent, m[3]);
        var address = m[4].replace(/^https?:\/\//, '');
        if (/^https?:\/\//.test(m[4]) && m[3] !== address && m[3] !== m[4]) parent.appendChild(document.createTextNode(' (' + address + ')'));
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  /**
   * { title, body }: a leading "# Heading" becomes the title (the dialog shows it), the rest a <div> of h3/h4, p, ul
   * and ol elements. HTML comments are left out.
   */
  function render(text) {
    var lines = String(text).replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
    var body = node('div'), title = null, started = false, para = [], list = null, item = null;

    function endItem() { if (item) inline(item.el, item.text.join(' ')); item = null; }
    function endBlock() {
      endItem();
      if (para.length) inline(body.appendChild(node('p')), para.join(' '));
      para = []; list = null;
    }

    lines.forEach(function (line) {
      var m;
      if (!/\S/.test(line)) return endBlock();
      if ((m = /^#{1,6}(?=\s)/.exec(line))) {
        endBlock();
        var level = m[0].length, words = line.slice(level).replace(/\s#+\s*$/, '').trim();
        if (level === 1 && !started && title === null) title = words;
        else inline(body.appendChild(node(level <= 2 ? 'h3' : 'h4')), words);
        started = true;
        return;
      }
      started = true;
      if ((m = /^ {0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line))) {
        var ordered = /\d/.test(m[1]);
        if (para.length || (list && list.ordered !== ordered)) endBlock();
        endItem();
        if (!list) list = { el: body.appendChild(node(ordered ? 'ol' : 'ul')), ordered: ordered };
        item = { el: list.el.appendChild(node('li')), text: [m[2].trim()] };
        return;
      }
      // A line under a list item continues it (indented or not, as on GitHub).
      if (item) return item.text.push(line.trim());
      para.push(line.trim());
    });
    endBlock();
    return { title: title, body: body };
  }

  return { render: render };
})();
