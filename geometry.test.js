import assert from "assert";

import {
  parseNodesOrdered,
  getNodesSection,
  getMembersSection,
  getTrailingNodeFields,
  buildNodeLine,
  generateUnusedLabel,
  findOrCreateNodeForGeometry
} from "../risa-core.js";

import {
  readSample,
  test
} from "./test-utils.js";

const content = readSample();

test("getNodesSection finds node lines", () => {
  const section = getNodesSection(content);

  assert.ok(section, "Expected nodes section");
  assert.ok(section.lines.length > 0, "Expected node lines");
});

test("getMembersSection finds member lines", () => {
  const section = getMembersSection(content);

  assert.ok(section, "Expected members section");
  assert.ok(section.lines.length > 0, "Expected member lines");
});

test("getTrailingNodeFields returns reusable trailing fields", () => {
  const section = getNodesSection(content);
  const trailing = getTrailingNodeFields(section.lines);

  assert.ok(typeof trailing === "string");
  assert.ok(trailing.length > 0);
});

test("buildNodeLine creates valid node line", () => {
  const section = getNodesSection(content);
  const trailing = getTrailingNodeFields(section.lines);

  const line = buildNodeLine("N9999", 1, 2, 3, trailing);

  assert.ok(line.includes('"N9999'));
  assert.ok(line.endsWith(";"));
});

test("generateUnusedLabel creates unused label", () => {
  const used = new Set(["N9001", "N9002"]);
  const label = generateUnusedLabel("N", used);

  assert.strictEqual(label, "N9003");
  assert.ok(used.has("N9003"));
});

test("findOrCreateNodeForGeometry reuses existing node within tolerance", () => {
  const nodes = parseNodesOrdered(content);
  const first = nodes[0];

  const workingNodes = nodes.map((n, i) => ({ ...n, index: i + 1 }));
  const existingNodeLabels = new Set(nodes.map(n => n.label));
  const newNodeLines = [];

  const index = findOrCreateNodeForGeometry({
    coord: { x: first.x, y: first.y, z: first.z },
    workingNodes,
    existingNodeLabels,
    newNodeLines,
    trailingNodeFields: "",
    tolerance: 0.001
  });

  assert.strictEqual(index, 1);
  assert.strictEqual(newNodeLines.length, 0);
});