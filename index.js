import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";

const server = new McpServer({
  name: "risa3d-mcp",
  version: "1.0.0"
});

// ---- Helpers ----

// Quote-aware tokenizer: treats anything inside "..." (including internal
// spaces from RISA's fixed-width padding) as a single token.
function tokenize(line) {
  const tokens = [];
  let i = 0;
  const len = line.length;
  while (i < len) {
    while (i < len && /\s/.test(line[i])) i++;
    if (i >= len) break;
    if (line[i] === '"') {
      let j = i + 1;
      while (j < len && line[j] !== '"') j++;
      tokens.push(line.substring(i, j + 1));
      i = j + 1;
    } else {
      let j = i;
      while (j < len && !/\s/.test(line[j])) j++;
      tokens.push(line.substring(i, j));
      i = j;
    }
  }
  return tokens;
}

// Strips quotes and trims padding whitespace from a token
function clean(token) {
  return (token || "").replace(/"/g, "").trim();
}

// Parses the [NODES] section into an ORDERED array (order matters - members
// reference nodes by their 1-based position in this list, not by label).
function parseNodesOrdered(content) {
  const match = content.match(/\[NODES\] <\d+>([\s\S]*?)\[END_NODES\]/);
  if (!match) return [];
  return match[1].trim().split("\n").filter(l => l.trim()).map(line => {
    const t = tokenize(line);
    return { label: clean(t[0]), x: parseFloat(t[1]), y: parseFloat(t[2]), z: parseFloat(t[3]) };
  });
}

// Parses [.MEMBERS_MAIN_DATA] and resolves i/j node indices to labels + coords
// using the ordered node list. Member line format:
//   Label, Type(category), Size, iNodeIndex(1-based), jNodeIndex(1-based), ...
function parseMembersResolved(content, nodesOrdered) {
  const match = content.match(/\[\.MEMBERS_MAIN_DATA\] <\d+>([\s\S]*?)\[\.END_MEMBERS_MAIN_DATA\]/);
  if (!match) return [];
  return match[1].trim().split("\n").filter(l => l.trim()).map(line => {
    const t = tokenize(line);
    const label = clean(t[0]);
    const type = clean(t[1]);
    const size = clean(t[2]);
    const iIdx = parseInt(t[3], 10);
    const jIdx = parseInt(t[4], 10);
    const iNodeObj = nodesOrdered[iIdx - 1];
    const jNodeObj = nodesOrdered[jIdx - 1];
    return {
      label, type, size,
      iNodeIndex: iIdx,
      jNodeIndex: jIdx,
      iNode: iNodeObj ? iNodeObj.label : null,
      jNode: jNodeObj ? jNodeObj.label : null,
      iCoord: iNodeObj || null,
      jCoord: jNodeObj || null
    };
  });
}

function distance3D(a, b) {
  if (!a || !b) return null;
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Tool 1: Read and summarize a .r3d file
server.tool(
  "read_risa_model",
  { filePath: z.string().describe("Full path to the .r3d file") },
  async ({ filePath }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");

      const nodeMatch = content.match(/\[NODES\] <(\d+)>/);
      const memberMatch = content.match(/\[MEMBERS_MAIN_DATA\] <(\d+)>/);
      const plateMatch = content.match(/\[PLATES\] <(\d+)>/);

      const titleMatch = content.match(/\[\.\.MODEL_TITLE\] <1>\s*\n([^\n]+)/);
      const companyMatch = content.match(/\[\.\.COMPANY_NAME\] <1>\s*\n([^\n]+)/);
      const designerMatch = content.match(/\[\.\.DESIGNER_NAME\] <1>\s*\n([^\n]+)/);

      const summary = {
        title: titleMatch ? clean(titleMatch[1]) : "Unknown",
        company: companyMatch ? clean(companyMatch[1]) : "Unknown",
        designer: designerMatch ? clean(designerMatch[1]) : "Unknown",
        nodeCount: nodeMatch ? parseInt(nodeMatch[1]) : 0,
        memberCount: memberMatch ? parseInt(memberMatch[1]) : 0,
        plateCount: plateMatch ? parseInt(plateMatch[1]) : 0,
        fileSizeKB: Math.round(fs.statSync(filePath).size / 1024)
      };

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error reading file: ${err.message}` }]
      };
    }
  }
);

// Tool 2: List members - summary mode by default, full detail on request
// mode: "summary" (default) returns type breakdown only (~50 tokens)
// mode: "full" returns every member as CSV (~varies, use filterType to reduce)
// filterType: optional e.g. "Tube", "Wide Flange", "Channel", "Angle", "None"
server.tool(
  "list_members",
  {
    filePath: z.string().describe("Full path to the .r3d file"),
    mode: z.enum(["summary", "full"]).optional().default("summary")
      .describe("summary (default) = type breakdown only; full = every member as CSV"),
    filterType: z.string().optional()
      .describe("Optional: filter full mode by type e.g. Tube, Wide Flange, Channel, Angle, None")
  },
  async ({ filePath, mode = "summary", filterType }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const nodesOrdered = parseNodesOrdered(content);

      if (nodesOrdered.length === 0) {
        return { content: [{ type: "text", text: "No nodes found - cannot resolve member connectivity." }] };
      }

      const members = parseMembersResolved(content, nodesOrdered);
      if (members.length === 0) {
        return { content: [{ type: "text", text: "No members found in this file." }] };
      }

      // ---- SUMMARY MODE (default, token-efficient) ----
      if (mode === "summary") {
        const typeCounts = {};
        const unassigned = [];
        members.forEach(m => {
          const t = m.type || "Unknown";
          typeCounts[t] = (typeCounts[t] || 0) + 1;
          if (!m.size || m.size === "None" || m.size === "") unassigned.push(m.label);
        });
        const breakdown = Object.entries(typeCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([t, c]) => `${c} ${t}`)
          .join(", ");
        const lines = [
          `${members.length} members total: ${breakdown}.`,
          unassigned.length > 0
            ? `⚠ ${unassigned.length} member(s) with no section assigned: ${unassigned.join(", ")}`
            : "All members have section assignments.",
          `For full detail, call list_members with mode="full" (optionally add filterType e.g. "Tube").`
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ---- FULL MODE (detailed, CSV) ----
      let filtered = members;
      if (filterType) {
        const ft = filterType.toLowerCase();
        filtered = members.filter(m => m.type.toLowerCase().includes(ft));
        if (filtered.length === 0) {
          return { content: [{ type: "text", text: `No members found with type matching "${filterType}". Available types: ${[...new Set(members.map(m => m.type))].join(", ")}` }] };
        }
      }

      const rows = ["Label,Type,Size,iNode,jNode"];
      filtered.forEach(m => {
        rows.push(`${m.label},${m.type},${m.size},${m.iNode || "?"},${m.jNode || "?"}`);
      });

      const header = filterType
        ? `${filtered.length} of ${members.length} members (filtered by type "${filterType}"):`
        : `All ${filtered.length} members:`;

      return {
        content: [{ type: "text", text: `${header}\n\n` + rows.join("\n") }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// Tool 3: List all nodes
server.tool(
  "list_nodes",
  { filePath: z.string().describe("Full path to the .r3d file") },
  async ({ filePath }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const nodes = parseNodesOrdered(content);

      if (nodes.length === 0) {
        return { content: [{ type: "text", text: "No nodes found in this file." }] };
      }

      return {
        content: [{
          type: "text",
          text: `Found ${nodes.length} nodes:\n` + JSON.stringify(nodes, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// Tool 4: List load combinations
server.tool(
  "list_load_combinations",
  { filePath: z.string().describe("Full path to the .r3d file") },
  async ({ filePath }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");

      const lcMatch = content.match(/\[LOAD_COMBINATIONS\] <\d+>([\s\S]*?)\[END_LOAD_COMBINATIONS\]/);
      if (!lcMatch) {
        return { content: [{ type: "text", text: "No load combinations found in this file." }] };
      }

      const lcLines = lcMatch[1].trim().split("\n").filter(l => l.trim());
      const labels = lcLines.map(line => clean(tokenize(line)[0]));

      return {
        content: [{
          type: "text",
          text: `Found ${labels.length} load combinations:\n` + labels.join("\n")
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// Tool 5: Get raw section of the file
server.tool(
  "get_file_section",
  {
    filePath: z.string().describe("Full path to the .r3d file"),
    sectionName: z.string().describe("Section keyword e.g. NODES, MEMBERS, MATERIAL_PROPERTIES")
  },
  async ({ filePath, sectionName }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const regex = new RegExp(`\\[\\.?${sectionName}\\][\\s\\S]*?\\[\\.?END_${sectionName}\\]`);
      const match = content.match(regex);

      if (!match) {
        return { content: [{ type: "text", text: `Section [${sectionName}] not found in file.` }] };
      }

      return {
        content: [{ type: "text", text: match[0] }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// Tool 6: Compare two .r3d files
server.tool(
  "compare_risa_models",
  {
    filePath1: z.string().describe("Full path to the first (original) .r3d file"),
    filePath2: z.string().describe("Full path to the second (revised) .r3d file")
  },
  async ({ filePath1, filePath2 }) => {
    try {
      const content1 = fs.readFileSync(filePath1, "utf8");
      const content2 = fs.readFileSync(filePath2, "utf8");

      const report = [];

      const parseLoadCombos = (content) => {
        const match = content.match(/\[LOAD_COMBINATIONS\] <\d+>([\s\S]*?)\[END_LOAD_COMBINATIONS\]/);
        if (!match) return new Set();
        return new Set(match[1].trim().split("\n").filter(l => l.trim()));
      };

      const parseSectionSets = (content) => {
        const sets = {};
        const regex = /\[\.HR_STEEL_SECTION_SETS\] <\d+>([\s\S]*?)\[\.END_HR_STEEL_SECTION_SETS\]/;
        const match = content.match(regex);
        if (match) {
          match[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
            const t = tokenize(line);
            sets[clean(t[0])] = clean(t[2]);
          });
        }
        return sets;
      };

      // ---- NODES ----
      const nodes1 = parseNodesOrdered(content1);
      const nodes2 = parseNodesOrdered(content2);
      const nodeMap1 = {}; nodes1.forEach(n => nodeMap1[n.label] = n);
      const nodeMap2 = {}; nodes2.forEach(n => nodeMap2[n.label] = n);
      const allNodeLabels = new Set([...Object.keys(nodeMap1), ...Object.keys(nodeMap2)]);

      const nodesAdded = [], nodesRemoved = [], nodesMoved = [];
      allNodeLabels.forEach(label => {
        if (!nodeMap1[label]) { nodesAdded.push(label); }
        else if (!nodeMap2[label]) { nodesRemoved.push(label); }
        else {
          const n1 = nodeMap1[label], n2 = nodeMap2[label];
          const dx = Math.abs(n1.x - n2.x), dy = Math.abs(n1.y - n2.y), dz = Math.abs(n1.z - n2.z);
          if (dx > 0.001 || dy > 0.001 || dz > 0.001) {
            nodesMoved.push(`${label}: (${n1.x},${n1.y},${n1.z}) → (${n2.x},${n2.y},${n2.z})`);
          }
        }
      });

      report.push("=== NODE CHANGES ===");
      report.push(`Nodes added: ${nodesAdded.length > 0 ? nodesAdded.join(", ") : "None"}`);
      report.push(`Nodes removed: ${nodesRemoved.length > 0 ? nodesRemoved.join(", ") : "None"}`);
      report.push(`Nodes moved: ${nodesMoved.length > 0 ? nodesMoved.join("\n  ") : "None"}`);

      // ---- MEMBERS ----
      const members1raw = parseMembersResolved(content1, nodes1);
      const members2raw = parseMembersResolved(content2, nodes2);
      const members1 = {}; members1raw.forEach(m => members1[m.label] = m);
      const members2 = {}; members2raw.forEach(m => members2[m.label] = m);
      const allMemberLabels = new Set([...Object.keys(members1), ...Object.keys(members2)]);

      const membersAdded = [], membersRemoved = [], sizeChanged = [], connectivityChanged = [];
      allMemberLabels.forEach(label => {
        if (!members1[label]) { membersAdded.push(label); }
        else if (!members2[label]) { membersRemoved.push(label); }
        else {
          const m1 = members1[label], m2 = members2[label];
          if (m1.size !== m2.size || m1.type !== m2.type) {
            sizeChanged.push(`${label}: ${m1.type}/${m1.size} → ${m2.type}/${m2.size}`);
          }
          if (m1.iNode !== m2.iNode || m1.jNode !== m2.jNode) {
            connectivityChanged.push(`${label}: (${m1.iNode}-${m1.jNode}) → (${m2.iNode}-${m2.jNode})`);
          }
        }
      });

      report.push("\n=== MEMBER CHANGES ===");
      report.push(`Members added: ${membersAdded.length > 0 ? membersAdded.join(", ") : "None"}`);
      report.push(`Members removed: ${membersRemoved.length > 0 ? membersRemoved.join(", ") : "None"}`);
      report.push(`Type/Size changes: ${sizeChanged.length > 0 ? "\n  " + sizeChanged.join("\n  ") : "None"}`);
      report.push(`Connectivity changes: ${connectivityChanged.length > 0 ? "\n  " + connectivityChanged.join("\n  ") : "None"}`);

      // ---- SECTION SETS (best effort) ----
      const sets1 = parseSectionSets(content1);
      const sets2 = parseSectionSets(content2);
      const allSetLabels = new Set([...Object.keys(sets1), ...Object.keys(sets2)]);

      const setsChanged = [];
      allSetLabels.forEach(label => {
        if (sets1[label] && sets2[label] && sets1[label] !== sets2[label]) {
          setsChanged.push(`${label}: ${sets1[label]} → ${sets2[label]}`);
        } else if (!sets1[label]) {
          setsChanged.push(`${label}: ADDED`);
        } else if (!sets2[label]) {
          setsChanged.push(`${label}: REMOVED`);
        }
      });

      report.push("\n=== SECTION SET CHANGES (best effort) ===");
      report.push(setsChanged.length > 0 ? setsChanged.join("\n") : "None");

      // ---- LOAD COMBINATIONS ----
      const lc1 = parseLoadCombos(content1);
      const lc2 = parseLoadCombos(content2);
      const lcAdded = [...lc2].filter(lc => !lc1.has(lc));
      const lcRemoved = [...lc1].filter(lc => !lc2.has(lc));

      report.push("\n=== LOAD COMBINATION CHANGES ===");
      report.push(`Added: ${lcAdded.length} combination(s)`);
      report.push(`Removed: ${lcRemoved.length} combination(s)`);

      const totalChanges = nodesAdded.length + nodesRemoved.length + nodesMoved.length +
        membersAdded.length + membersRemoved.length + sizeChanged.length + connectivityChanged.length +
        setsChanged.length + lcAdded.length + lcRemoved.length;

      report.unshift(`RISA-3D Model Comparison\nFile 1: ${filePath1}\nFile 2: ${filePath2}\nTotal changes detected: ${totalChanges}\n`);

      return {
        content: [{ type: "text", text: report.join("\n") }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error comparing files: ${err.message}` }]
      };
    }
  }
);

