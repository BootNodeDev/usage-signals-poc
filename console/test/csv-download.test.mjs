import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';

const source = await readFile(path.resolve(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
const clicked = [];
const element = () => ({ dataset: {}, appendChild() {}, click() { clicked.push(this); } });
const window = { LData: { meta: () => ({}), project: () => null, currentProjectSlug: () => null } };
vm.runInNewContext(source, {
  window,
  document: { readyState: 'complete', body: element(), head: element(), getElementById: element, createElement: element, addEventListener() {} },
  Blob: class { constructor(parts, options) { this.text = parts.join(''); this.type = options.type; } },
  URL: { createObjectURL: (blob) => blob, revokeObjectURL() {} },
  setTimeout: () => {},
});

function download(rows) {
  window.App.downloadCsv('file.csv', ['Name', 'Count'], rows);
  return clicked.at(-1);
}

describe('downloadCsv', () => {
  it('saves a UTF-8 file under the given name, one CRLF line per row, numbers bare and text quoted', () => {
    const link = download([['Café, "the" bar', 1234], ['<10', 0], [null, 12.5]]);
    assert.equal(link.download, 'file.csv');
    assert.equal(link.href.type, 'text/csv;charset=utf-8');
    assert.equal(link.href.text, '\uFEFF"Name","Count"\r\n"Café, ""the"" bar",1234\r\n"<10",0\r\n"",12.5\r\n');
  });

  it('puts a quote before text a spreadsheet would run as a formula, and leaves numbers alone', () => {
    const link = download([['=1+1', -3], ['+1', 0], ['-1', 0], ['@SUM(A1)', 0], ['\tx', 0], [' =1+1', 0]]);
    assert.deepEqual(link.href.text.split('\r\n').slice(1, -1), ['"\'=1+1",-3', '"\'+1",0', '"\'-1",0', '"\'@SUM(A1)",0', '"\'\tx",0', '"\' =1+1",0']);
  });
});
