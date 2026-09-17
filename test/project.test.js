import assert from "node:assert/strict";
import test from "node:test";

import { getCurrentProject } from "../src/project.js";

test("project IDs normalize POSIX paths", () => {
  assert.equal(getCurrentProject("/var/www/html"), "path:/var/www/html");
});

test("project IDs normalize Windows paths", () => {
  assert.equal(getCurrentProject("C:\\Users\\agent\\project"), "path:C:/Users/agent/project");
});

test("project identifiers distinguish hyphens from path separators and normalize equivalent paths", () => {
  assert.notEqual(getCurrentProject("/work/a-b"), getCurrentProject("/work/a/b"));
  assert.equal(getCurrentProject("/work/a/../b/"), getCurrentProject("/work/b"));
  assert.equal(getCurrentProject("c:\\work\\a\\..\\b\\"), getCurrentProject("C:/work/b"));
});
