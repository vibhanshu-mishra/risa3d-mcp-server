import assert from "assert";

import {
  tokenize,
  clean,
  parseNodesOrdered,
  parseMembersResolved,
  distance3D
} from "../risa-core.js";

import {
  readSample,
  test
} from "./test-utils.js";

const content = readSample();

test("tokenize keeps quoted text together", () => {
  const tokens = tokenize('"BLC 1 Transient Area Loads" 0 0 0;');

  assert.strictEqual(clean(tokens[0]), "BLC 1 Transient Area Loads");
  assert.strictEqual(tokens.length, 4);
});

test("clean removes quotes and trims spaces", () => {
  assert.strictEqual(clean('"  M41   "'), "M41");
});

test("parseNodesOrdered finds nodes", () => {
  const nodes = parseNodesOrdered(content);

  assert.ok(nodes.length > 0, "Expected at least one node");
  assert.ok(nodes[0].label, "First node should have a label");
  assert.ok(Number.isFinite(nodes[0].x), "First node should have numeric X");
  assert.ok(Number.isFinite(nodes[0].y), "First node should have numeric Y");
  assert.ok(Number.isFinite(nodes[0].z), "First node should have numeric Z");
});

test("parseMembersResolved finds members", () => {
  const nodes = parseNodesOrdered(content);
  const members = parseMembersResolved(content, nodes);

  assert.ok(members.length > 0, "Expected at least one member");
  assert.ok(members[0].label, "First member should have a label");
  assert.ok(members[0].iNodeIndex > 0, "First member should have i-node index");
  assert.ok(members[0].jNodeIndex > 0, "First member should have j-node index");
});

test("distance3D calculates member length", () => {
  const nodes = parseNodesOrdered(content);
  const members = parseMembersResolved(content, nodes);

  const memberWithCoords = members.find(m => m.iCoord && m.jCoord);
  assert.ok(memberWithCoords, "Expected at least one member with valid coords");

  const len = distance3D(memberWithCoords.iCoord, memberWithCoords.jCoord);
  assert.ok(len > 0, "Expected length greater than zero");
});