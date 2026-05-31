import test from "node:test";
import assert from "node:assert/strict";

import { buildTokenHref } from "../dashboard-subpage-init.js";

test("buildTokenHref appends token onto hrefs that already contain query params", () => {
  assert.equal(
    buildTokenHref("/watchdog/progress?page=home", "abc123"),
    "/watchdog/progress?page=home&token=abc123",
  );
});

test("buildTokenHref replaces existing token instead of duplicating it", () => {
  assert.equal(
    buildTokenHref("/watchdog/progress?token=old&page=home", "abc123"),
    "/watchdog/progress?token=abc123&page=home",
  );
});
