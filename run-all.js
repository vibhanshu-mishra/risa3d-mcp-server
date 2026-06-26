import { spawnSync } from "child_process";

const files = [
  "parser.test.js",
  "loads.test.js",
  "qc.test.js",
  "write-tools.test.js",
  "geometry.test.js"
];

let failed = false;

console.log("Running full regression suite...\n");

for (const file of files) {
  console.log(`=== ${file} ===`);

  const result = spawnSync("node", [`tests/${file}`], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    failed = true;
  }

  console.log("");
}

if (failed) {
  console.log("Regression suite failed.");
  process.exit(1);
}

console.log("Full regression suite passed.");