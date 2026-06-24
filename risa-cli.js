import fs from "fs";
import {
  tokenize,
  cleanSemi,
  parseBasicLoadCases,
  buildBasicLoadCaseHelpers,
  parseLoadsByBasicLoadCase,
  parseNodesOrdered,
  parseMembersResolved
} from "./risa-core.js";

// ---- CLI mode: run without Claude/MCP ----
const command = process.argv[2];

function usage() {
  console.log("RISA-3D CLI");
  console.log("");
  console.log("Commands:");
  console.log('  node risa-cli.js generate-load-summary "C:\\path\\to\\model.r3d"');
  console.log('  node risa-cli.js generate-load-summary "C:\\path\\to\\model.r3d" --include-transient');
  console.log('  node risa-cli.js debug-load-case-counts "C:\\path\\to\\model.r3d"');
  console.log('  node risa-cli.js debug-load-structure "C:\\path\\to\\model.r3d" 10');
  console.log('  node risa-cli.js debug-member-load-rows "C:\\path\\to\\model.r3d" M41');
  console.log('  node risa-cli.js debug-load-membership "C:\\path\\to\\model.r3d"');
}

if (!command || command === "help" || command === "--help") {
  usage();
  process.exit(0);
}

if (command === "generate-load-summary") {
  const filePath = process.argv[3];
  const includeTransientLoads = process.argv.includes("--include-transient");

  if (!filePath) {
    usage();
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, "utf8");
  const nodesOrdered = parseNodesOrdered(content);
  const members = parseMembersResolved(content, nodesOrdered);
  const parsed = parseLoadsByBasicLoadCase(content);

  const report = [];

  report.push("LOAD SUMMARY");
  report.push(`File: ${filePath}`);
  report.push(`Nodes: ${nodesOrdered.length}`);
  report.push(`Members: ${members.length}`);

  report.push("\n=== LOAD TABLE CHECK ===");
  report.push(`Distributed loads: ${parsed.totals.consumedDistributedLoads} / ${parsed.totals.distributedLoads}`);
  report.push(`Area loads: ${parsed.totals.consumedAreaLoads} / ${parsed.totals.areaLoads}`);
  report.push(`Node loads: ${parsed.totals.consumedNodeLoads} / ${parsed.totals.nodeLoads}`);

  parsed.cases.forEach(blc => {
    const isTransient = blc.name.toLowerCase().includes("transient area loads");

    if (isTransient && !includeTransientLoads) {
      report.push(`\n=== BLC ${blc.index}: ${blc.name} ===`);
      report.push(`Skipped generated transient loads. Distributed: ${blc.distributedLoads.length}, Area: ${blc.areaLoads.length}, Node: ${blc.nodeLoads.length}`);
      return;
    }

    report.push(`\n=== BLC ${blc.index}: ${blc.name} ===`);

    report.push("\nDistributed Loads:");
    if (blc.distributedLoads.length === 0) {
      report.push("None");
    } else {
      report.push("Row,Member,StartMag,EndMag,StartLoc,EndLoc");
      blc.distributedLoads.forEach(load => {
        const p = load.tokens;
        const memberIdx = parseInt(p[0], 10);
        const member = members[memberIdx - 1];

        report.push([
          load.rowNumber,
          member ? member.label : `(idx ${memberIdx})`,
          parseFloat(p[2]),
          parseFloat(p[3]),
          parseFloat(p[4]),
          parseFloat(p[5])
        ].join(","));
      });
    }

    report.push("\nArea Loads:");
    if (blc.areaLoads.length === 0) {
      report.push("None");
    } else {
      report.push("Row,Corners,DirectionCode,Magnitude");
      blc.areaLoads.forEach(load => {
        const p = load.tokens;

        const corners = [0, 1, 2, 3].map(i => {
          const node = nodesOrdered[parseInt(p[i], 10) - 1];
          return node ? node.label : `(idx ${p[i]})`;
        }).join("-");

        report.push([
          load.rowNumber,
          corners,
          p[5],
          parseFloat(p[6])
        ].join(","));
      });
    }

    report.push("\nNode Loads:");
    if (blc.nodeLoads.length === 0) {
      report.push("None");
    } else {
      report.push("Row,Node,Magnitude,DirectionCode");
      blc.nodeLoads.forEach(load => {
        const p = load.tokens;
        const nodeIdx = parseInt(p[0], 10);
        const node = nodesOrdered[nodeIdx - 1];

        report.push([
          load.rowNumber,
          node ? node.label : `(idx ${nodeIdx})`,
          parseFloat(p[2]),
          p[3]
        ].join(","));
      });
    }
  });

  console.log(report.join("\n"));
  process.exit(0);
}

