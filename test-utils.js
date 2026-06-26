import fs from "fs";
import path from "path";
import assert from "assert";

export const rootDir = process.cwd();
export const fixturesDir = path.join(rootDir, "tests", "fixtures");
export const outputDir = path.join(rootDir, "tests", "output");
export const samplePath = path.join(fixturesDir, "sample.r3d");

export function ensureOutputDir() {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
}

export function readSample() {
  assert.ok(fs.existsSync(samplePath), `Missing fixture file: ${samplePath}`);
  return fs.readFileSync(samplePath, "utf8");
}

export function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err.message);
    process.exitCode = 1;
  }
}