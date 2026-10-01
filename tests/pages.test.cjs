const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(hash = '') {
  const nodes = new Map(), listeners = new Map(), changes = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: '', dataset: {}, attributes: {},
      append(child) { child.parentElement = this; }, setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; } });
    return nodes.get(id);
  };
  const links = ['kaynakca', 'word', 'icerik'].map(key => { const link = node('link-' + key); link.dataset.pageLink = key; return link; });
  const workspace = node('word-workspace');
  workspace.parentElement = node('page-word');
  workspace.loadedDocument = { id: 'same-document', corrections: ['year-1'] };
  node('reference-input').value = 'Saved bibliography';
  const document = { body: { dataset: {} }, getElementById: node, querySelector: node, querySelectorAll: () => links };
  const location = { hash };
  const window = { addEventListener: (key, cb) => listeners.set(key, cb), dispatchEvent: event => changes.push(event.detail), scrollTo() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages.js'), 'utf8'), {
    document, location, window, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  });
  return { node, document, location, window, changes, listeners, workspace };
}

test('three page routes keep independent workspaces in their own pages', () => {
  const u = fixture();
  assert.equal(u.document.body.dataset.page, 'kaynakca');
  assert.equal(u.node('page-word').hidden, true);
  const original = u.workspace.loadedDocument;
  u.window.AppPages.navigate('word');
  assert.equal(u.node('page-kaynakca').hidden, true);
  assert.equal(u.node('page-word').hidden, false);
  u.window.AppPages.navigate('icerik');
  assert.equal(u.workspace.parentElement, u.node('page-word'));
  assert.equal(u.node('page-word').hidden, true);
  assert.equal(u.node('link-icerik').attributes['aria-current'], 'page');
  assert.equal(u.node('link-word').attributes['aria-current'], undefined);
  u.window.AppPages.navigate('word');
  assert.equal(u.workspace.parentElement, u.node('page-word'));
  assert.equal(u.workspace.loadedDocument, original);
  assert.equal(u.node('reference-input').value, 'Saved bibliography');
});

test('direct content links, history changes and old Word bookmarks select the correct page', () => {
  const u = fixture('#/icerik');
  assert.equal(u.document.body.dataset.page, 'icerik');
  u.location.hash = '#/kaynakca';
  u.listeners.get('hashchange')();
  assert.equal(u.node('page-kaynakca').hidden, false);
  u.location.hash = '#word-p-word/document.xml:24';
  u.listeners.get('hashchange')();
  assert.equal(u.document.body.dataset.page, 'word');
  const count = u.changes.length;
  u.listeners.get('hashchange')();
  assert.equal(u.changes.length, count);
});

test('router asset is served by local server', async () => {
  const server = require('../server.cjs').createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/pages.js');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.match(await response.text(), /app-page-change/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