if (command === "debug-load-case-counts") {
  const filePath = process.argv[3];

  if (!filePath) {
    usage();
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, "utf8");
  const blcData = parseBasicLoadCases(content);

  const sectionCount = (sectionName, endSectionName) => {
    const regex = new RegExp(`\\[${sectionName}\\] <\\d+>([\\s\\S]*?)\\[${endSectionName}\\]`);
    const match = content.match(regex);
    if (!match) return 0;
    return match[1].trim().split("\n").filter(l => l.trim()).length;
  };

  console.log("RISA LOAD CASE COUNT DEBUG");
  console.log(`File: ${filePath}`);
  console.log("");
  console.log(`NODE_LOADS: ${sectionCount("NODE_LOADS", "END_NODE_LOADS")}`);
  console.log(`DIRECT_DISTRIBUTED_LOADS: ${sectionCount("DIRECT_DISTRIBUTED_LOADS", "END_DIRECT_DISTRIBUTED_LOADS")}`);
  console.log(`AREA_LOADS: ${sectionCount("AREA_LOADS", "END_AREA_LOADS")}`);
  console.log("");
  console.log("BLC,Name,Field2,Field3,Field4,Field5,Field6,Field7,Field8,LastField,RawTokenCount");

  Object.values(blcData.byIndex)
    .sort((a, b) => a.index - b.index)
    .forEach(blc => {
      const t = blc.rawTokens || [];
      console.log([
        blc.index,
        blc.name,
        cleanSemi(t[2]),
        cleanSemi(t[3]),
        cleanSemi(t[4]),
        cleanSemi(t[5]),
        cleanSemi(t[6]),
        cleanSemi(t[7]),
        cleanSemi(t[8]),
        cleanSemi(t[t.length - 1]),
        t.length
      ].join(","));
    });

  process.exit(0);
}

if (command === "debug-load-structure") {
  const filePath = process.argv[3];
  const maxRows = parseInt(process.argv[4] || "10", 10);

  if (!filePath) {
    usage();
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, "utf8");

  function debugSection(sectionName, endSectionName, rowLimit = maxRows) {
    const regex = new RegExp(`\\[${sectionName}\\] <\\d+>([\\s\\S]*?)\\[${endSectionName}\\]`);
    const match = content.match(regex);

    console.log(`\n=== ${sectionName} ===`);

    if (!match) {
      console.log("Section not found.");
      return;
    }

    const lines = match[1].trim().split("\n").filter(l => l.trim());
    console.log(`Total rows: ${lines.length}`);
    console.log(`Showing first ${Math.min(rowLimit, lines.length)} row(s)`);

    lines.slice(0, rowLimit).forEach((line, rowIndex) => {
      const tokens = tokenize(line.trim().replace(";", ""));
      console.log(`\nRow ${rowIndex + 1} raw:`);
      console.log(line.trim());

      tokens.forEach((token, i) => {
        console.log(`  [${i}] = ${cleanSemi(token)}`);
      });
    });
  }

  console.log("RISA LOAD STRUCTURE DEBUG");
  console.log(`File: ${filePath}`);

  debugSection("BASIC_LOAD_CASES", "END_BASIC_LOAD_CASES", maxRows);
  debugSection("NODE_LOADS", "END_NODE_LOADS", maxRows);
  debugSection("DIRECT_DISTRIBUTED_LOADS", "END_DIRECT_DISTRIBUTED_LOADS", maxRows);
  debugSection("AREA_LOADS", "END_AREA_LOADS", maxRows);
  debugSection("LOAD_COMBINATIONS", "END_LOAD_COMBINATIONS", maxRows);

  process.exit(0);
}