// Tool 7: Export member schedule as CSV
// filterType: optional e.g. "Tube", "Wide Flange" - reduces output for large models
// maxRows: optional cap (default 200) - prevents runaway token usage on huge models
server.tool(
  "export_member_schedule",
  {
    filePath: z.string().describe("Full path to the .r3d file"),
    filterType: z.string().optional()
      .describe("Optional: only include members of this type e.g. Tube, Wide Flange, Channel"),
    maxRows: z.number().optional().default(200)
      .describe("Max members to return (default 200). Use filterType to narrow results instead of raising this.")
  },
  async ({ filePath, filterType, maxRows = 200 }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const nodesOrdered = parseNodesOrdered(content);

      if (nodesOrdered.length === 0) {
        return { content: [{ type: "text", text: "No nodes found - cannot calculate member lengths." }] };
      }

      const members = parseMembersResolved(content, nodesOrdered);
      if (members.length === 0) {
        return { content: [{ type: "text", text: "No members found in this file." }] };
      }

      // Apply type filter if provided
      let filtered = members;
      if (filterType) {
        const ft = filterType.toLowerCase();
        filtered = members.filter(m => m.type.toLowerCase().includes(ft));
        if (filtered.length === 0) {
          return { content: [{ type: "text", text: `No members found with type matching "${filterType}". Available types: ${[...new Set(members.map(m => m.type))].join(", ")}` }] };
        }
      }

      // Apply row cap
      const capped = filtered.length > maxRows;
      const toExport = capped ? filtered.slice(0, maxRows) : filtered;

      const rows = ["Label,Type,Size,iNode,jNode,Length(ft)"];
      toExport.forEach(m => {
        const len = distance3D(m.iCoord, m.jCoord);
        const lengthStr = len !== null ? len.toFixed(2) : "N/A";
        rows.push(`${m.label},${m.type},${m.size},${m.iNode || "?"},${m.jNode || "?"},${lengthStr}`);
      });

      const header = [
        filterType
          ? `Member Schedule — ${toExport.length} of ${members.length} members (filtered: "${filterType}")`
          : `Member Schedule — ${toExport.length} of ${members.length} members`,
        capped ? `⚠ Showing first ${maxRows} of ${filtered.length}. Use filterType to narrow results.` : null,
        `Copy/paste CSV below into Excel (Data → Text to Columns, comma delimiter):`
      ].filter(Boolean).join("\n");

      return {
        content: [{ type: "text", text: `${header}\n\n` + rows.join("\n") }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// Tool 8: QC checker for common modeling issues
server.tool(
  "qc_check_risa_model",
  { filePath: z.string().describe("Full path to the .r3d file") },
  async ({ filePath }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const issues = [];

      const nodesOrdered = parseNodesOrdered(content);

      // Duplicate node coordinates
      const nodeCoordMap = {};
      nodesOrdered.forEach(n => {
        const key = `${n.x},${n.y},${n.z}`;
        if (!nodeCoordMap[key]) nodeCoordMap[key] = [];
        nodeCoordMap[key].push(n.label);
      });
      const duplicateNodeGroups = Object.entries(nodeCoordMap).filter(([k, labels]) => labels.length > 1);

      issues.push("--- Duplicate Nodes (same coordinates) ---");
      if (duplicateNodeGroups.length > 0) {
        duplicateNodeGroups.forEach(([coords, labels]) => {
          issues.push(`Multiple nodes at (${coords}): ${labels.join(", ")}`);
        });
      } else {
        issues.push("None found.");
      }

      // Members
      const members = parseMembersResolved(content, nodesOrdered);
      const memberLabels = new Set();
      const duplicateMemberLabels = [];
      const missingSize = [];
      const zeroLength = [];
      const invalidNodeRefs = [];

      members.forEach(m => {
        if (memberLabels.has(m.label)) duplicateMemberLabels.push(m.label);
        memberLabels.add(m.label);

        if (!m.size) missingSize.push(m.label);

        if (!m.iNode) invalidNodeRefs.push(`${m.label}: i-node index ${m.iNodeIndex} is out of range (model has ${nodesOrdered.length} nodes)`);
        if (!m.jNode) invalidNodeRefs.push(`${m.label}: j-node index ${m.jNodeIndex} is out of range (model has ${nodesOrdered.length} nodes)`);

        if (m.iNode && m.jNode) {
          const len = distance3D(m.iCoord, m.jCoord);
          if (len !== null && len < 0.001) {
            zeroLength.push(`${m.label} (${m.iNode} = ${m.jNode})`);
          }
        }
      });

      issues.push("\n--- Duplicate Member Labels ---");
      issues.push(duplicateMemberLabels.length > 0 ? duplicateMemberLabels.join(", ") : "None found.");

      issues.push("\n--- Members With No Section Size Assigned ---");
      issues.push(missingSize.length > 0 ? missingSize.join(", ") : "None found.");

      issues.push("\n--- Zero-Length Members ---");
      issues.push(zeroLength.length > 0 ? zeroLength.join(", ") : "None found.");

      issues.push("\n--- Members Referencing Invalid Node Indices ---");
      issues.push(invalidNodeRefs.length > 0 ? invalidNodeRefs.join("\n") : "None found.");

      return {
        content: [{
          type: "text",
          text: `QC Check Report\nFile: ${filePath}\nNodes: ${nodesOrdered.length}, Members: ${members.length}\n\n` + issues.join("\n")
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);


// Tool 9: Get steel materials defined in the model
server.tool(
  "get_model_materials",
  { filePath: z.string().describe("Full path to the .r3d file") },
  async ({ filePath }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");

      // Focus on HR steel materials (most relevant for misc steel work)
      // Format: Label, E, G, Nu, Alpha, Weight, Fy, -1, Ry, Fu, Rt
      const hrMatch = content.match(/\[\.HR_STEEL_MATERIAL\] <\d+>([\s\S]*?)\[\.END_HR_STEEL_MATERIAL\]/);
      const cfMatch = content.match(/\[\.CF_STEEL_MATERIAL\] <\d+>([\s\S]*?)\[\.END_CF_STEEL_MATERIAL\]/);

      const rows = ["Type,Grade,E(ksi),Fy(ksi),Fu(ksi)"];

      if (hrMatch) {
        hrMatch[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
          const t = tokenize(line);
          const label = clean(t[0]);
          const E = parseFloat(t[1]);
          const Fy = parseFloat(t[6]);
          const Fu = parseFloat(t[9]);
          rows.push(`HR Steel,${label},${E},${Fy},${Fu}`);
        });
      }

      if (cfMatch) {
        cfMatch[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
          const t = tokenize(line);
          const label = clean(t[0]);
          const E = parseFloat(t[1]);
          const Fy = parseFloat(t[6]);
          const Fu = parseFloat(t[7]);
          rows.push(`CF Steel,${label},${E},${Fy},${Fu}`);
        });
      }

      if (rows.length === 1) {
        return { content: [{ type: "text", text: "No steel materials found in this model." }] };
      }

      return {
        content: [{ type: "text", text: `Steel materials defined in model (${rows.length - 1} total):\n\n` + rows.join("\n") }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Tool 10: Get boundary conditions (support conditions at nodes)
// RISA boundary condition codes: 4=Fixed, 0=Free, 1=Spring, 2=Slave, 3=Reaction
// Format: nodeIndex, X, Y, Z, rotX, rotY, rotZ, ...
server.tool(
  "get_boundary_conditions",
  { filePath: z.string().describe("Full path to the .r3d file") },
  async ({ filePath }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const nodesOrdered = parseNodesOrdered(content);

      const bcMatch = content.match(/\[BOUNDARY_CONDITIONS\] <\d+>([\s\S]*?)\[END_BOUNDARY_CONDITIONS\]/);
      if (!bcMatch) {
        return { content: [{ type: "text", text: "No boundary conditions found in this model." }] };
      }

      const codeLabel = (c) => {
        const n = parseInt(c);
        if (n === 4) return "Fixed";
        if (n === 0) return "Free";
        if (n === 1) return "Spring";
        if (n === 2) return "Slave";
        if (n === 3) return "Reaction";
        return `Code${n}`;
      };

      const rows = ["NodeIndex,NodeLabel,X,Y,Z,RotX,RotY,RotZ,Description"];
      bcMatch[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
        const parts = line.trim().split(/\s+/);
        const nodeIdx = parseInt(parts[0]);
        const nodeLabel = nodesOrdered[nodeIdx - 1] ? nodesOrdered[nodeIdx - 1].label : `(index ${nodeIdx})`;
        const x = codeLabel(parts[1]);
        const y = codeLabel(parts[2]);
        const z = codeLabel(parts[3]);
        const rx = codeLabel(parts[4]);
        const ry = codeLabel(parts[5]);
        const rz = codeLabel(parts[6]);

        // Human-readable description
        const allFixed = [x,y,z,rx,ry,rz].every(v => v === "Fixed");
        const allFree = [x,y,z,rx,ry,rz].every(v => v === "Free");
        const transFixed = [x,y,z].every(v => v === "Fixed");
        const rotFree = [rx,ry,rz].every(v => v === "Free");

        let desc = "";
        if (allFixed) desc = "Fixed";
        else if (allFree) desc = "Free";
        else if (transFixed && rotFree) desc = "Pinned";
        else if (x==="Fixed" && y==="Fixed" && z==="Fixed" && rx==="Free" && ry==="Free" && rz==="Fixed") desc = "Fixed-Z";
        else desc = `${x}/${y}/${z} | ${rx}/${ry}/${rz}`;

        rows.push(`${nodeIdx},${nodeLabel},${x},${y},${z},${rx},${ry},${rz},${desc}`);
      });

      return {
        content: [{ type: "text", text: `Boundary conditions (${rows.length - 1} constrained nodes):\n\n` + rows.join("\n") }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Tool 11: Get section sets and their assigned sizes
// Format: Label, Type, Size, ...
server.tool(
  "get_section_sets",
  { filePath: z.string().describe("Full path to the .r3d file") },
  async ({ filePath }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");

      const match = content.match(/\[\.HR_STEEL_SECTION_SETS\] <\d+>([\s\S]*?)\[\.END_HR_STEEL_SECTION_SETS\]/);
      if (!match) {
        return { content: [{ type: "text", text: "No hot-rolled steel section sets found in this model." }] };
      }

      const rows = ["SetName,Type,Size"];
      match[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
        const t = tokenize(line);
        rows.push(`${clean(t[0])},${clean(t[1])},${clean(t[2])}`);
      });

      return {
        content: [{ type: "text", text: `Section sets (${rows.length - 1} total):\n\n` + rows.join("\n") }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Tool 12: Summarize model for report/calculation package
// Single call replacing 6+ separate tool calls.
// Sections covered: project info, nodes, members, section sets, materials,
// boundary conditions, load combos, area loads, distributed loads, point loads.
// NOTE: Load case indices in load sections (e.g. 86, 88, 89, 90) are internal
// RISA IDs. This tool builds a map from BASIC_LOAD_CASES (user-visible names)
// and attempts to match — unmatched IDs are shown as LC{n}.
server.tool(
  "summarize_model_for_report",
  { filePath: z.string().describe("Full path to the .r3d file") },
  async ({ filePath }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const report = [];

      // ---- PROJECT INFO ----
      const titleMatch = content.match(/\[\.\.MODEL_TITLE\] <1>\s*\n([^\n]+)/);
      const companyMatch = content.match(/\[\.\.COMPANY_NAME\] <1>\s*\n([^\n]+)/);
      const designerMatch = content.match(/\[\.\.DESIGNER_NAME\] <1>\s*\n([^\n]+)/);
      report.push("=== PROJECT ===");
      report.push(`Title: ${titleMatch ? clean(titleMatch[1]) : "Unknown"}`);
      report.push(`Company: ${companyMatch ? clean(companyMatch[1]) : "Unknown"}`);
      report.push(`Designer: ${designerMatch ? clean(designerMatch[1]) : "Unknown"}`);

      // ---- NODES ----
      const nodesOrdered = parseNodesOrdered(content);
      report.push(`\n=== NODES (${nodesOrdered.length} total) ===`);
      const nodeCSV = ["Label,X,Y,Z"];
      nodesOrdered.forEach(n => nodeCSV.push(`${n.label},${n.x},${n.y},${n.z}`));
      report.push(nodeCSV.join("\n"));

      // ---- MEMBERS ----
      const members = parseMembersResolved(content, nodesOrdered);
      const typeCounts = {};
      members.forEach(m => { typeCounts[m.type] = (typeCounts[m.type] || 0) + 1; });
      const breakdown = Object.entries(typeCounts).sort((a,b) => b[1]-a[1]).map(([t,c]) => `${c} ${t}`).join(", ");
      report.push(`\n=== MEMBERS (${members.length} total: ${breakdown}) ===`);
      const memberCSV = ["Label,Type,Size,iNode,jNode,Length(ft)"];
      members.forEach(m => {
        const len = distance3D(m.iCoord, m.jCoord);
        memberCSV.push(`${m.label},${m.type},${m.size},${m.iNode||"?"},${m.jNode||"?"},${len!==null?len.toFixed(2):"N/A"}`);
      });
      report.push(memberCSV.join("\n"));

      // ---- SECTION SETS ----
      const setsMatch = content.match(/\[\.HR_STEEL_SECTION_SETS\] <\d+>([\s\S]*?)\[\.END_HR_STEEL_SECTION_SETS\]/);
      report.push(`\n=== SECTION SETS ===`);
      if (setsMatch) {
        report.push("SetName,Type,Size");
        setsMatch[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
          const t = tokenize(line);
          report.push(`${clean(t[0])},${clean(t[1])},${clean(t[2])}`);
        });
      } else { report.push("None found."); }

      // ---- STEEL MATERIALS ----
      const hrMatch = content.match(/\[\.HR_STEEL_MATERIAL\] <\d+>([\s\S]*?)\[\.END_HR_STEEL_MATERIAL\]/);
      report.push(`\n=== STEEL MATERIALS ===`);
      if (hrMatch) {
        report.push("Grade,E(ksi),Fy(ksi),Fu(ksi)");
        hrMatch[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
          const t = tokenize(line);
          report.push(`${clean(t[0])},${parseFloat(t[1])},${parseFloat(t[6])},${parseFloat(t[9])}`);
        });
      } else { report.push("None found."); }

      // ---- BOUNDARY CONDITIONS ----
      const bcMatch = content.match(/\[BOUNDARY_CONDITIONS\] <\d+>([\s\S]*?)\[END_BOUNDARY_CONDITIONS\]/);
      report.push(`\n=== BOUNDARY CONDITIONS ===`);
      if (bcMatch) {
        const codeLabel = c => ({4:"Fixed",0:"Free",1:"Spring",2:"Slave",3:"Reaction"}[parseInt(c)] || `Code${c}`);
        report.push("NodeLabel,X,Y,Z,RotX,RotY,RotZ,Description");
        bcMatch[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
          const parts = line.trim().split(/\s+/);
          const nodeIdx = parseInt(parts[0]);
          const nodeLabel = nodesOrdered[nodeIdx-1] ? nodesOrdered[nodeIdx-1].label : `(idx ${nodeIdx})`;
          const x=codeLabel(parts[1]),y=codeLabel(parts[2]),z=codeLabel(parts[3]);
          const rx=codeLabel(parts[4]),ry=codeLabel(parts[5]),rz=codeLabel(parts[6]);
          const allFixed = [x,y,z,rx,ry,rz].every(v=>v==="Fixed");
          const transFixed = [x,y,z].every(v=>v==="Fixed");
          const rotFree = [rx,ry,rz].every(v=>v==="Free");
          const desc = allFixed ? "Fixed" : (transFixed&&rotFree ? "Pinned" : `${x}/${y}/${z}|${rx}/${ry}/${rz}`);
          report.push(`${nodeLabel},${x},${y},${z},${rx},${ry},${rz},${desc}`);
        });
      } else { report.push("None found."); }

      // ---- LOAD COMBINATIONS ----
      const lcMatch = content.match(/\[LOAD_COMBINATIONS\] <\d+>([\s\S]*?)\[END_LOAD_COMBINATIONS\]/);
      report.push(`\n=== LOAD COMBINATIONS ===`);
      if (lcMatch) {
        const lcLines = lcMatch[1].trim().split("\n").filter(l => l.trim());
        const lcNames = lcLines.map(line => clean(tokenize(line)[0])).filter(n => n);
        report.push(`Total: ${lcNames.length}`);
        report.push(lcNames.join("\n"));
      } else { report.push("None found."); }

      // ---- BASIC LOAD CASES (for resolving internal load case IDs) ----
      // Format: index "Name" ...
      const blcMatch = content.match(/\[BASIC_LOAD_CASES\] <\d+>([\s\S]*?)\[END_BASIC_LOAD_CASES\]/);
      const blcMap = {}; // 1-based index -> name
      if (blcMatch) {
        blcMatch[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
          const t = tokenize(line);
          const idx = parseInt(t[0]);
          const name = clean(t[1]);
          if (!isNaN(idx) && name) blcMap[idx] = name;
        });
      }
      const lcName = (idx) => blcMap[idx] ? blcMap[idx] : `LC${idx}`;

      // ---- AREA LOADS ----
      // Format: n1 n2 n3 n4 lcIdx direction magnitude ...
      // direction: 1=Y(gravity down), 2=Z, 3=X
      const areaMatch = content.match(/\[AREA_LOADS\] <\d+>([\s\S]*?)\[END_AREA_LOADS\]/);
      report.push(`\n=== AREA LOADS ===`);
      if (areaMatch) {
        const areaLines = areaMatch[1].trim().split("\n").filter(l => l.trim());
        report.push("Corners(N1-N2-N3-N4),LoadCase,Direction,Magnitude(ksf)");
        areaLines.forEach(line => {
          const parts = line.trim().replace(";","").split(/\s+/);
          const corners = [0,1,2,3].map(i => {
            const n = nodesOrdered[parseInt(parts[i])-1];
            return n ? n.label : `(idx ${parts[i]})`;
          }).join("-");
          const lc = lcName(parseInt(parts[4]));
          const dirCode = parseInt(parts[5]);
          const dir = dirCode === 1 ? "Y(gravity)" : dirCode === 2 ? "Z" : dirCode === 3 ? "X" : `Dir${dirCode}`;
          const mag = parseFloat(parts[6]);
          report.push(`${corners},${lc},${dir},${mag}`);
        });
      } else { report.push("None found."); }

      // ---- MEMBER DISTRIBUTED LOADS ----
      // Format: memberIdx lcIdx startMag endMag startLoc endLoc direction ...
      // memberIdx is 1-based positional index into members list
      const distMatch = content.match(/\[DIRECT_DISTRIBUTED_LOADS\] <\d+>([\s\S]*?)\[END_DIRECT_DISTRIBUTED_LOADS\]/);
      report.push(`\n=== MEMBER DISTRIBUTED LOADS ===`);
      if (distMatch) {
        const distLines = distMatch[1].trim().split("\n").filter(l => l.trim());
        report.push("Member,LoadCase,StartMag(k/ft),EndMag(k/ft),StartLoc(ft),EndLoc(ft)");
        distLines.forEach(line => {
          const parts = line.trim().replace(";","").split(/\s+/);
          const mIdx = parseInt(parts[0]);
          const member = members[mIdx-1];
          const mLabel = member ? member.label : `(idx ${mIdx})`;
          const lc = lcName(parseInt(parts[1]));
          const startMag = parseFloat(parts[2]);
          const endMag = parseFloat(parts[3]);
          const startLoc = parseFloat(parts[4]);
          const endLoc = parseFloat(parts[5]);
          report.push(`${mLabel},${lc},${startMag},${endMag},${startLoc},${endLoc}`);
        });
      } else { report.push("None found."); }

      // ---- POINT / NODE LOADS ----
      // Format: nodeIdx lcIdx magnitude direction ...
      // direction code 76 = appears to be a combined direction flag in RISA
      const ptMatch = content.match(/\[NODE_LOADS\] <\d+>([\s\S]*?)\[END_NODE_LOADS\]/);
      report.push(`\n=== POINT LOADS (NODE LOADS) ===`);
      if (ptMatch) {
        const ptLines = ptMatch[1].trim().split("\n").filter(l => l.trim());
        report.push("NodeLabel,LoadCase,Magnitude(k),DirectionCode");
        ptLines.forEach(line => {
          const parts = line.trim().replace(";","").split(/\s+/);
          const nIdx = parseInt(parts[0]);
          const nodeLabel = nodesOrdered[nIdx-1] ? nodesOrdered[nIdx-1].label : `(idx ${nIdx})`;
          const lc = lcName(parseInt(parts[1]));
          const mag = parseFloat(parts[2]);
          const dir = parts[3]; // direction code (76 = X in RISA seismic convention)
          report.push(`${nodeLabel},${lc},${mag},Dir${dir}`);
        });
      } else { report.push("None found."); }

      return {
        content: [{ type: "text", text: `MODEL REPORT\nFile: ${filePath}\n\n` + report.join("\n") }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);


// Tool 13: Batch summarize all .r3d files in a folder
// Returns a CSV table with one row per model -- useful for project-wide QC
// and reporting across multiple stair/platform models in a project folder.
// Optional: filterName -- only include files whose name contains this string
server.tool(
  "batch_summarize_folder",
  {
    folderPath: z.string().describe("Full path to the folder containing .r3d files"),
    filterName: z.string().optional()
      .describe("Optional: only include files whose name contains this string (case-insensitive)")
  },
  async ({ folderPath, filterName }) => {
    try {
      // Read folder contents
      let files;
      try {
        files = fs.readdirSync(folderPath);
      } catch (e) {
        return { content: [{ type: "text", text: `Cannot read folder: ${e.message}` }] };
      }

      // Filter to .r3d files only, apply optional name filter
      let r3dFiles = files.filter(f => f.toLowerCase().endsWith(".r3d"));
      if (filterName) {
        r3dFiles = r3dFiles.filter(f => f.toLowerCase().includes(filterName.toLowerCase()));
      }

      if (r3dFiles.length === 0) {
        const msg = filterName
          ? `No .r3d files found in folder matching "${filterName}".`
          : `No .r3d files found in folder: ${folderPath}`;
        return { content: [{ type: "text", text: msg }] };
      }

      // CSV header
      const rows = ["FileName,Title,Designer,Nodes,Members,SectionSets,LoadCombos,FileSizeKB,QCIssues"];

      let errorCount = 0;

      for (const fileName of r3dFiles) {
        const filePath = folderPath.replace(/[\/]+$/, "") + "\\" + fileName;
        try {
          const content = fs.readFileSync(filePath, "utf8");

          // Project info
          const titleMatch = content.match(/\[\.\.MODEL_TITLE\] <1>\s*\n([^\n]+)/);
          const designerMatch = content.match(/\[\.\.DESIGNER_NAME\] <1>\s*\n([^\n]+)/);
          const title = titleMatch ? clean(titleMatch[1]) : "";
          const designer = designerMatch ? clean(designerMatch[1]) : "";

          // Counts from section headers
          const nodeMatch = content.match(/\[NODES\] <(\d+)>/);
          const memberMatch = content.match(/\[MEMBERS_MAIN_DATA\] <(\d+)>/);
          const setsMatch = content.match(/\[\.HR_STEEL_SECTION_SETS\] <(\d+)>/);
          const lcMatch = content.match(/\[LOAD_COMBINATIONS\] <(\d+)>/);

          const nodeCount = nodeMatch ? parseInt(nodeMatch[1]) : 0;
          const memberCount = memberMatch ? parseInt(memberMatch[1]) : 0;
          const setsCount = setsMatch ? parseInt(setsMatch[1]) : 0;
          const lcCount = lcMatch ? parseInt(lcMatch[1]) : 0;
          const fileSizeKB = Math.round(fs.statSync(filePath).size / 1024);

          // Quick QC -- check for unassigned members
          const nodesOrdered = parseNodesOrdered(content);
          const members = parseMembersResolved(content, nodesOrdered);
          const unassigned = members.filter(m => !m.size || m.size === "None" || m.size === "").length;
          const invalidRefs = members.filter(m => !m.iNode || !m.jNode).length;
          const qcIssues = [];
          if (unassigned > 0) qcIssues.push(`${unassigned} unassigned sections`);
          if (invalidRefs > 0) qcIssues.push(`${invalidRefs} invalid node refs`);
          const qcSummary = qcIssues.length > 0 ? qcIssues.join("; ") : "OK";

          // Escape commas in text fields
          const esc = (s) => s.includes(",") ? `"${s}"` : s;
          rows.push(`${esc(fileName)},${esc(title)},${esc(designer)},${nodeCount},${memberCount},${setsCount},${lcCount},${fileSizeKB},${esc(qcSummary)}`);

        } catch (fileErr) {
          rows.push(`${fileName},ERROR,,,,,,,"${fileErr.message.replace(/"/g, "'")}"`);
          errorCount++;
        }
      }

      const summary = [
        `Folder: ${folderPath}`,
        `Models found: ${r3dFiles.length}${filterName ? ` (filtered by "${filterName}")` : ""}`,
        errorCount > 0 ? `Files with errors: ${errorCount}` : null,
        ``,
        rows.join("\n")
      ].filter(l => l !== null).join("\n");

      return { content: [{ type: "text", text: summary }] };

    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);


// Tool 14: Get basic load cases
// Returns index, name, and load type for each basic load case defined in the model.
// Load type codes: 0=Gravity, 14=Seismic, others=Wind/Notional/Transient
server.tool(
  "get_load_cases",
  { filePath: z.string().describe("Full path to the .r3d file") },
  async ({ filePath }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");

      const blcMatch = content.match(/\[BASIC_LOAD_CASES\] <\d+>([\s\S]*?)\[END_BASIC_LOAD_CASES\]/);
      if (!blcMatch) {
        return { content: [{ type: "text", text: "No basic load cases found in this model." }] };
      }

      // Load type code -> human readable
      const typeLabel = (code) => {
        const n = parseInt(code);
        if (n === 0) return "Gravity";
        if (n === 14) return "Seismic";
        if (n === 1 || n === 2) return "Wind";
        if (n === 3) return "Notional";
        return `Type${n}`;
      };

      const rows = ["Index,Name,LoadType"];
      blcMatch[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
        const t = tokenize(line);
        const idx = t[0];
        const name = clean(t[1]);
        // Field 3 (t[2]) is the primary load type code
        const ltype = typeLabel(t[2]);
        rows.push(`${idx},${name},${ltype}`);
      });

      return {
        content: [{
          type: "text",
          text: `Basic load cases (${rows.length - 1} total):\n\n` + rows.join("\n")
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Tool 15: Find members by section size
// Returns all members assigned a specific section size (e.g. "HSS8X8X10", "C15X33.9")
// Case-insensitive partial match -- "hss8" will match "HSS8X8X10"
server.tool(
  "find_members_by_section",
  {
    filePath: z.string().describe("Full path to the .r3d file"),
    sectionSize: z.string().describe("Section size to search for e.g. HSS8X8X10, W14X22, C15X33.9. Partial match accepted.")
  },
  async ({ filePath, sectionSize }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const nodesOrdered = parseNodesOrdered(content);
      const members = parseMembersResolved(content, nodesOrdered);

      if (members.length === 0) {
        return { content: [{ type: "text", text: "No members found in this model." }] };
      }

      const query = sectionSize.toLowerCase();
      const matched = members.filter(m => m.size.toLowerCase().includes(query));

      if (matched.length === 0) {
        const allSizes = [...new Set(members.map(m => m.size))].sort().join(", ");
        return {
          content: [{
            type: "text",
            text: `No members found with section matching "${sectionSize}".\nSizes in this model: ${allSizes}`
          }]
        };
      }

      const rows = ["Label,Type,Size,iNode,jNode,Length(ft)"];
      matched.forEach(m => {
        const len = distance3D(m.iCoord, m.jCoord);
        rows.push(`${m.label},${m.type},${m.size},${m.iNode||"?"},${m.jNode||"?"},${len!==null?len.toFixed(2):"N/A"}`);
      });

      return {
        content: [{
          type: "text",
          text: `${matched.length} of ${members.length} members use section matching "${sectionSize}":\n\n` + rows.join("\n")
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Tool 16: Get deflection limits
// Returns the deflection rules (L/n ratios) defined in the model.
// -1 means "not checked" for that category.
// Two rule sets: global DEFLECTION_RULES and per-member MEMBER_DEFLECTION_RULES
server.tool(
  "get_deflection_limits",
  { filePath: z.string().describe("Full path to the .r3d file") },
  async ({ filePath }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const report = [];

      // Field order for both rule types:
      // Name, DL_limit, LL_limit, TL_limit, LL_cantilever, TL_cantilever, DL_cantilever, ...
      const parseRule = (line) => {
        const t = tokenize(line);
        const name = clean(t[0]);
        const fmt = (v) => parseFloat(v) < 0 ? "Not checked" : `L/${parseFloat(v).toFixed(0)}`;
        return {
          name,
          dl: fmt(t[1]),
          ll: fmt(t[2]),
          tl: fmt(t[3]),
          ll_cant: fmt(t[4]),
          tl_cant: fmt(t[5]),
          dl_cant: fmt(t[6])
        };
      };

      // Global deflection rules
      const globalMatch = content.match(/\[\.DEFLECTION_RULES\] <\d+>([\s\S]*?)\[\.END_DEFLECTION_RULES\]/);
      report.push("=== GLOBAL DEFLECTION RULES ===");
      report.push("Rule,DL,LL,TL,LL(Cantilever),TL(Cantilever),DL(Cantilever)");
      if (globalMatch) {
        globalMatch[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
          const r = parseRule(line);
          report.push(`${r.name},${r.dl},${r.ll},${r.tl},${r.ll_cant},${r.tl_cant},${r.dl_cant}`);
        });
      } else {
        report.push("None found.");
      }

      // Member-level deflection rules
      const memberMatch = content.match(/\[\.MEMBER_DEFLECTION_RULES\] <\d+>([\s\S]*?)\[\.END_MEMBER_DEFLECTION_RULES\]/);
      report.push("\n=== MEMBER DEFLECTION RULES ===");
      report.push("Rule,DL,LL,TL,LL(Cantilever),TL(Cantilever),DL(Cantilever)");
      if (memberMatch) {
        memberMatch[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
          const r = parseRule(line);
          report.push(`${r.name},${r.dl},${r.ll},${r.tl},${r.ll_cant},${r.tl_cant},${r.dl_cant}`);
        });
      } else {
        report.push("None found.");
      }

      return {
        content: [{ type: "text", text: report.join("\n") }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);


// Helper: pad a string to exactly 32 chars for RISA's fixed-width quoted fields
function padRISA(str, width = 32) {
  if (str.length >= width) return str.slice(0, width);
  return str + " ".repeat(width - str.length);
}

// Helper: replace a quoted 32-char field value in a line
// Replaces "oldVal<padding>" with "newVal<padding>" -- exact width preserved
function replaceQuotedField(line, oldVal, newVal) {
  const oldPadded = `"${padRISA(oldVal)}"`;
  const newPadded = `"${padRISA(newVal)}"`;
  return line.split(oldPadded).join(newPadded);
}

// Tool 17: modify_section_set
// Changes a section size in a RISA-3D model and saves as a NEW file.
// Mode "set" changes the section set definition (affects all members using that set).
// Mode "member" changes a specific member's size directly.
// Mode "both" does both.
// NEVER overwrites the original file.
server.tool(
  "modify_section_set",
  {
    filePath: z.string().describe("Full path to the source .r3d file"),
    outputPath: z.string().describe("Full path for the new .r3d file to save (must be different from source)"),
    oldSize: z.string().describe("Current section size to replace e.g. HSS8X8X10"),
    newSize: z.string().describe("New section size e.g. HSS8X8X5"),
    mode: z.enum(["set", "member", "both"]).default("both")
      .describe("set = change section set definition only; member = change member assignments only; both = change both"),
    setName: z.string().optional()
      .describe("Optional: only change the section set with this exact name. If omitted, changes all sets using oldSize."),
    memberLabel: z.string().optional()
      .describe("Optional: only change the member with this exact label (e.g. M4). If omitted, changes all members using oldSize.")
  },
  async ({ filePath, outputPath, oldSize, newSize, mode, setName, memberLabel }) => {
    try {
      // Safety check -- never overwrite the original
      if (filePath.toLowerCase() === outputPath.toLowerCase()) {
        return { content: [{ type: "text", text: "Error: outputPath must be different from filePath. This tool never overwrites the original file." }] };
      }

      let fileContent = fs.readFileSync(filePath, "utf8");
      const report = [];
      let setsChanged = 0;
      let membersChanged = 0;

      // --- SECTION SETS ---
      if (mode === "set" || mode === "both") {
        const setsMatch = fileContent.match(/(\[\.HR_STEEL_SECTION_SETS\] <\d+>)([\s\S]*?)(\[\.END_HR_STEEL_SECTION_SETS\])/);
        if (setsMatch) {
          const setsBlock = setsMatch[2];
          const newSetsBlock = setsBlock.split("\n").map(line => {
            if (!line.trim()) return line;
            const t = tokenize(line);
            if (!t || t.length < 3) return line;
            const thisSetName = clean(t[0]);
            const thisSize = clean(t[2]);
            // Apply filter if setName specified
            if (setName && thisSetName !== setName) return line;
            if (thisSize === oldSize) {
              setsChanged++;
              return replaceQuotedField(line, oldSize, newSize);
            }
            return line;
          }).join("\n");
          fileContent = fileContent.replace(setsMatch[2], newSetsBlock);
          report.push(`Section sets changed: ${setsChanged}`);
        } else {
          report.push("No HR_STEEL_SECTION_SETS section found.");
        }
      }

      // --- MEMBERS ---
      if (mode === "member" || mode === "both") {
        const membersMatch = fileContent.match(/(\[\.MEMBERS_MAIN_DATA\] <\d+>)([\s\S]*?)(\[\.END_MEMBERS_MAIN_DATA\])/);
        if (membersMatch) {
          const membersBlock = membersMatch[2];
          const newMembersBlock = membersBlock.split("\n").map(line => {
            if (!line.trim()) return line;
            const t = tokenize(line);
            if (!t || t.length < 3) return line;
            const thisLabel = clean(t[0]);
            const thisSize = clean(t[2]);
            // Apply filter if memberLabel specified
            if (memberLabel && thisLabel !== memberLabel) return line;
            if (thisSize === oldSize) {
              membersChanged++;
              return replaceQuotedField(line, oldSize, newSize);
            }
            return line;
          }).join("\n");
          fileContent = fileContent.replace(membersMatch[2], newMembersBlock);
          report.push(`Members changed: ${membersChanged}`);
        } else {
          report.push("No MEMBERS_MAIN_DATA section found.");
        }
      }

      if (setsChanged === 0 && membersChanged === 0) {
        return {
          content: [{
            type: "text",
            text: `No matches found for section size "${oldSize}". No file was saved.\nCheck the size string matches exactly what's in the model (use get_section_sets or find_members_by_section to confirm).`
          }]
        };
      }

      // Write new file
      fs.writeFileSync(outputPath, fileContent, "utf8");
      report.unshift(`Modified model saved to: ${outputPath}`);
      report.push(`Original unchanged: ${filePath}`);
      report.push(`Change: "${oldSize}" -> "${newSize}"`);

      return { content: [{ type: "text", text: report.join("\n") }] };

    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Tool 18: clone_model_with_changes
// Saves a copy of a .r3d model with one or more changes applied.
// Supported changes: section sizes, boundary conditions, load magnitudes.
// NEVER overwrites the original file.
server.tool(
  "clone_model_with_changes",
  {
    filePath: z.string().describe("Full path to the source .r3d file"),
    outputPath: z.string().describe("Full path for the new .r3d file (must be different from source)"),
    changes: z.object({
      sectionSizes: z.array(z.object({
        oldSize: z.string().describe("Current size e.g. HSS8X8X10"),
        newSize: z.string().describe("Replacement size e.g. HSS8X8X5"),
        scope: z.enum(["set", "member", "both"]).default("both"),
        filterName: z.string().optional().describe("Optional set name or member label to limit the change")
      })).optional().describe("Section size changes to apply"),

      boundaryConditions: z.array(z.object({
        nodeLabel: z.string().describe("Node label e.g. N5"),
        x: z.enum(["Fixed", "Free"]).optional(),
        y: z.enum(["Fixed", "Free"]).optional(),
        z: z.enum(["Fixed", "Free"]).optional(),
        rotX: z.enum(["Fixed", "Free"]).optional(),
        rotY: z.enum(["Fixed", "Free"]).optional(),
        rotZ: z.enum(["Fixed", "Free"]).optional()
      })).optional().describe("Boundary condition changes -- only specified DOFs are changed, others preserved"),

      loadMagnitudes: z.array(z.object({
        memberLabel: z.string().describe("Member label e.g. M41"),
        loadCaseName: z.string().describe("Load case name e.g. DL, LL, ELx"),
        newStartMag: z.number().describe("New start magnitude (k/ft, negative = downward)"),
        newEndMag: z.number().optional().describe("New end magnitude -- defaults to same as newStartMag")
      })).optional().describe("Member distributed load magnitude changes")
    }).describe("Changes to apply to the cloned model")
  },
  async ({ filePath, outputPath, changes }) => {
    try {
      if (filePath.toLowerCase() === outputPath.toLowerCase()) {
        return { content: [{ type: "text", text: "Error: outputPath must be different from filePath. This tool never overwrites the original file." }] };
      }

      let fileContent = fs.readFileSync(filePath, "utf8");
      const report = [];

      // --- SECTION SIZE CHANGES ---
      if (changes.sectionSizes && changes.sectionSizes.length > 0) {
        for (const sc of changes.sectionSizes) {
          let setsChanged = 0;
          let membersChanged = 0;

          if (sc.scope === "set" || sc.scope === "both") {
            const setsMatch = fileContent.match(/(\[\.HR_STEEL_SECTION_SETS\] <\d+>)([\s\S]*?)(\[\.END_HR_STEEL_SECTION_SETS\])/);
            if (setsMatch) {
              const newBlock = setsMatch[2].split("\n").map(line => {
                if (!line.trim()) return line;
                const t = tokenize(line);
                if (!t || t.length < 3) return line;
                if (sc.filterName && clean(t[0]) !== sc.filterName) return line;
                if (clean(t[2]) === sc.oldSize) { setsChanged++; return replaceQuotedField(line, sc.oldSize, sc.newSize); }
                return line;
              }).join("\n");
              fileContent = fileContent.replace(setsMatch[2], newBlock);
            }
          }

          if (sc.scope === "member" || sc.scope === "both") {
            const membersMatch = fileContent.match(/(\[\.MEMBERS_MAIN_DATA\] <\d+>)([\s\S]*?)(\[\.END_MEMBERS_MAIN_DATA\])/);
            if (membersMatch) {
              const newBlock = membersMatch[2].split("\n").map(line => {
                if (!line.trim()) return line;
                const t = tokenize(line);
                if (!t || t.length < 3) return line;
                if (sc.filterName && clean(t[0]) !== sc.filterName) return line;
                if (clean(t[2]) === sc.oldSize) { membersChanged++; return replaceQuotedField(line, sc.oldSize, sc.newSize); }
                return line;
              }).join("\n");
              fileContent = fileContent.replace(membersMatch[2], newBlock);
            }
          }

          report.push(`Section "${sc.oldSize}" -> "${sc.newSize}": ${setsChanged} set(s), ${membersChanged} member(s) changed`);
        }
      }

      // --- BOUNDARY CONDITION CHANGES ---
      if (changes.boundaryConditions && changes.boundaryConditions.length > 0) {
        // Code mapping: Fixed=4, Free=0
        const codeMap = { "Fixed": 4, "Free": 0 };

        const bcMatch = fileContent.match(/(\[BOUNDARY_CONDITIONS\] <\d+>)([\s\S]*?)(\[END_BOUNDARY_CONDITIONS\])/);
        if (bcMatch) {
          // Parse existing BC lines into a map: nodeIndex -> line
          // BC line format: nodeIndex X Y Z RotX RotY RotZ [extra fields]
          // We need to resolve node label -> node index first
          const nodesOrdered = parseNodesOrdered(fileContent);
          const nodeLabelToIndex = {};
          nodesOrdered.forEach((n, i) => { nodeLabelToIndex[n.label] = i + 1; }); // 1-based

          let bcBlock = bcMatch[2];
          for (const bc of changes.boundaryConditions) {
            const nodeIdx = nodeLabelToIndex[bc.nodeLabel];
            if (!nodeIdx) {
              report.push(`BC change: node "${bc.nodeLabel}" not found -- skipped`);
              continue;
            }

            const lines = bcBlock.split("\n");
            let found = false;
            const newLines = lines.map(line => {
              const t = line.trim().split(/\s+/);
              if (t[0] === String(nodeIdx)) {
                found = true;
                // t: [nodeIdx, X, Y, Z, RotX, RotY, RotZ, ...]
                const parts = line.split(/\s+/);
                if (bc.x !== undefined) parts[1] = String(codeMap[bc.x]);
                if (bc.y !== undefined) parts[2] = String(codeMap[bc.y]);
                if (bc.z !== undefined) parts[3] = String(codeMap[bc.z]);
                if (bc.rotX !== undefined) parts[4] = String(codeMap[bc.rotX]);
                if (bc.rotY !== undefined) parts[5] = String(codeMap[bc.rotY]);
                if (bc.rotZ !== undefined) parts[6] = String(codeMap[bc.rotZ]);
                return parts.join(" ");
              }
              return line;
            });
            bcBlock = newLines.join("\n");
            report.push(`BC "${bc.nodeLabel}": ${found ? "updated" : "node index found but no matching BC line -- may need to add new BC entry"}`);
          }
          fileContent = fileContent.replace(bcMatch[2], bcBlock);
        } else {
          report.push("No BOUNDARY_CONDITIONS section found.");
        }
      }

      // --- LOAD MAGNITUDE CHANGES ---
      if (changes.loadMagnitudes && changes.loadMagnitudes.length > 0) {
        // Resolve load case name -> internal LC ID
        const blcMatch = fileContent.match(/\[BASIC_LOAD_CASES\] <\d+>([\s\S]*?)\[END_BASIC_LOAD_CASES\]/);
        const lcNameToId = {};
        if (blcMatch) {
          blcMatch[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
            const t = tokenize(line);
            if (t && t.length >= 2) {
              // Map both the sequential index and the name
              lcNameToId[clean(t[1])] = t[0]; // name -> sequential index
            }
          });
        }

        const ddlMatch = fileContent.match(/(\[DIRECT_DISTRIBUTED_LOADS\] <\d+>)([\s\S]*?)(\[END_DIRECT_DISTRIBUTED_LOADS\])/);
        if (ddlMatch) {
          let ddlBlock = ddlMatch[2];
          for (const lc of changes.loadMagnitudes) {
            const endMag = lc.newEndMag !== undefined ? lc.newEndMag : lc.newStartMag;
            let changed = 0;
            // DDL line format: memberLabel lcID startMag endMag startLoc endLoc direction
            const newBlock = ddlBlock.split("\n").map(line => {
              if (!line.trim()) return line;
              const t = tokenize(line);
              if (!t || t.length < 4) return line;
              const thisLabel = clean(t[0]);
              if (thisLabel !== lc.memberLabel) return line;
              // Check load case -- match by name lookup or direct ID
              const lcId = lcNameToId[lc.loadCaseName];
              if (lcId && t[1] !== lcId) return line;
              // Replace start and end magnitudes (fields 2 and 3)
              changed++;
              const parts = line.trim().split(/\s+/);
              parts[2] = lc.newStartMag.toFixed(6);
              parts[3] = endMag.toFixed(6);
              return parts.join(" ");
            }).join("\n");
            ddlBlock = newBlock;
            report.push(`Load "${lc.memberLabel}" (${lc.loadCaseName}): magnitudes updated`);
          }
          fileContent = fileContent.replace(ddlMatch[2], ddlBlock);
        } else {
          report.push("No DIRECT_DISTRIBUTED_LOADS section found.");
        }
      }

      // Write new file
      fs.writeFileSync(outputPath, fileContent, "utf8");
      report.unshift(`Cloned model saved to: ${outputPath}`);
      report.push(`Original unchanged: ${filePath}`);

      return { content: [{ type: "text", text: report.join("\n") }] };

    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
