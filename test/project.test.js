import assert from "node:assert/strict";
import test from "node:test";

import { getCurrentProject } from "../src/project.js";

test("project IDs normalize POSIX paths", () => {
  assert.equal(getCurrentProject("/var/www/html"), "-var-www-html");
});

test("project IDs normalize Windows paths", () => {
  assert.equal(getCurrentProject("C:\\Users\\agent\\project"), "C--Users-agent-project");
});