if (command === "debug-member-load-rows") {
  const filePath = process.argv[3];
  const memberLabel = process.argv[4];

  if (!filePath || !memberLabel) {
    usage();
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, "utf8");
  const nodesOrdered = parseNodesOrdered(content);
  const members = parseMembersResolved(content, nodesOrdered);

  const memberIndex = members.findIndex(m => m.label === memberLabel) + 1;

  if (memberIndex <= 0) {
    console.log(`Member "${memberLabel}" not found.`);
    process.exit(1);
  }

  const distMatch = content.match(/\[DIRECT_DISTRIBUTED_LOADS\] <\d+>([\s\S]*?)\[END_DIRECT_DISTRIBUTED_LOADS\]/);

  if (!distMatch) {
    console.log("No DIRECT_DISTRIBUTED_LOADS section found.");
    process.exit(1);
  }

  const lines = distMatch[1].trim().split("\n").filter(l => l.trim());
  const matched = lines.filter(line => {
    const parts = line.trim().replace(";", "").split(/\s+/);
    return parseInt(parts[0], 10) === memberIndex;
  });

  console.log("RISA MEMBER LOAD ROW DEBUG");
  console.log(`File: ${filePath}`);
  console.log(`Member label: ${memberLabel}`);
  console.log(`Member positional index: ${memberIndex}`);
  console.log(`Matching distributed load rows: ${matched.length}`);

  matched.forEach((line, rowIndex) => {
    const tokens = tokenize(line.trim().replace(";", ""));

    console.log(`\nMatched Row ${rowIndex + 1} raw:`);
    console.log(line.trim());

    tokens.forEach((token, i) => {
      console.log(`  [${i}] = ${cleanSemi(token)}`);
    });
  });

  process.exit(0);
}

if (command === "debug-load-membership") {
  const filePath = process.argv[3];

  if (!filePath) {
    usage();
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, "utf8");
  const parsed = parseLoadsByBasicLoadCase(content);

  console.log("RISA LOAD MEMBERSHIP DEBUG");
  console.log(`File: ${filePath}`);

  parsed.cases.forEach(blc => {
    console.log(`\n=== BLC ${blc.index}: ${blc.name} ===`);
    console.log(`Distributed: ${blc.distributedLoads.length}`);
    console.log(`Area: ${blc.areaLoads.length}`);
    console.log(`Node: ${blc.nodeLoads.length}`);

    console.log("\nDistributed rows:");
    if (blc.distributedLoads.length === 0) {
      console.log("  None");
    } else {
      blc.distributedLoads.forEach(load => {
        const p = load.tokens;
        console.log(`  #${load.rowNumber}: memberIdx=${p[0]}, rawId=${p[1]}, startMag=${p[2]}, endMag=${p[3]}, lastField=${p[p.length - 1]}`);
      });
    }

    console.log("\nArea rows:");
    if (blc.areaLoads.length === 0) {
      console.log("  None");
    } else {
      blc.areaLoads.forEach(load => {
        const p = load.tokens;
        console.log(`  #${load.rowNumber}: corners=${p[0]}-${p[1]}-${p[2]}-${p[3]}, rawId=${p[4]}, dir=${p[5]}, mag=${p[6]}`);
      });
    }

    console.log("\nNode rows:");
    if (blc.nodeLoads.length === 0) {
      console.log("  None");
    } else {
      blc.nodeLoads.forEach(load => {
        const p = load.tokens;
        console.log(`  #${load.rowNumber}: nodeIdx=${p[0]}, rawId=${p[1]}, mag=${p[2]}, dir=${p[3]}, lastField=${p[p.length - 1]}`);
      });
    }
  });

  console.log("\n=== TOTALS CHECK ===");
  console.log(`Distributed consumed: ${parsed.totals.consumedDistributedLoads} / actual ${parsed.totals.distributedLoads}`);
  console.log(`Area consumed: ${parsed.totals.consumedAreaLoads} / actual ${parsed.totals.areaLoads}`);
  console.log(`Node consumed: ${parsed.totals.consumedNodeLoads} / actual ${parsed.totals.nodeLoads}`);

  process.exit(0);
}

console.log(`Unknown command: ${command}`);
usage();
process.exit(1);