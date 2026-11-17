import test from "node:test";
import assert from "node:assert/strict";
import { csvCell } from "../src/lib/reelsuccess-export.ts";

test("CSV preserves missing values separately from explicit zero", () => {
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
  assert.equal(csvCell(0), '"0"');
});

test("CSV safely quotes movie titles and multiline fields", () => {
  assert.equal(csvCell('A "movie", part 2'), '"A ""movie"", part 2"');
  assert.equal(csvCell("First\nSecond"), '"First\nSecond"');
});

test("CSV treats spreadsheet formulas as literal text", () => {
  for (const value of ["=1+1", "+SUM(1,2)", "-1+2", "@example", "  =1+1", "\t=1+1", "\r=1+1"]) {
    assert.ok(csvCell(value).startsWith(`"'`), value);
  }
});
