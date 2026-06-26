import assert from "assert";

import {
  runQCChecks
} from "../risa-core.js";

import {
  readSample,
  test
} from "./test-utils.js";

const content = readSample();

test("runQCChecks returns usable QC object", () => {
  const qc = runQCChecks(content);

  assert.ok(Number.isInteger(qc.nodeCount), "Expected nodeCount integer");
  assert.ok(Number.isInteger(qc.memberCount), "Expected memberCount integer");
  assert.ok(Number.isInteger(qc.issueCount), "Expected issueCount integer");
  assert.ok(["PASS", "REVIEW"].includes(qc.status), "Expected PASS or REVIEW");
});

test("runQCChecks returns arrays for issue categories", () => {
  const qc = runQCChecks(content);

  assert.ok(Array.isArray(qc.duplicateNodes));
  assert.ok(Array.isArray(qc.duplicateMemberLabels));
  assert.ok(Array.isArray(qc.missingSize));
  assert.ok(Array.isArray(qc.zeroLength));
  assert.ok(Array.isArray(qc.invalidNodeRefs));
});