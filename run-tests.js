import fs from "fs";
import path from "path";
import assert from "assert";

import {
  tokenize,
  clean,
  parseNodesOrdered,
  parseMembersResolved,
  parseLoadsByBasicLoadCase,
  runQCChecks,
  replaceSectionSizeInContent,
  distance3D
} from "../risa-core.js";

const fixturePath = path.join(process.cwd(), "tests", "fixtures", "sample.r3d");
const outputDir = path.join(process.cwd(), "tests", "output");

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err.message);
    process.exitCode = 1;
  }
}

function readSample() {
  assert.ok(fs.existsSync(fixturePath), `Missing fixture file: ${fixturePath}`);
  return fs.readFileSync(fixturePath, "utf8");
}

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const content = readSample();

test("tokenize keeps quoted text together", () => {
  const tokens = tokenize('"BLC 1 Transient Area Loads" 0 0 0;');
  assert.strictEqual(clean(tokens[0]), "BLC 1 Transient Area Loads");
  assert.strictEqual(tokens.length, 4);
});

test("parseNodesOrdered finds nodes", () => {
  const nodes = parseNodesOrdered(content);
  assert.ok(nodes.length > 0, "Expected at least one node");
  assert.ok(nodes[0].label, "First node should have a label");
  assert.ok(Number.isFinite(nodes[0].x), "First node should have numeric X coordinate");
});

test("parseMembersResolved finds members", () => {
  const nodes = parseNodesOrdered(content);
  const members = parseMembersResolved(content, nodes);

  assert.ok(members.length > 0, "Expected at least one member");
  assert.ok(members[0].label, "First member should have a label");
  assert.ok(members[0].iNodeIndex > 0, "First member should have an i-node index");
  assert.ok(members[0].jNodeIndex > 0, "First member should have a j-node index");
});

test("member lengths can be calculated", () => {
  const nodes = parseNodesOrdered(content);
  const members = parseMembersResolved(content, nodes);

  const memberWithCoords = members.find(m => m.iCoord && m.jCoord);
  assert.ok(memberWithCoords, "Expected at least one member with valid node coordinates");

  const len = distance3D(memberWithCoords.iCoord, memberWithCoords.jCoord);
  assert.ok(len > 0, "Expected member length to be greater than zero");
});

test("parseLoadsByBasicLoadCase does not over-consume load rows", () => {
  const parsed = parseLoadsByBasicLoadCase(content);

  assert.ok(parsed.cases.length > 0, "Expected at least one basic load case");

  assert.ok(
    parsed.totals.consumedNodeLoads <= parsed.totals.nodeLoads,
    "Consumed node loads should not exceed actual node load rows"
  );

  assert.ok(
    parsed.totals.consumedDistributedLoads <= parsed.totals.distributedLoads,
    "Consumed distributed loads should not exceed actual distributed load rows"
  );

  assert.ok(
    parsed.totals.consumedAreaLoads <= parsed.totals.areaLoads,
    "Consumed area loads should not exceed actual area load rows"
  );
});

test("runQCChecks returns usable QC object", () => {
  const qc = runQCChecks(content);

  assert.ok(Number.isInteger(qc.nodeCount), "QC nodeCount should be an integer");
  assert.ok(Number.isInteger(qc.memberCount), "QC memberCount should be an integer");
  assert.ok(["PASS", "REVIEW"].includes(qc.status), "QC status should be PASS or REVIEW");
});

test("replaceSectionSizeInContent does not crash", () => {
  const result = replaceSectionSizeInContent(content, {
    oldSize: "THIS_SIZE_SHOULD_NOT_EXIST",
    newSize: "NEW_FAKE_SIZE",
    scope: "both"
  });

  assert.strictEqual(result.setsChanged, 0);
  assert.strictEqual(result.membersChanged, 0);
  assert.strictEqual(result.content, content);
});

test("write and re-read sample copy", () => {
  const outPath = path.join(outputDir, "sample-copy.r3d");

  fs.writeFileSync(outPath, content, "utf8");

  const reread = fs.readFileSync(outPath, "utf8");
  const nodes = parseNodesOrdered(reread);
  const members = parseMembersResolved(reread, nodes);

  assert.ok(nodes.length > 0, "Copied file should still parse nodes");
  assert.ok(members.length > 0, "Copied file should still parse members");
});

if (process.exitCode === 1) {
  console.log("");
  console.log("Some tests failed.");
} else {
  console.log("");
  console.log("All regression tests passed.");
}