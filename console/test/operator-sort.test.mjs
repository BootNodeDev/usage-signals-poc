// The operator table sorts through the seam, so the rule for small counts is in one place.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';

const SMALL = { small: true, below: 10 };
const source = await readFile(path.resolve(import.meta.dirname, '..', 'public', 'data.js'), 'utf8');
const window = {};
vm.runInNewContext(source, { window });
const { sortRows } = window.LData;

const row = (name, pageviews) => ({ project: { name }, totals: { pageviews } });
const names = (rows) => rows.map((r) => r.project.name).join(' ');
const pick = (r) => r.totals.pageviews;

describe('sortRows', () => {
  const rows = [row('Delta', SMALL), row('Alpha', 0), row('Echo', 250), row('Bravo', SMALL), row('Charlie', 10), row('Foxtrot', null)];

  it('puts a small count between zero and ten, in both directions, and nothing last', () => {
    assert.equal(names(sortRows(rows, pick, true)), 'Echo Charlie Bravo Delta Alpha Foxtrot');
    assert.equal(names(sortRows(rows, pick, false)), 'Alpha Bravo Delta Charlie Echo Foxtrot');
  });

  it('keeps rows with the same value in name order whatever the input order', () => {
    const shuffled = [rows[3], rows[0], rows[5], rows[2], rows[4], rows[1]];
    assert.equal(names(sortRows(shuffled, pick, true)), names(sortRows(rows, pick, true)));
    assert.equal(names(sortRows(shuffled, pick, false)), names(sortRows(rows, pick, false)));
  });

  it('does not change the list it is given', () => {
    const before = names(rows);
    sortRows(rows, pick, true);
    assert.equal(names(rows), before);
  });
});
