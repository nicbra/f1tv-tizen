'use strict';
// app/js/markdown.js: the app's own Markdown documents (app/PRIVACY.md under Read more).
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');

function load() {
  class Node {
    constructor(tag, text) { this.tag = tag; this.children = []; this.text = text || ''; }
    appendChild(c) { this.children.push(c); return c; }
    get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this.children = []; this.text = String(v); }
  }
  const document = { createElement: (t) => new Node(t), createTextNode: (t) => new Node('#text', t) };
  const context = vm.createContext({ document });
  vm.runInContext(readFileSync('app/js/markdown.js', 'utf8'), context, { filename: 'markdown.js' });
  return context.Markdown;
}

/** The element tree as [tag, text or children] (text nodes as strings). */
function shape(n) {
  if (n.tag === '#text') return n.text;
  if (n.children.every((c) => c.tag === '#text')) return [n.tag, n.textContent];
  return [n.tag, n.children.map(shape)];
}

test('headings, paragraphs, lists and inline marks become plain elements; the first heading is the title', () => {
  const md = load();
  const d = md.render([
    '# Title here', '<!-- a note for maintainers', 'over two lines -->', '',
    'First line', 'joined to the second.', '',
    '## Section', '- one **bold** item', '  continued', '* two `code`', '1. first', '2) second', '',
    '### Small', 'See [GitHub](https://github.com/x/y/issues), [the README](../README.md) and [https://a.b](https://a.b).',
    'Text <b>not HTML</b> & stays.'
  ].join('\r\n'));
  assert.equal(d.title, 'Title here');
  assert.deepEqual(d.body.children.map(shape), [
    ['p', 'First line joined to the second.'],
    ['h3', 'Section'],
    ['ul', [['li', ['one ', ['strong', 'bold'], ' item continued']], ['li', ['two ', ['code', 'code']]]]],
    ['ol', [['li', 'first'], ['li', 'second']]],
    ['h4', 'Small'],
    ['p', 'See GitHub (github.com/x/y/issues), the README and https://a.b. Text <b>not HTML</b> & stays.']
  ]);
});

test('a heading after text is a section, not the title', () => {
  const d = load().render('Intro\n\n# Not the title');
  assert.equal(d.title, null);
  assert.deepEqual(d.body.children.map(shape), [['p', 'Intro'], ['h3', 'Not the title']]);
});

test('app/PRIVACY.md renders with its title, its headings and no Markdown left in the text', () => {
  // Taken from the file, so its wording can change freely.
  const md = readFileSync('app/PRIVACY.md', 'utf8');
  const d = load().render(md);
  assert.equal(d.title, md.match(/^# (.+)$/m)[1]);
  const headings = md.match(/^#{2,6} .+$/gm).map((h) => h.replace(/^#+ /, ''));
  assert.ok(headings.length > 1);
  assert.deepEqual(d.body.children.filter((c) => /^h\d$/.test(c.tag)).map((c) => c.textContent), headings);
  assert.doesNotMatch(d.body.textContent, /\*\*|`|\]\(|<!--|-->|^#/m);
});
