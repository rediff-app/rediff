import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RowLayout } from '../.test-build/rowLayout.js';

test('finds rows at boundaries, including before and after the file', () => {
  const rows = new RowLayout([22, 66, 22, 44]);
  assert.deepEqual([0, 1, 2, 3, 4].map(i => rows.offset(i)), [0, 22, 88, 110, 154]);
  assert.deepEqual([-1, 0, 21, 22, 87, 88, 110, 154, 1000].map(y => rows.at(y)), [0, 0, 0, 1, 1, 2, 3, 3, 3]);
});

test('measured wrapping heights move later rows without changing earlier rows', () => {
  const rows = new RowLayout([22, 22, 22, 22]);
  assert.equal(rows.setHeight(1, 110), true);
  assert.equal(rows.setHeight(1, 110), false);
  assert.equal(rows.offset(1), 22);
  assert.equal(rows.offset(2), 132);
  assert.equal(rows.offset(4), 176);
  assert.equal(rows.at(131), 1);
  assert.equal(rows.at(132), 2);
  rows.setHeight(1, 22);
  assert.equal(rows.offset(4), 88);
});

test('handles empty files and a single extremely long wrapped line', () => {
  const empty = new RowLayout([]);
  assert.equal(empty.offset(0), 0);
  assert.equal(empty.at(100), 0);
  assert.equal(empty.setHeight(0, 22), false);
  const rows = new RowLayout([220000, 22]);
  assert.equal(rows.at(219999), 0);
  assert.equal(rows.at(220000), 1);
  assert.equal(rows.offset(2), 220022);
});

test('incremental measurements agree with a full layout after repeated changes', () => {
  let seed = 42;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  const heights = Array.from({ length: 30000 }, () => (random() % 10 + 1) * 22);
  const rows = new RowLayout(heights);
  for (let iteration = 0; iteration < 100; iteration++) {
    const index = random() % heights.length;
    heights[index] = (random() % 100 + 1) * 22;
    rows.setHeight(index, heights[index]);
    const before = heights.slice(0, index).reduce((sum, height) => sum + height, 0);
    assert.equal(rows.offset(index), before);
    assert.equal(rows.at(before), index);
    assert.equal(rows.at(before + heights[index] - 1), index);
  }
  assert.equal(rows.offset(rows.length), heights.reduce((sum, height) => sum + height, 0));
});
