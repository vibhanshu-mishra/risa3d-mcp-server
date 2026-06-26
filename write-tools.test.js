import fs from "fs";
import path from "path";
import assert from "assert";

import {
  parseNodesOrdered,
  parseMembersResolved,
  replaceSectionSizeInContent,
  getNodesSection,
  getMembersSection,
  rebuildNodesSection,
  rebuildMembersSection
} from "../risa-core.js";

import {
  readSample,
  outputDir,
  ensureOutputDir,
  test
} from "./test-utils.js";

ensureOutputDir();

const content = readSample();

test("replaceSectionSizeInContent safely handles no-match replacement", () => {
  const result = replaceSectionSizeInContent(content, {
    oldSize: "THIS_SIZE_SHOULD_NOT_EXIST",
    newSize: "NEW_FAKE_SIZE",
    scope: "both"
  });

  assert.strictEqual(result.setsChanged, 0);
  assert.strictEqual(result.membersChanged, 0);
  assert.strictEqual(result.content, content);
});

test("getNodesSection and rebuildNodesSection preserve node count", () => {
  const nodesSection = getNodesSection(content);

  assert.ok(nodesSection, "Expected nodes section");

  const rebuilt = rebuildNodesSection(nodesSection.match, nodesSection.lines);
  const originalCount = nodesSection.lines.length;

  assert.ok(rebuilt.includes(`[NODES] <${originalCount}>`));
});

test("getMembersSection and rebuildMembersSection preserve member count", () => {
  const membersSection = getMembersSection(content);

  assert.ok(membersSection, "Expected members section");

  const rebuilt = rebuildMembersSection(membersSection.match, membersSection.lines);
  const originalCount = membersSection.lines.length;

  assert.ok(rebuilt.includes(`[.MEMBERS_MAIN_DATA] <${originalCount}>`));
});

test("write and re-read copied model", () => {
  const outPath = path.join(outputDir, "sample-copy.r3d");

  fs.writeFileSync(outPath, content, "utf8");

  const reread = fs.readFileSync(outPath, "utf8");
  const nodes = parseNodesOrdered(reread);
  const members = parseMembersResolved(reread, nodes);

  assert.ok(nodes.length > 0, "Copied file should parse nodes");
  assert.ok(members.length > 0, "Copied file should parse members");
});