import assert from "assert";

import {
  parseBasicLoadCases,
  parseLoadsByBasicLoadCase
} from "../risa-core.js";

import {
  readSample,
  test
} from "./test-utils.js";

const content = readSample();

test("parseBasicLoadCases finds load cases", () => {
  const blc = parseBasicLoadCases(content);
  const cases = Object.values(blc.byIndex);

  assert.ok(cases.length > 0, "Expected at least one basic load case");
  assert.ok(cases[0].name, "First load case should have a name");
});

test("parseLoadsByBasicLoadCase returns cases and totals", () => {
  const parsed = parseLoadsByBasicLoadCase(content);

  assert.ok(parsed.cases.length > 0, "Expected load cases");
  assert.ok(Number.isInteger(parsed.totals.nodeLoads), "Expected node load total");
  assert.ok(Number.isInteger(parsed.totals.distributedLoads), "Expected distributed load total");
  assert.ok(Number.isInteger(parsed.totals.areaLoads), "Expected area load total");
});

test("parseLoadsByBasicLoadCase does not over-consume rows", () => {
  const parsed = parseLoadsByBasicLoadCase(content);

  assert.ok(parsed.totals.consumedNodeLoads <= parsed.totals.nodeLoads);
  assert.ok(parsed.totals.consumedDistributedLoads <= parsed.totals.distributedLoads);
  assert.ok(parsed.totals.consumedAreaLoads <= parsed.totals.areaLoads);
});

test("load cases include readable names", () => {
  const parsed = parseLoadsByBasicLoadCase(content);
  const names = parsed.cases.map(c => c.name);

  assert.ok(names.length > 0, "Expected readable load case names");
  assert.ok(names.every(name => typeof name === "string" && name.length > 0));
});