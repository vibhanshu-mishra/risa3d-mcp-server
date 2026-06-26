import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";

import {
  tokenize,
  clean,
  cleanSemi,
  parseBasicLoadCases,
  getBasicLoadCaseName,
  buildBasicLoadCaseHelpers,
  parseLoadsByBasicLoadCase,
  parseNodesOrdered,
  parseMembersResolved,
  distance3D,
  replaceSectionSizeInContent,
  replaceQuotedToken,
  runQCChecks,
  padRISA,
  getNodesSection,
  getMembersSection,
  getTrailingNodeFields,
  rebuildNodesSection,
  rebuildMembersSection,
  generateUnusedLabel,
  findOrCreateNodeForGeometry
} from "./risa-core.js";

const server = new McpServer({
  name: "risa3d-mcp",
  version: "1.0.0"
});

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
      const qc = runQCChecks(content);

      const issues = [];

      issues.push("--- Duplicate Nodes (same coordinates) ---");
      if (qc.duplicateNodes.length > 0) {
        qc.duplicateNodes.forEach(group => {
          issues.push(`Multiple nodes at (${group.coords}): ${group.labels.join(", ")}`);
        });
      } else {
        issues.push("None found.");
      }

      issues.push("\n--- Duplicate Member Labels ---");
      issues.push(qc.duplicateMemberLabels.length > 0 ? qc.duplicateMemberLabels.join(", ") : "None found.");

      issues.push("\n--- Members With No Section Size Assigned ---");
      issues.push(qc.missingSize.length > 0 ? qc.missingSize.join(", ") : "None found.");

      issues.push("\n--- Zero-Length Members ---");
      issues.push(qc.zeroLength.length > 0 ? qc.zeroLength.join(", ") : "None found.");

      issues.push("\n--- Members Referencing Invalid Node Indices ---");
      issues.push(qc.invalidNodeRefs.length > 0 ? qc.invalidNodeRefs.join("\n") : "None found.");

      return {
        content: [{
          type: "text",
          text:
            `QC Check Report\n` +
            `File: ${filePath}\n` +
            `Status: ${qc.status}\n` +
            `Issue Count: ${qc.issueCount}\n` +
            `Nodes: ${qc.nodeCount}, Members: ${qc.memberCount}\n\n` +
            issues.join("\n")
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

// Tool 12: Summarize model for report
server.tool(
  "summarize_model_for_report",
  {
    filePath: z.string().describe("Full path to the .r3d file")
  },
  async ({ filePath }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const nodesOrdered = parseNodesOrdered(content);
      const members = parseMembersResolved(content, nodesOrdered);
      const parsedLoads = parseLoadsByBasicLoadCase(content);

      const report = [];

      report.push("MODEL REPORT SUMMARY");
      report.push(`File: ${filePath}`);
      report.push(`Nodes: ${nodesOrdered.length}`);
      report.push(`Members: ${members.length}`);

      report.push("\n=== LOAD TABLE CHECK ===");
      report.push(`Distributed loads: ${parsedLoads.totals.consumedDistributedLoads} / ${parsedLoads.totals.distributedLoads}`);
      report.push(`Area loads: ${parsedLoads.totals.consumedAreaLoads} / ${parsedLoads.totals.areaLoads}`);
      report.push(`Node loads: ${parsedLoads.totals.consumedNodeLoads} / ${parsedLoads.totals.nodeLoads}`);

      parsedLoads.cases.forEach(blc => {
        const isTransient = blc.name.toLowerCase().includes("transient area loads");

        report.push(`\n=== BLC ${blc.index}: ${blc.name} ===`);

        if (isTransient) {
          report.push(`Generated transient load case. Distributed: ${blc.distributedLoads.length}, Area: ${blc.areaLoads.length}, Node: ${blc.nodeLoads.length}`);
          return;
        }

        report.push(`Distributed loads: ${blc.distributedLoads.length}`);
        report.push(`Area loads: ${blc.areaLoads.length}`);
        report.push(`Node loads: ${blc.nodeLoads.length}`);

        if (blc.areaLoads.length > 0) {
          report.push("\nArea Loads:");
          report.push("Row,Corners,Direction,Magnitude");

          blc.areaLoads.forEach(load => {
            const p = load.tokens;

            const corners = [0, 1, 2, 3].map(i => {
              const node = nodesOrdered[parseInt(p[i], 10) - 1];
              return node ? node.label : `(idx ${p[i]})`;
            }).join("-");

            const dirCode = parseInt(p[5], 10);
            const direction =
              dirCode === 1 ? "Y / Gravity" :
              dirCode === 2 ? "Z" :
              dirCode === 3 ? "X" :
              `Dir${dirCode}`;

            report.push([
              load.rowNumber,
              corners,
              direction,
              parseFloat(p[6])
            ].join(","));
          });
        }

        if (blc.distributedLoads.length > 0) {
          report.push("\nMember Distributed Loads:");
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

        if (blc.nodeLoads.length > 0) {
          report.push("\nNode Loads:");
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

      return {
        content: [{ type: "text", text: report.join("\n") }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
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
// Helper: replace a quoted 32-char field value in a line
// Replaces "oldVal<padding>" with "newVal<padding>" -- exact width preserved

// Tool 17: modify_section_set
// Changes a section size in a RISA-3D model and saves as a NEW file.
// Mode "set" changes the section set definition.
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
      .describe("set = section set only, member = member assignment only, both = both"),
    filterName: z.string().optional()
      .describe("Optional section set name or member label to limit the change")
  },
  async ({ filePath, outputPath, oldSize, newSize, mode, filterName }) => {
    try {
      if (filePath.toLowerCase() === outputPath.toLowerCase()) {
        return {
          content: [{
            type: "text",
            text: "Error: outputPath must be different from filePath. This tool never overwrites the original file."
          }]
        };
      }

      const content = fs.readFileSync(filePath, "utf8");

      const result = replaceSectionSizeInContent(content, {
        oldSize,
        newSize,
        scope: mode,
        filterName
      });

      if (result.setsChanged === 0 && result.membersChanged === 0) {
        return {
          content: [{
            type: "text",
            text:
              `No matches found for section size "${oldSize}". No file written.\n` +
              `Mode: ${mode}\n` +
              `Filter: ${filterName || "none"}`
          }]
        };
      }

      fs.writeFileSync(outputPath, result.content, "utf8");

      return {
        content: [{
          type: "text",
          text: [
            `Modified section size "${oldSize}" -> "${newSize}"`,
            `Mode: ${mode}`,
            `Filter: ${filterName || "none"}`,
            `Section sets changed: ${result.setsChanged}`,
            `Member assignments changed: ${result.membersChanged}`,
            `Saved new model: ${outputPath}`,
            `Original unchanged: ${filePath}`
          ].join("\n")
        }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// Tool 18: clone_model_with_changes
// Saves a copy of a .r3d model with one or more changes applied.
// Supported changes: section sizes, boundary conditions, member distributed load magnitudes, node load magnitudes.
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
        loadCaseName: z.string().describe("Basic load case name e.g. DL, LL, WLx, WLz"),
        newStartMag: z.number().describe("New start magnitude (k/ft, negative = downward)"),
        newEndMag: z.number().optional().describe("New end magnitude -- defaults to same as newStartMag")
      })).optional().describe("Member distributed load magnitude changes"),

      nodeLoads: z.array(z.object({
        nodeLabel: z.string().describe("Node label e.g. N17"),
        loadCaseName: z.string().describe("Basic load case name e.g. DL, LL, WLx, WLz"),
        newMagnitude: z.number().describe("New node load magnitude")
      })).optional().describe("Node load magnitude changes")
    }).describe("Changes to apply to the cloned model")
  },
  async ({ filePath, outputPath, changes }) => {
    try {
      if (filePath.toLowerCase() === outputPath.toLowerCase()) {
        return {
          content: [{
            type: "text",
            text: "Error: outputPath must be different from filePath. This tool never overwrites the original file."
          }]
        };
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
                if (clean(t[2]) === sc.oldSize) {
                  setsChanged++;
                  return replaceQuotedToken(line, sc.oldSize, sc.newSize);
                }
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
                if (clean(t[2]) === sc.oldSize) {
                  membersChanged++;
                  return replaceQuotedToken(line, sc.oldSize, sc.newSize);
                }
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
        const codeMap = { "Fixed": 4, "Free": 0 };

        const bcMatch = fileContent.match(/(\[BOUNDARY_CONDITIONS\] <\d+>)([\s\S]*?)(\[END_BOUNDARY_CONDITIONS\])/);
        if (bcMatch) {
          const nodesOrdered = parseNodesOrdered(fileContent);
          const nodeLabelToIndex = {};
          nodesOrdered.forEach((n, i) => {
            nodeLabelToIndex[n.label] = i + 1;
          });

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

                const parts = line.trim().replace(";", "").split(/\s+/);
                if (bc.x !== undefined) parts[1] = String(codeMap[bc.x]);
                if (bc.y !== undefined) parts[2] = String(codeMap[bc.y]);
                if (bc.z !== undefined) parts[3] = String(codeMap[bc.z]);
                if (bc.rotX !== undefined) parts[4] = String(codeMap[bc.rotX]);
                if (bc.rotY !== undefined) parts[5] = String(codeMap[bc.rotY]);
                if (bc.rotZ !== undefined) parts[6] = String(codeMap[bc.rotZ]);

                return parts.join(" ") + ";";
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

      // --- MEMBER DISTRIBUTED LOAD MAGNITUDE CHANGES ---
      if (changes.loadMagnitudes && changes.loadMagnitudes.length > 0) {
        const nodesOrdered = parseNodesOrdered(fileContent);
        const members = parseMembersResolved(fileContent, nodesOrdered);
        const parsedLoads = parseLoadsByBasicLoadCase(fileContent);

        const ddlMatch = fileContent.match(/(\[DIRECT_DISTRIBUTED_LOADS\] <\d+>)([\s\S]*?)(\[END_DIRECT_DISTRIBUTED_LOADS\])/);

        if (!ddlMatch) {
          report.push("No DIRECT_DISTRIBUTED_LOADS section found.");
        } else {
          let ddlLines = ddlMatch[2].split("\n");

          const memberLabelToIndex = {};
          members.forEach((m, i) => {
            memberLabelToIndex[m.label] = i + 1;
          });

          for (const lc of changes.loadMagnitudes) {
            const memberIdx = memberLabelToIndex[lc.memberLabel];
            const endMag = lc.newEndMag !== undefined ? lc.newEndMag : lc.newStartMag;

            if (!memberIdx) {
              report.push(`Load "${lc.memberLabel}" (${lc.loadCaseName}): member not found -- skipped`);
              continue;
            }

            const targetCase = parsedLoads.cases.find(c =>
              c.name.toLowerCase() === lc.loadCaseName.toLowerCase()
            );

            if (!targetCase) {
              report.push(`Load "${lc.memberLabel}" (${lc.loadCaseName}): load case not found -- skipped`);
              continue;
            }

            let changed = 0;

            targetCase.distributedLoads.forEach(load => {
              const p = load.tokens;
              const rowMemberIdx = parseInt(p[0], 10);

              if (rowMemberIdx !== memberIdx) return;

              const rowNumber = load.rowNumber;
              let seenNonEmpty = 0;

              ddlLines = ddlLines.map(line => {
                if (!line.trim()) return line;

                seenNonEmpty++;

                if (seenNonEmpty !== rowNumber) return line;

                const parts = line.trim().replace(";", "").split(/\s+/);
                parts[2] = lc.newStartMag.toFixed(6);
                parts[3] = endMag.toFixed(6);

                changed++;
                return parts.join(" ") + ";";
              });
            });

            report.push(`Member load "${lc.memberLabel}" (${lc.loadCaseName}): ${changed} distributed load row(s) updated`);
          }

          fileContent = fileContent.replace(ddlMatch[2], ddlLines.join("\n"));
        }
      }

      // --- NODE LOAD MAGNITUDE CHANGES ---
      if (changes.nodeLoads && changes.nodeLoads.length > 0) {
        const nodesOrdered = parseNodesOrdered(fileContent);
        const parsedLoads = parseLoadsByBasicLoadCase(fileContent);

        const nodeLoadMatch = fileContent.match(/(\[NODE_LOADS\] <\d+>)([\s\S]*?)(\[END_NODE_LOADS\])/);

        if (!nodeLoadMatch) {
          report.push("No NODE_LOADS section found.");
        } else {
          let nodeLoadLines = nodeLoadMatch[2].split("\n");

          const nodeLabelToIndex = {};
          nodesOrdered.forEach((n, i) => {
            nodeLabelToIndex[n.label] = i + 1;
          });

          for (const nl of changes.nodeLoads) {
            const nodeIdx = nodeLabelToIndex[nl.nodeLabel];

            if (!nodeIdx) {
              report.push(`Node load "${nl.nodeLabel}" (${nl.loadCaseName}): node not found -- skipped`);
              continue;
            }

            const targetCase = parsedLoads.cases.find(c =>
              c.name.toLowerCase() === nl.loadCaseName.toLowerCase()
            );

            if (!targetCase) {
              report.push(`Node load "${nl.nodeLabel}" (${nl.loadCaseName}): load case not found -- skipped`);
              continue;
            }

            let changed = 0;

            targetCase.nodeLoads.forEach(load => {
              const p = load.tokens;
              const rowNodeIdx = parseInt(p[0], 10);

              if (rowNodeIdx !== nodeIdx) return;

              const rowNumber = load.rowNumber;
              let seenNonEmpty = 0;

              nodeLoadLines = nodeLoadLines.map(line => {
                if (!line.trim()) return line;

                seenNonEmpty++;

                if (seenNonEmpty !== rowNumber) return line;

                const parts = line.trim().replace(";", "").split(/\s+/);
                parts[2] = nl.newMagnitude.toFixed(6);

                changed++;
                return parts.join(" ") + ";";
              });
            });

            report.push(`Node load "${nl.nodeLabel}" (${nl.loadCaseName}): ${changed} node load row(s) updated`);
          }

          fileContent = fileContent.replace(nodeLoadMatch[2], nodeLoadLines.join("\n"));
        }
      }

      fs.writeFileSync(outputPath, fileContent, "utf8");

      report.unshift(`Cloned model saved to: ${outputPath}`);
      report.push(`Original unchanged: ${filePath}`);

      return {
        content: [{ type: "text", text: report.join("\n") }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// ---- Shape weight lookup (lb/ft) ----
// AISC standard shapes. For W, C, L shapes the designation number IS the weight per foot.
// For HSS/tube shapes the designation is dimensions, not weight, so those need an explicit table.
// Sizes not covered here are flagged as "unknown" rather than guessed.
const HSS_WEIGHT_TABLE = {
  "HSS8X8X10": 25.3,   // 5/8" wall (0.10 designation maps to 0.625" actual in RISA naming convention)
  "HSS4X4X4": 11.97,   // 1/4" wall
  "HSS6X6X8": 17.6,
  "HSS4X4X8": 9.84,
  "HSS3X3X4": 7.04,
  "HSS6X4X4": 11.97,
  "HSS5X5X4": 11.4
};

// Returns weight in lb/ft for a given type + size designation, or null if unknown
function getShapeWeight(type, size) {
  const t = type.toLowerCase();
  const s = size.toUpperCase().trim();

  if (t === "wide flange" || t === "channel") {
    // W14X22 -> 22, C15X33.9 -> 33.9 -- designation number after the X IS the weight/ft
    const match = s.match(/X([\d.]+)$/);
    if (match) return parseFloat(match[1]);
    return null;
  }

  if (t === "none" && /^L\d/.test(s)) {
    // Angles: designation does NOT equal weight. Common AISC angle weights (lb/ft):
    const angleWeights = {
      "L2X2X2": 3.19, "L2X2X3": 4.7, "L3X3X4": 9.4, "L4X4X4": 12.8,
      "L3X3X2": 4.9, "L2.5X2.5X4": 7.7
    };
    return angleWeights[s] || null;
  }

  if (t === "tube") {
    return HSS_WEIGHT_TABLE[s] || null;
  }

  return null;
}

// Tool 19: Material takeoff -- total weight by section size
// Weight per foot comes from AISC shape designations (W/C shapes: number after X = lb/ft).
// HSS and angle shapes use a lookup table -- sizes not in the table are flagged, not guessed.
server.tool(
  "get_material_takeoff",
  { filePath: z.string().describe("Full path to the .r3d file") },
  async ({ filePath }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const nodesOrdered = parseNodesOrdered(content);
      const members = parseMembersResolved(content, nodesOrdered);

      if (members.length === 0) {
        return { content: [{ type: "text", text: "No members found in this model." }] };
      }

      // Group by type+size
      const groups = {};
      const unknownSizes = new Set();

      members.forEach(m => {
        const len = distance3D(m.iCoord, m.jCoord);
        if (len === null) return;
        const key = `${m.type}|${m.size}`;
        if (!groups[key]) groups[key] = { type: m.type, size: m.size, count: 0, totalLengthFt: 0 };
        groups[key].count++;
        groups[key].totalLengthFt += len;
      });

      const rows = ["Type,Size,Count,TotalLength(ft),Weight(lb/ft),TotalWeight(lb)"];
      let grandTotalWeight = 0;
      let grandTotalLength = 0;

      Object.values(groups).sort((a, b) => b.totalLengthFt - a.totalLengthFt).forEach(g => {
        const wPerFt = getShapeWeight(g.type, g.size);
        grandTotalLength += g.totalLengthFt;
        if (wPerFt === null) {
          unknownSizes.add(`${g.type} ${g.size}`);
          rows.push(`${g.type},${g.size},${g.count},${g.totalLengthFt.toFixed(1)},UNKNOWN,UNKNOWN`);
        } else {
          const totalW = wPerFt * g.totalLengthFt;
          grandTotalWeight += totalW;
          rows.push(`${g.type},${g.size},${g.count},${g.totalLengthFt.toFixed(1)},${wPerFt},${totalW.toFixed(0)}`);
        }
      });

      const summary = [
        `Material Takeoff`,
        `File: ${filePath}`,
        `Total members: ${members.length}`,
        `Total length (all members): ${grandTotalLength.toFixed(1)} ft`,
        `Total weight (known shapes only): ${grandTotalWeight.toFixed(0)} lb (${(grandTotalWeight / 2000).toFixed(2)} tons)`,
        unknownSizes.size > 0 ? `\nWeight unknown for: ${[...unknownSizes].join(", ")} -- not included in total. Add these to the lookup table in index.js to include them.` : "",
        ``,
        rows.join("\n")
      ].filter(l => l !== "").join("\n");

      return { content: [{ type: "text", text: summary }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Tool 20: Flag members for unbraced length review
// This does NOT perform a KL/r calculation -- that requires K-factors and design
// intent only the engineer can determine. Instead it flags members exceeding a
// simple length threshold for manual review, grouped by section type since
// reasonable unbraced lengths vary a lot by shape (HSS columns vs W-shape beams).
server.tool(
  "find_unbraced_length_issues",
  {
    filePath: z.string().describe("Full path to the .r3d file"),
    thresholdFt: z.number().optional().default(15)
      .describe("Flag members longer than this length (ft) for review. Default 15 ft.")
  },
  async ({ filePath, thresholdFt }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const nodesOrdered = parseNodesOrdered(content);
      const members = parseMembersResolved(content, nodesOrdered);

      if (members.length === 0) {
        return { content: [{ type: "text", text: "No members found in this model." }] };
      }

      const flagged = [];
      members.forEach(m => {
        const len = distance3D(m.iCoord, m.jCoord);
        if (len !== null && len > thresholdFt) {
          flagged.push({ ...m, length: len });
        }
      });

      if (flagged.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No members exceed ${thresholdFt} ft. No length-based review flags.\n\nNote: this is a length screen only, not a KL/r or slenderness check. It does not account for intermediate brace points, K-factors, or load type.`
          }]
        };
      }

      flagged.sort((a, b) => b.length - a.length);
      const rows = ["Label,Type,Size,Length(ft),iNode,jNode"];
      flagged.forEach(m => {
        rows.push(`${m.label},${m.type},${m.size},${m.length.toFixed(2)},${m.iNode || "?"},${m.jNode || "?"}`);
      });

      return {
        content: [{
          type: "text",
          text: `Members for unbraced length review (>${thresholdFt} ft): ${flagged.length} of ${members.length} total\n\n` +
            `Note: this is a length screen only -- it flags members for your review, it does NOT calculate KL/r, ` +
            `account for intermediate brace points, or apply K-factors. Use engineering judgment to confirm whether ` +
            `each flagged member's actual unbraced length and slenderness are acceptable.\n\n` +
            rows.join("\n")
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Tool 21: Export member schedule directly to a real .xlsx file
// Writes an actual Excel file to outputPath instead of returning CSV text to copy-paste.
server.tool(
  "export_member_schedule_to_excel",
  {
    filePath: z.string().describe("Full path to the .r3d file"),
    outputPath: z.string().describe("Full path for the .xlsx file to create, e.g. C:\\\\Users\\\\you\\\\Desktop\\\\schedule.xlsx")
  },
  async ({ filePath, outputPath }) => {
    try {
      const XLSX = await import("xlsx");
      const content = fs.readFileSync(filePath, "utf8");
      const nodesOrdered = parseNodesOrdered(content);
      const members = parseMembersResolved(content, nodesOrdered);

      if (members.length === 0) {
        return { content: [{ type: "text", text: "No members found in this file." }] };
      }

      const data = [["Label", "Type", "Size", "iNode", "jNode", "Length (ft)"]];
      members.forEach(m => {
        const len = distance3D(m.iCoord, m.jCoord);
        data.push([m.label, m.type, m.size, m.iNode || "?", m.jNode || "?", len !== null ? parseFloat(len.toFixed(2)) : "N/A"]);
      });

      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = [{ wch: 10 }, { wch: 14 }, { wch: 18 }, { wch: 8 }, { wch: 8 }, { wch: 12 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Member Schedule");
      XLSX.writeFile(wb, outputPath);

      return {
        content: [{
          type: "text",
          text: `Member schedule (${members.length} members) saved to:\n${outputPath}`
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Tool 22: Export batch folder summary directly to a real .xlsx file
server.tool(
  "batch_summarize_folder_to_excel",
  {
    folderPath: z.string().describe("Full path to the folder containing .r3d files"),
    outputPath: z.string().describe("Full path for the .xlsx file to create"),
    filterName: z.string().optional()
      .describe("Optional: only include files whose name contains this string (case-insensitive)")
  },
  async ({ folderPath, outputPath, filterName }) => {
    try {
      const XLSX = await import("xlsx");

      let files;
      try {
        files = fs.readdirSync(folderPath);
      } catch (e) {
        return { content: [{ type: "text", text: `Cannot read folder: ${e.message}` }] };
      }

      let r3dFiles = files.filter(f => f.toLowerCase().endsWith(".r3d"));
      if (filterName) {
        r3dFiles = r3dFiles.filter(f => f.toLowerCase().includes(filterName.toLowerCase()));
      }

      if (r3dFiles.length === 0) {
        return { content: [{ type: "text", text: `No .r3d files found in folder${filterName ? ` matching "${filterName}"` : ""}.` }] };
      }

      const data = [["FileName", "Title", "Designer", "Nodes", "Members", "SectionSets", "LoadCombos", "FileSizeKB", "QCIssues"]];

      for (const fileName of r3dFiles) {
        const fp = folderPath.replace(/[\\/]+$/, "") + "\\" + fileName;
        try {
          const content = fs.readFileSync(fp, "utf8");

          const titleMatch = content.match(/\[\.\.MODEL_TITLE\] <1>\s*\n([^\n]+)/);
          const designerMatch = content.match(/\[\.\.DESIGNER_NAME\] <1>\s*\n([^\n]+)/);
          const title = titleMatch ? clean(titleMatch[1]) : "";
          const designer = designerMatch ? clean(designerMatch[1]) : "";

          const nodeMatch = content.match(/\[NODES\] <(\d+)>/);
          const memberMatch = content.match(/\[MEMBERS_MAIN_DATA\] <(\d+)>/);
          const setsMatch = content.match(/\[\.HR_STEEL_SECTION_SETS\] <(\d+)>/);
          const lcMatch = content.match(/\[LOAD_COMBINATIONS\] <(\d+)>/);

          const nodeCount = nodeMatch ? parseInt(nodeMatch[1]) : 0;
          const memberCount = memberMatch ? parseInt(memberMatch[1]) : 0;
          const setsCount = setsMatch ? parseInt(setsMatch[1]) : 0;
          const lcCount = lcMatch ? parseInt(lcMatch[1]) : 0;
          const fileSizeKB = Math.round(fs.statSync(fp).size / 1024);

          const nodesOrdered = parseNodesOrdered(content);
          const members = parseMembersResolved(content, nodesOrdered);
          const unassigned = members.filter(m => !m.size || m.size === "None" || m.size === "").length;
          const invalidRefs = members.filter(m => !m.iNode || !m.jNode).length;
          const qcIssues = [];
          if (unassigned > 0) qcIssues.push(`${unassigned} unassigned`);
          if (invalidRefs > 0) qcIssues.push(`${invalidRefs} invalid refs`);
          const qcSummary = qcIssues.length > 0 ? qcIssues.join("; ") : "OK";

          data.push([fileName, title, designer, nodeCount, memberCount, setsCount, lcCount, fileSizeKB, qcSummary]);
        } catch (fileErr) {
          data.push([fileName, "ERROR", "", "", "", "", "", "", fileErr.message]);
        }
      }

      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = [{ wch: 30 }, { wch: 30 }, { wch: 16 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 20 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Batch Summary");
      XLSX.writeFile(wb, outputPath);

      return {
        content: [{
          type: "text",
          text: `Batch summary (${r3dFiles.length} models) saved to:\n${outputPath}`
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);


// Tool 23: add_member
// Adds a new member to a RISA-3D model and saves as a NEW file (never overwrites original).
// Can connect two EXISTING nodes (by label) or create new nodes at given coordinates.
//
// SAFETY DESIGN NOTES (confirmed against raw .r3d format across multiple real models):
// - NODES section uses scientific notation (e.g. 1.200000000000e+01), a DIFFERENT
//   numeric format than MEMBERS_MAIN_DATA which uses plain decimals (e.g. 0.000000).
//   New node lines MUST use scientific notation or RISA will misparse them.
// - Every node line ends in a fixed trailing block: "0.000000000000e+00 65535 0 0 -1 -1 0".
//   This was verified identical across 300+ node lines in two different real project
//   models with completely different geometry, so it is treated as a universal
//   constant and copied verbatim rather than guessed.
// - Members reference nodes by their 1-based POSITION in the NODES list, not by label.
//   New nodes are always APPENDED to the end of the NODES block so no existing
//   member's i/j node reference ever shifts.
// - New member lines clone the FULL trailing field structure (orientation/release
//   bitmask, etc.) from an existing member of the SAME type in the model, changing
//   only label, size, and node indices. These trailing fields vary by member type
//   (Tube vs Wide Flange vs Channel vs None/Angle) and are not understood well enough
//   to hand-construct safely.
// - Header counts (<193>, <168>, etc.) are recalculated by actual line count after
//   the edit, never by manual increment, to eliminate off-by-one risk.
server.tool(
  "add_member",
  {
    filePath: z.string().describe("Full path to the source .r3d file"),
    outputPath: z.string().describe("Full path for the new .r3d file to save (must be different from source)"),
    type: z.enum(["Tube", "Wide Flange", "Channel", "None"]).describe("Member type/category. Use 'None' for angles."),
    size: z.string().describe("Section size designation e.g. HSS4X4X4, W14X22, C6X8.2, L2X2X2"),
    label: z.string().optional().describe("Label for the new member e.g. M999. If omitted, an unused label is generated automatically."),
    iNodeLabel: z.string().optional().describe("Existing node label for the start point e.g. N44. Use this OR iCoord, not both."),
    jNodeLabel: z.string().optional().describe("Existing node label for the end point e.g. N45. Use this OR jCoord, not both."),
    iCoord: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional()
      .describe("New node coordinates for the start point, if not connecting to an existing node. A new node is created and appended to the model."),
    jCoord: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional()
      .describe("New node coordinates for the end point, if not connecting to an existing node. A new node is created and appended to the model."),
    newINodeLabel: z.string().optional().describe("Label for a newly created start node, if iCoord is used. If omitted, an unused label is generated automatically."),
    newJNodeLabel: z.string().optional().describe("Label for a newly created end node, if jCoord is used. If omitted, an unused label is generated automatically.")
  },
  async ({ filePath, outputPath, type, size, label, iNodeLabel, jNodeLabel, iCoord, jCoord, newINodeLabel, newJNodeLabel }) => {
    try {
      if (filePath.toLowerCase() === outputPath.toLowerCase()) {
        return { content: [{ type: "text", text: "Error: outputPath must be different from filePath. This tool never overwrites the original file." }] };
      }

      // Must specify exactly one of (iNodeLabel) or (iCoord) for each end
      if (!iNodeLabel && !iCoord) {
        return { content: [{ type: "text", text: "Error: must provide either iNodeLabel (existing node) or iCoord (new node coordinates) for the start point." }] };
      }
      if (!jNodeLabel && !jCoord) {
        return { content: [{ type: "text", text: "Error: must provide either jNodeLabel (existing node) or jCoord (new node coordinates) for the end point." }] };
      }
      if (iNodeLabel && iCoord) {
        return { content: [{ type: "text", text: "Error: provide only one of iNodeLabel or iCoord for the start point, not both." }] };
      }
      if (jNodeLabel && jCoord) {
        return { content: [{ type: "text", text: "Error: provide only one of jNodeLabel or jCoord for the end point, not both." }] };
      }

      let fileContent = fs.readFileSync(filePath, "utf8");
      const report = [];

      // ---- Parse existing nodes in file order (this IS the positional index) ----
      const nodesMatch = fileContent.match(/(\[NODES\] <)(\d+)(>)([\s\S]*?)(\[END_NODES\])/);
      if (!nodesMatch) {
        return { content: [{ type: "text", text: "Error: could not find [NODES] section in file." }] };
      }
      const nodesBlockBody = nodesMatch[4];
      const nodeLines = nodesBlockBody.split("\n").filter(l => l.trim());
      const existingNodeLabels = nodeLines.map(line => clean(tokenize(line)[0]));
      const existingNodeLabelSet = new Set(existingNodeLabels);

      // Helper: generate an unused label like N9001, N9002, ... avoiding collisions
      function generateUnusedNodeLabel(usedSet) {
        let n = 9001;
        while (usedSet.has(`N${n}`)) n++;
        return `N${n}`;
      }
      function generateUnusedMemberLabel(content) {
        const allLabels = new Set();
        const mMatch = content.match(/\[\.MEMBERS_MAIN_DATA\] <\d+>([\s\S]*?)\[\.END_MEMBERS_MAIN_DATA\]/);
        if (mMatch) {
          mMatch[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
            allLabels.add(clean(tokenize(line)[0]));
          });
        }
        let n = 9001;
        while (allLabels.has(`M${n}`)) n++;
        return `M${n}`;
      }

      // Validate referenced existing node labels exist
      if (iNodeLabel && !existingNodeLabelSet.has(iNodeLabel)) {
        return { content: [{ type: "text", text: `Error: node "${iNodeLabel}" not found in model. Use list_nodes to see available labels.` }] };
      }
      if (jNodeLabel && !existingNodeLabelSet.has(jNodeLabel)) {
        return { content: [{ type: "text", text: `Error: node "${jNodeLabel}" not found in model. Use list_nodes to see available labels.` }] };
      }

      // Get the trailing constant block from the last existing node line, to copy verbatim.
      // The tokenizer does not separate the trailing semicolon from the final field
      // (e.g. the last token comes through as "0;"), so it must be stripped here and
      // a single semicolon re-added when the new line is assembled, or a double
      // semicolon results.
      const lastNodeLine = nodeLines[nodeLines.length - 1];
      const lastNodeTokens = tokenize(lastNodeLine);
      // Tokens: [0]=label(quoted), [1]=X, [2]=Y, [3]=Z, [4..]=trailing constant block
      const trailingNodeFields = lastNodeTokens.slice(4).join(" ").replace(/;\s*$/, "");

      // Format a coordinate value in RISA's scientific notation style (12 decimal places)
      function formatSciNotation(val) {
        return val.toExponential(12).replace(/e([+-])(\d+)/, (m, sign, digits) => {
          return `e${sign}${digits.padStart(2, "0")}`;
        });
      }

      function buildNodeLine(labelStr, x, y, z) {
        const paddedLabel = `"${padRISA(labelStr)}"`;
        return `${paddedLabel}   ${formatSciNotation(x)}   ${formatSciNotation(y)}   ${formatSciNotation(z)}   ${trailingNodeFields};`;
      }

      // ---- Resolve / create start node ----
      let iLabel, iIndex;
      const newNodeLinesToAppend = [];
      if (iNodeLabel) {
        iLabel = iNodeLabel;
        iIndex = existingNodeLabels.indexOf(iNodeLabel) + 1; // 1-based
      } else {
        iLabel = newINodeLabel || generateUnusedNodeLabel(existingNodeLabelSet);
        if (existingNodeLabelSet.has(iLabel)) {
          return { content: [{ type: "text", text: `Error: requested new node label "${iLabel}" already exists in the model. Choose a different label.` }] };
        }
        existingNodeLabelSet.add(iLabel);
        newNodeLinesToAppend.push(buildNodeLine(iLabel, iCoord.x, iCoord.y, iCoord.z));
        iIndex = nodeLines.length + newNodeLinesToAppend.length; // position after append
        report.push(`Created new node "${iLabel}" at (${iCoord.x}, ${iCoord.y}, ${iCoord.z})`);
      }

      // ---- Resolve / create end node ----
      let jLabel, jIndex;
      if (jNodeLabel) {
        jLabel = jNodeLabel;
        jIndex = existingNodeLabels.indexOf(jNodeLabel) + 1; // 1-based
      } else {
        jLabel = newJNodeLabel || generateUnusedNodeLabel(existingNodeLabelSet);
        if (existingNodeLabelSet.has(jLabel)) {
          return { content: [{ type: "text", text: `Error: requested new node label "${jLabel}" already exists in the model. Choose a different label.` }] };
        }
        existingNodeLabelSet.add(jLabel);
        newNodeLinesToAppend.push(buildNodeLine(jLabel, jCoord.x, jCoord.y, jCoord.z));
        jIndex = nodeLines.length + newNodeLinesToAppend.length; // position after append
        report.push(`Created new node "${jLabel}" at (${jCoord.x}, ${jCoord.y}, ${jCoord.z})`);
      }

      if (iLabel === jLabel) {
        return { content: [{ type: "text", text: "Error: start and end node are the same. A member cannot have zero length." }] };
      }

      // ---- Append new nodes to NODES block and recalculate header count ----
      if (newNodeLinesToAppend.length > 0) {
        const updatedNodesBody = nodesBlockBody.replace(/\s*$/, "") + "\n" + newNodeLinesToAppend.join("\n") + "\n";
        const newNodeCount = nodeLines.length + newNodeLinesToAppend.length;
        const newNodesSection = `${nodesMatch[1]}${newNodeCount}${nodesMatch[3]}${updatedNodesBody}${nodesMatch[5]}`;
        fileContent = fileContent.replace(nodesMatch[0], newNodesSection);
      }

      // ---- Find a template member of the matching type to clone trailing fields from ----
      const membersMatch = fileContent.match(/(\[\.MEMBERS_MAIN_DATA\] <)(\d+)(>)([\s\S]*?)(\[\.END_MEMBERS_MAIN_DATA\])/);
      if (!membersMatch) {
        return { content: [{ type: "text", text: "Error: could not find [.MEMBERS_MAIN_DATA] section in file." }] };
      }
      const membersBlockBody = membersMatch[4];
      const memberLines = membersBlockBody.split("\n").filter(l => l.trim());

      let templateLine = null;
      for (const line of memberLines) {
        const t = tokenize(line);
        if (clean(t[1]) === type) {
          templateLine = line;
          break;
        }
      }
      if (!templateLine) {
        return {
          content: [{
            type: "text",
            text: `Error: no existing member of type "${type}" found in this model to use as a template. ` +
              `This tool clones the trailing field structure from an existing member of the same type rather than ` +
              `guessing it, so at least one member of type "${type}" must already exist in the model. ` +
              `Existing types in this model: ${[...new Set(memberLines.map(l => clean(tokenize(l)[1])))].join(", ")}`
          }]
        };
      }

      // ---- Build the new member line from the template ----
      const templateTokens = tokenize(templateLine);
      // Tokens: [0]=label, [1]=type, [2]=size, [3]=iNodeIdx, [4]=jNodeIdx, [5..]=trailing fields
      const newLabel = label || generateUnusedMemberLabel(fileContent);

      // Check label doesn't already exist
      const existingMemberLabels = new Set(memberLines.map(l => clean(tokenize(l)[0])));
      if (existingMemberLabels.has(newLabel)) {
        return { content: [{ type: "text", text: `Error: member label "${newLabel}" already exists in the model. Choose a different label.` }] };
      }

      const newTokens = [...templateTokens];
      newTokens[0] = `"${padRISA(newLabel)}"`;
      newTokens[1] = `"${padRISA(type)}"`;
      newTokens[2] = `"${padRISA(size)}"`;
      newTokens[3] = String(iIndex);
      newTokens[4] = String(jIndex);
      const newMemberLine = newTokens.join(" ");

      // ---- Append new member line and recalculate header count ----
      const updatedMembersBody = membersBlockBody.replace(/\s*$/, "") + "\n" + newMemberLine + "\n";
      const newMemberCount = memberLines.length + 1;
      const newMembersSection = `${membersMatch[1]}${newMemberCount}${membersMatch[3]}${updatedMembersBody}${membersMatch[5]}`;
      fileContent = fileContent.replace(membersMatch[0], newMembersSection);

      // ---- Write new file ----
      fs.writeFileSync(outputPath, fileContent, "utf8");

      report.unshift(`Modified model saved to: ${outputPath}`);
      report.push(`New member "${newLabel}": ${type} ${size}, ${iLabel} (idx ${iIndex}) -> ${jLabel} (idx ${jIndex})`);
      report.push(`Template member used for field structure: "${clean(templateTokens[0])}"`);
      report.push(`Original unchanged: ${filePath}`);
      report.push(``);
      report.push(`IMPORTANT: open the saved file in RISA-3D and confirm it loads without errors and the new member appears correctly before relying on this model.`);

      return { content: [{ type: "text", text: report.join("\n") }] };

    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);


// Tool 24: export_to_saf
// Exports a RISA-3D .r3d model to SAF format (.xlsx) for import into
// other structural analysis software (SCIA Engineer, SOFiSTiK, AxisVM, etc.)
//
// SAF is an open Excel-based exchange format by the Nemetschek Group:
// https://www.saf.guide
//
// IMPORTANT LIMITATIONS NOTED IN OUTPUT:
// 1. UNITS: RISA-3D uses feet. SAF requires meters. All coordinates are
//    converted automatically (1 ft = 0.3048 m).
// 2. VERTICAL AXIS: RISA-3D uses Y as the vertical axis. SAF and most
//    receiving software expect Z as vertical. This tool does NOT swap axes
//    automatically -- that changes your model geometry and must be a deliberate
//    decision. The output file includes a warning sheet noting this. RISA itself
//    requires a Y->Z axis change before its own SAF export for the same reason.
//
// Sheets produced:
//   StructuralMaterial       -- steel material (one row, A992/A500)
//   StructuralCrossSection   -- one row per unique section set
//   StructuralPointConnection -- one row per node (coordinates in meters)
//   StructuralCurveMember    -- one row per member
//   StructuralPointSupport   -- one row per boundary condition node
//   NOTES                    -- limitations and conversion details
server.tool(
  "export_to_saf",
  {
    filePath: z.string().describe("Full path to the source .r3d file"),
    outputPath: z.string().describe("Full path for the SAF .xlsx file to create, e.g. C:\\\\Users\\\\you\\\\Desktop\\\\model.xlsx")
  },
  async ({ filePath, outputPath }) => {
    try {
      const XLSX = await import("xlsx");
      const fileContent = fs.readFileSync(filePath, "utf8");

      // ---- Parse nodes ----
      const nodesOrdered = parseNodesOrdered(fileContent);
      if (nodesOrdered.length === 0) {
        return { content: [{ type: "text", text: "Error: no nodes found in file." }] };
      }

      // ---- Parse members ----
      const members = parseMembersResolved(fileContent, nodesOrdered);
      if (members.length === 0) {
        return { content: [{ type: "text", text: "Error: no members found in file." }] };
      }

      // ---- Parse section sets ----
      const setsMatch = fileContent.match(/\[\.HR_STEEL_SECTION_SETS\] <\d+>([\s\S]*?)\[\.END_HR_STEEL_SECTION_SETS\]/);
      const sectionSets = {}; // label -> { type, size }
      if (setsMatch) {
        setsMatch[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
          const t = tokenize(line);
          if (t.length >= 3) {
            const label = clean(t[0]);
            const type = clean(t[1]);
            const size = clean(t[2]);
            sectionSets[label] = { type, size };
          }
        });
      }

      // ---- Parse boundary conditions ----
      // BOUNDARY_CONDITIONS format: nodeIndex, Tx, Ty, Tz, Rx, Ry, Rz
      // code 1 = fixed/restrained, 0 = free
      const bcMatch = fileContent.match(/\[BOUNDARY_CONDITIONS\] <\d+>([\s\S]*?)\[END_BOUNDARY_CONDITIONS\]/);
      const boundaryConditions = []; // { nodeLabel, ux, uy, uz, fix }
      if (bcMatch) {
        bcMatch[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
          const t = tokenize(line);
          if (t.length >= 4) {
            const nodeIdx = parseInt(t[0], 10);
            const tx = parseInt(t[1], 10); // 1=fixed
            const ty = parseInt(t[2], 10);
            const tz = parseInt(t[3], 10);
            const nodeObj = nodesOrdered[nodeIdx - 1];
            if (nodeObj) {
              boundaryConditions.push({
                nodeLabel: nodeObj.label,
                tx, ty, tz
              });
            }
          }
        });
      }

      // ---- Conversion constant ----
      const FT_TO_M = 0.3048;

      // ---- Build unique materials from section sets ----
      // RISA uses A992 for Wide Flange, A500 Gr.B for HSS/Tube, A36 for angles/channels
      // Map RISA type -> SAF material name
      const typeToMaterial = {
        "Wide Flange": "A992",
        "Tube": "A500 Gr.B RECT",
        "Channel": "A36",
        "None": "A36"
      };
      const materialsNeeded = new Set(members.map(m => typeToMaterial[m.type] || "Steel"));

      // ---- Sheet 1: StructuralMaterial ----
      const matHeaders = ["Name", "Type", "Subtype", "Quality", "Unit mass [kg/m3]",
        "E modulus [MPa]", "G modulus [MPa]", "Poisson coefficient", "Thermal expansion [1/K]"];
      const matRows = [matHeaders];
      // Steel defaults per SAF spec (SI units)
      const steelDefaults = ["Steel", "", "S 355", 7850, 210000, 80769, 0.3, 1.2e-5];
      materialsNeeded.forEach(matName => {
        matRows.push([matName, "Steel", "", matName, 7850, 210000, 80769, 0.3, 1.2e-5]);
      });

      // ---- Sheet 2: StructuralCrossSection ----
      const csHeaders = ["Name", "Material", "Cross-section type", "Shape", "Description ID of the profile",
        "Parameters description", "b [m]", "h [m]", "s [m]", "t [m]"];
      const csRows = [csHeaders];

      // Map RISA type -> SAF cross-section type
      const typeToCSType = {
        "Wide Flange": "I section",
        "Tube": "Rectangular Hollow",
        "Channel": "C section",
        "None": "L section"
      };

      // Build from section sets first, then fall back to unique type+size combos from members
      const csAdded = new Set();
      // From section sets
      Object.entries(sectionSets).forEach(([setName, { type, size }]) => {
        const csKey = setName;
        if (!csAdded.has(csKey)) {
          csAdded.add(csKey);
          const mat = typeToMaterial[type] || "Steel";
          const csType = typeToCSType[type] || "General";
          csRows.push([setName, mat, csType, size, size, "", "", "", "", ""]);
        }
      });
      // Any members not covered by named sets (section set index -1 = individually sized)
      members.forEach(m => {
        const csKey = m.size;
        if (!csAdded.has(csKey) && m.size && m.size !== "None" && m.size !== "") {
          csAdded.add(csKey);
          const mat = typeToMaterial[m.type] || "Steel";
          const csType = typeToCSType[m.type] || "General";
          csRows.push([m.size, mat, csType, m.size, m.size, "", "", "", "", ""]);
        }
      });

      // ---- Sheet 3: StructuralPointConnection (nodes) ----
      const nodeHeaders = ["Name", "Coordinate X [m]", "Coordinate Y [m]", "Coordinate Z [m]"];
      const nodeRows = [nodeHeaders];
      nodesOrdered.forEach(n => {
        nodeRows.push([
          n.label,
          parseFloat((n.x * FT_TO_M).toFixed(6)),
          parseFloat((n.y * FT_TO_M).toFixed(6)),
          parseFloat((n.z * FT_TO_M).toFixed(6))
        ]);
      });

      // ---- Sheet 4: StructuralCurveMember (members) ----
      // Map RISA member type label to SAF type string
      const memberTypeMap = {
        "Wide Flange": "Beam",
        "Tube": "Column",
        "Channel": "Beam",
        "None": "Beam"
      };

      const memberHeaders = ["Name", "Type", "Cross section", "Nodes", "Segments",
        "Layer", "Member system line", "Member eccentricity ey [m]", "Member eccentricity ez [m]"];
      const memberRows = [memberHeaders];

      members.forEach(m => {
        // Resolve cross section reference: prefer named section set, fall back to size
        let csRef = m.size; // default
        // Find which section set this member uses by matching size
        for (const [setName, setData] of Object.entries(sectionSets)) {
          if (setData.size === m.size && setData.type === m.type) {
            csRef = setName;
            break;
          }
        }
        const safType = memberTypeMap[m.type] || "General";
        const iNode = m.iNode || "?";
        const jNode = m.jNode || "?";
        memberRows.push([m.label, safType, csRef, `${iNode}; ${jNode}`, "Line", "", "Centre", 0, 0]);
      });

      // ---- Sheet 5: StructuralPointSupport (boundary conditions) ----
      const supportHeaders = ["Name", "Node", "Coordinate system",
        "Ux", "Uy", "Uz", "Fix"];
      const supportRows = [supportHeaders];

      boundaryConditions.forEach((bc, i) => {
        const name = `S${i + 1}`;
        // SAF uses "Fixed" / "Free" strings for each DOF
        const ux = bc.tx === 1 ? "Fixed" : "Free";
        const uy = bc.ty === 1 ? "Fixed" : "Free";
        const uz = bc.tz === 1 ? "Fixed" : "Free";
        // "Fix" column: summarize as Pin (tx,ty,tz fixed, rotations free) or Fixed (all fixed)
        const fix = (bc.tx === 1 && bc.ty === 1 && bc.tz === 1) ? "Fixed" : "Custom";
        supportRows.push([name, bc.nodeLabel, "Global", ux, uy, uz, fix]);
      });

      // ---- Sheet 6: NOTES (limitations) ----
      const notesRows = [
        ["SAF Export from RISA-3D MCP Server"],
        ["Generated:", new Date().toISOString()],
        ["Source file:", filePath],
        [""],
        ["IMPORTANT LIMITATIONS"],
        [""],
        ["1. UNITS -- Coordinates converted from feet (RISA) to meters (SAF)."],
        ["   Formula: 1 ft = 0.3048 m. All node coordinates in this file are in meters."],
        [""],
        ["2. VERTICAL AXIS -- RISA-3D uses Y as the vertical axis."],
        ["   SAF and most receiving structural software (SCIA, SOFiSTiK, AxisVM) expect Z as vertical."],
        ["   This export does NOT swap the Y and Z axes. If you import this file into software"],
        ["   that requires Z-vertical, you must manually rotate the model 90 degrees about the X-axis"],
        ["   after import, or change RISA's vertical axis to Z before re-exporting."],
        ["   RISA itself requires this Y->Z axis change before its own native SAF export."],
        [""],
        ["3. CROSS SECTIONS -- Section sizes are exported as-is from RISA designation strings"],
        ["   (e.g. W14X22, HSS4X4X4). The receiving software must recognize these AISC shape names."],
        ["   European software may require manual remapping to local section libraries."],
        [""],
        ["4. MEMBER TYPES -- Without confirmed Member Type data (Beam/Column/VBrace/HBrace),"],
        ["   member types are inferred from shape category only (Wide Flange=Beam, Tube=Column, etc.)"],
        ["   and may need manual correction in the receiving software."],
        [""],
        ["5. LOADS -- Load data is not included in this export. SAF supports load transfer"],
        ["   but RISA's load format requires additional parsing not yet implemented."],
      ];

      // ---- Write workbook ----
      const wb = XLSX.utils.book_new();

      const addSheet = (data, name) => {
        const ws = XLSX.utils.aoa_to_sheet(data);
        // Bold header row style (best effort -- xlsx package has limited style support)
        XLSX.utils.book_append_sheet(wb, ws, name);
      };

      addSheet(matRows, "StructuralMaterial");
      addSheet(csRows, "StructuralCrossSection");
      addSheet(nodeRows, "StructuralPointConnection");
      addSheet(memberRows, "StructuralCurveMember");
      if (supportRows.length > 1) {
        addSheet(supportRows, "StructuralPointSupport");
      }
      addSheet(notesRows, "NOTES");

      XLSX.writeFile(wb, outputPath);

      const summary = [
        `SAF export saved to: ${outputPath}`,
        ``,
        `Sheets written:`,
        `  StructuralMaterial:        ${matRows.length - 1} material(s)`,
        `  StructuralCrossSection:    ${csRows.length - 1} cross-section(s)`,
        `  StructuralPointConnection: ${nodeRows.length - 1} node(s)`,
        `  StructuralCurveMember:     ${memberRows.length - 1} member(s)`,
        `  StructuralPointSupport:    ${supportRows.length - 1} support(s)`,
        `  NOTES:                     See limitations sheet`,
        ``,
        `LIMITATIONS (see NOTES sheet for full details):`,
        `  - Coordinates converted from feet to meters (x0.3048)`,
        `  - RISA uses Y-vertical; SAF receivers expect Z-vertical -- axes NOT swapped`,
        `  - Loads not included in this export`,
        `  - Section names exported as AISC designations; may need remapping in European software`
      ].join("\n");

      return { content: [{ type: "text", text: summary }] };

    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);


// Tool 25: find_duplicate_nodes
// Scans the model for nodes whose coordinates are within a tolerance of each other.
// Duplicate nodes cause members to appear connected when they aren't, or create
// zero-length members, both of which produce wrong analysis results silently.
// Default tolerance is 0.001 ft (~0.3mm) -- tight enough to catch real duplicates
// without false-positives from intentional close-but-distinct geometry.
server.tool(
  "find_duplicate_nodes",
  {
    filePath: z.string().describe("Full path to the .r3d file"),
    toleranceFt: z.number().optional().default(0.001)
      .describe("Distance tolerance in feet. Nodes closer than this are flagged as duplicates. Default 0.001 ft (~0.3mm).")
  },
  async ({ filePath, toleranceFt }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const nodes = parseNodesOrdered(content);

      if (nodes.length === 0) {
        return { content: [{ type: "text", text: "No nodes found in file." }] };
      }

      const duplicates = [];
      // O(n^2) scan -- fine for typical stair models (100-300 nodes)
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dist = distance3D(nodes[i], nodes[j]);
          if (dist !== null && dist <= toleranceFt) {
            duplicates.push({
              a: nodes[i].label,
              b: nodes[j].label,
              dist: parseFloat(dist.toFixed(6)),
              ax: nodes[i].x, ay: nodes[i].y, az: nodes[i].z,
              bx: nodes[j].x, by: nodes[j].y, bz: nodes[j].z
            });
          }
        }
      }

      if (duplicates.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No duplicate nodes found (tolerance: ${toleranceFt} ft).\n${nodes.length} nodes checked.`
          }]
        };
      }

      const rows = ["NodeA,NodeB,Distance(ft),Ax,Ay,Az,Bx,By,Bz"];
      duplicates.forEach(d => {
        rows.push(`${d.a},${d.b},${d.dist},${d.ax},${d.ay},${d.az},${d.bx},${d.by},${d.bz}`);
      });

      return {
        content: [{
          type: "text",
          text: `Duplicate nodes found: ${duplicates.length} pair(s) within ${toleranceFt} ft\n` +
            `${nodes.length} total nodes checked.\n\n` +
            `These nodes share nearly identical coordinates. Members connecting to duplicate ` +
            `nodes may appear connected in the model view but will have incorrect analysis ` +
            `behavior. Use Model Merge in RISA-3D (Tools > Model Merge) to resolve.\n\n` +
            rows.join("\n")
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Tool 26: replace_section_size_in_folder
// Replaces a section size across ALL .r3d files in a folder, saving each as a
// new file with a suffix (never overwrites originals).
// Useful for standardizing sizes across a project folder or updating a size
// that was changed in a spec after multiple models were already built.
server.tool(
  "replace_section_size_in_folder",
  {
    folderPath: z.string().describe("Full path to the folder containing .r3d files"),
    oldSize: z.string().describe("Section size to replace, e.g. C15X33.9"),
    newSize: z.string().describe("Replacement section size, e.g. C12X20.7"),
    outputSuffix: z.string().optional().default("-revised")
      .describe("Suffix appended to each output filename before the extension. Default: -revised"),
    filterName: z.string().optional()
      .describe("Optional: only process files whose name contains this string (case-insensitive)")
  },
  async ({ folderPath, oldSize, newSize, outputSuffix, filterName }) => {
    try {
      let files;
      try {
        files = fs.readdirSync(folderPath);
      } catch (e) {
        return { content: [{ type: "text", text: `Cannot read folder: ${e.message}` }] };
      }

      let r3dFiles = files.filter(f => f.toLowerCase().endsWith(".r3d"));
      if (filterName) {
        r3dFiles = r3dFiles.filter(f => f.toLowerCase().includes(filterName.toLowerCase()));
      }
      if (r3dFiles.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No .r3d files found in folder${filterName ? ` matching "${filterName}"` : ""}.`
          }]
        };
      }

      const basePath = folderPath.replace(/[\\/]+$/, "");
      const results = [];
      let totalChanged = 0;

      for (const fileName of r3dFiles) {
        const inputPath = `${basePath}\\${fileName}`;
        const baseName = fileName.replace(/\.r3d$/i, "");
        const outputPath = `${basePath}\\${baseName}${outputSuffix}.r3d`;

        try {
          let fileContent = fs.readFileSync(inputPath, "utf8");

          // Count occurrences before replacing
          const regex = new RegExp(oldSize.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
          const matchCount = (fileContent.match(regex) || []).length;

          if (matchCount === 0) {
            results.push(`${fileName}: no matches -- skipped (no output file written)`);
            continue;
          }

          fileContent = fileContent.replace(regex, newSize);
          fs.writeFileSync(outputPath, fileContent, "utf8");
          totalChanged += matchCount;
          results.push(`${fileName}: ${matchCount} replacement(s) -> saved as ${baseName}${outputSuffix}.r3d`);
        } catch (fileErr) {
          results.push(`${fileName}: ERROR -- ${fileErr.message}`);
        }
      }

      return {
        content: [{
          type: "text",
          text: [
            `Section size replacement: "${oldSize}" -> "${newSize}"`,
            `Folder: ${folderPath}`,
            `Files processed: ${r3dFiles.length}`,
            `Total replacements made: ${totalChanged}`,
            ``,
            results.join("\n"),
            ``,
            `Originals unchanged. Open each revised file in RISA-3D to confirm section ` +
            `properties loaded correctly before using for analysis.`
          ].join("\n")
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Tool 27: compare_risa_models
// Diffs two .r3d files and reports exactly what changed: nodes added/removed/moved,
// members added/removed/changed section, section sets changed, load combinations changed.
// Useful for tracking design iterations and documenting what changed between submittals.
server.tool(
  "compare_risa_models",
  {
    baseFilePath: z.string().describe("Full path to the baseline (older/original) .r3d file"),
    revisedFilePath: z.string().describe("Full path to the revised (newer) .r3d file")
  },
  async ({ baseFilePath, revisedFilePath }) => {
    try {
      const baseContent = fs.readFileSync(baseFilePath, "utf8");
      const revisedContent = fs.readFileSync(revisedFilePath, "utf8");

      const baseNodes = parseNodesOrdered(baseContent);
      const revisedNodes = parseNodesOrdered(revisedContent);
      const baseMembers = parseMembersResolved(baseContent, baseNodes);
      const revisedMembers = parseMembersResolved(revisedContent, revisedNodes);

      // Index by label for fast lookup
      const baseNodeMap = Object.fromEntries(baseNodes.map(n => [n.label, n]));
      const revisedNodeMap = Object.fromEntries(revisedNodes.map(n => [n.label, n]));
      const baseMemberMap = Object.fromEntries(baseMembers.map(m => [m.label, m]));
      const revisedMemberMap = Object.fromEntries(revisedMembers.map(m => [m.label, m]));

      const COORD_TOL = 0.001; // ft -- treat coord changes smaller than this as unchanged
      const report = [];

      // ---- Node diff ----
      const addedNodes = revisedNodes.filter(n => !baseNodeMap[n.label]);
      const removedNodes = baseNodes.filter(n => !revisedNodeMap[n.label]);
      const movedNodes = baseNodes.filter(n => {
        const r = revisedNodeMap[n.label];
        if (!r) return false;
        return distance3D(n, r) > COORD_TOL;
      });

      report.push("=== NODES ===");
      if (addedNodes.length === 0 && removedNodes.length === 0 && movedNodes.length === 0) {
        report.push("No node changes.");
      } else {
        if (addedNodes.length > 0) {
          report.push(`Added (${addedNodes.length}): ${addedNodes.map(n => n.label).join(", ")}`);
        }
        if (removedNodes.length > 0) {
          report.push(`Removed (${removedNodes.length}): ${removedNodes.map(n => n.label).join(", ")}`);
        }
        if (movedNodes.length > 0) {
          report.push(`Moved (${movedNodes.length}):`);
          movedNodes.forEach(n => {
            const r = revisedNodeMap[n.label];
            const dist = distance3D(n, r);
            report.push(`  ${n.label}: (${n.x},${n.y},${n.z}) -> (${r.x},${r.y},${r.z}) [delta ${dist.toFixed(4)} ft]`);
          });
        }
      }

      // ---- Member diff ----
      const addedMembers = revisedMembers.filter(m => !baseMemberMap[m.label]);
      const removedMembers = baseMembers.filter(m => !revisedMemberMap[m.label]);
      const changedMembers = baseMembers.filter(m => {
        const r = revisedMemberMap[m.label];
        if (!r) return false;
        return m.size !== r.size || m.type !== r.type ||
          m.iNode !== r.iNode || m.jNode !== r.jNode;
      });

      report.push("\n=== MEMBERS ===");
      if (addedMembers.length === 0 && removedMembers.length === 0 && changedMembers.length === 0) {
        report.push("No member changes.");
      } else {
        if (addedMembers.length > 0) {
          report.push(`Added (${addedMembers.length}):`);
          addedMembers.forEach(m => report.push(`  ${m.label}: ${m.type} ${m.size} [${m.iNode}->${m.jNode}]`));
        }
        if (removedMembers.length > 0) {
          report.push(`Removed (${removedMembers.length}): ${removedMembers.map(m => m.label).join(", ")}`);
        }
        if (changedMembers.length > 0) {
          report.push(`Changed (${changedMembers.length}):`);
          changedMembers.forEach(m => {
            const r = revisedMemberMap[m.label];
            const changes = [];
            if (m.size !== r.size) changes.push(`size: ${m.size} -> ${r.size}`);
            if (m.type !== r.type) changes.push(`type: ${m.type} -> ${r.type}`);
            if (m.iNode !== r.iNode || m.jNode !== r.jNode) {
              changes.push(`nodes: ${m.iNode}->${m.jNode} vs ${r.iNode}->${r.jNode}`);
            }
            report.push(`  ${m.label}: ${changes.join("; ")}`);
          });
        }
      }

      // ---- Section set diff ----
      const parseSets = (c) => {
        const m = c.match(/\[\.HR_STEEL_SECTION_SETS\] <\d+>([\s\S]*?)\[\.END_HR_STEEL_SECTION_SETS\]/);
        if (!m) return {};
        const sets = {};
        m[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
          const t = tokenize(line);
          if (t.length >= 3) {
            sets[clean(t[0])] = { type: clean(t[1]), size: clean(t[2]) };
          }
        });
        return sets;
      };

      const baseSets = parseSets(baseContent);
      const revisedSets = parseSets(revisedContent);
      const allSetNames = new Set([...Object.keys(baseSets), ...Object.keys(revisedSets)]);

      report.push("\n=== SECTION SETS ===");
      const setChanges = [];
      allSetNames.forEach(name => {
        const b = baseSets[name];
        const r = revisedSets[name];
        if (!b) setChanges.push(`  Added: "${name}" (${r.type} ${r.size})`);
        else if (!r) setChanges.push(`  Removed: "${name}"`);
        else if (b.size !== r.size || b.type !== r.type) {
          setChanges.push(`  Changed: "${name}" -- ${b.type} ${b.size} -> ${r.type} ${r.size}`);
        }
      });
      if (setChanges.length === 0) {
        report.push("No section set changes.");
      } else {
        report.push(...setChanges);
      }

      // ---- Load combination diff ----
      const parseLCs = (c) => {
        const m = c.match(/\[LOAD_COMBINATIONS\] <(\d+)>/);
        return m ? parseInt(m[1], 10) : 0;
      };
      const baseLCCount = parseLCs(baseContent);
      const revisedLCCount = parseLCs(revisedContent);

      report.push("\n=== LOAD COMBINATIONS ===");
      if (baseLCCount === revisedLCCount) {
        report.push(`No change (${baseLCCount} combinations in both).`);
      } else {
        report.push(`Count changed: ${baseLCCount} -> ${revisedLCCount}`);
      }

      // ---- Summary header ----
      const totalChanges = addedNodes.length + removedNodes.length + movedNodes.length +
        addedMembers.length + removedMembers.length + changedMembers.length + setChanges.length +
        (baseLCCount !== revisedLCCount ? 1 : 0);

      const header = [
        `Model Comparison`,
        `Base:    ${baseFilePath}`,
        `Revised: ${revisedFilePath}`,
        `Nodes:    ${baseNodes.length} -> ${revisedNodes.length}`,
        `Members:  ${baseMembers.length} -> ${revisedMembers.length}`,
        `Total changes detected: ${totalChanges}`,
        ``
      ];

      return {
        content: [{
          type: "text",
          text: header.join("\n") + report.join("\n")
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Tool 28: generate_load_summary
server.tool(
  "generate_load_summary",
  {
    filePath: z.string().describe("Full path to the .r3d file"),
    includeTransientLoads: z.boolean().optional().default(false)
      .describe("Include RISA-generated transient area load cases. Default false.")
  },
  async ({ filePath, includeTransientLoads = false }) => {
    try {
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

      return {
        content: [{ type: "text", text: report.join("\n") }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// -----------------------------------------------------
// TEMP DEBUG TOOLS
// Used to reverse-engineer RISA load case mapping.
// Remove after generate_load_summary,
// clone_model_with_changes,
// and load-related tools are fully validated.
// -----------------------------------------------------

// Tool 29: debug_risa_load_structure
// Temporary diagnostic helper for reverse-engineering RISA-3D load records.
// Shows raw token positions for BASIC_LOAD_CASES, NODE_LOADS,
// DIRECT_DISTRIBUTED_LOADS, AREA_LOADS, and LOAD_COMBINATIONS.
server.tool(
  "debug_risa_load_structure",
  {
    filePath: z.string().describe("Full path to the .r3d file"),
    maxRows: z.number().optional().default(10)
      .describe("Maximum rows to show per section. Default 10.")
  },
  async ({ filePath, maxRows = 10 }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const report = [];

      function debugSection(sectionName, endSectionName, rowLimit = maxRows) {
        const regex = new RegExp(`\\[${sectionName}\\] <\\d+>([\\s\\S]*?)\\[${endSectionName}\\]`);
        const match = content.match(regex);

        report.push(`\n=== ${sectionName} ===`);

        if (!match) {
          report.push("Section not found.");
          return;
        }

        const lines = match[1].trim().split("\n").filter(l => l.trim());
        report.push(`Total rows: ${lines.length}`);
        report.push(`Showing first ${Math.min(rowLimit, lines.length)} row(s)`);

        lines.slice(0, rowLimit).forEach((line, rowIndex) => {
          const tokens = tokenize(line.trim().replace(";", ""));
          report.push(`\nRow ${rowIndex + 1} raw:`);
          report.push(line.trim());

          tokens.forEach((token, i) => {
            report.push(`  [${i}] = ${cleanSemi(token)}`);
          });
        });
      }

      debugSection("BASIC_LOAD_CASES", "END_BASIC_LOAD_CASES", maxRows);
      debugSection("NODE_LOADS", "END_NODE_LOADS", maxRows);
      debugSection("DIRECT_DISTRIBUTED_LOADS", "END_DIRECT_DISTRIBUTED_LOADS", maxRows);
      debugSection("AREA_LOADS", "END_AREA_LOADS", maxRows);
      debugSection("LOAD_COMBINATIONS", "END_LOAD_COMBINATIONS", maxRows);

      return {
        content: [{
          type: "text",
          text: `RISA LOAD STRUCTURE DEBUG\nFile: ${filePath}\n` + report.join("\n")
        }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);


// Tool 30: debug_risa_load_case_counts
// Temporary diagnostic helper to compare BASIC_LOAD_CASES counts against
// actual raw load sections. Helps confirm how RISA maps visible BLC names
// to raw NODE_LOADS, DIRECT_DISTRIBUTED_LOADS, and AREA_LOADS records.
server.tool(
  "debug_risa_load_case_counts",
  {
    filePath: z.string().describe("Full path to the .r3d file")
  },
  async ({ filePath }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const blcData = parseBasicLoadCases(content);

      const sectionCount = (sectionName, endSectionName) => {
        const regex = new RegExp(`\\[${sectionName}\\] <\\d+>([\\s\\S]*?)\\[${endSectionName}\\]`);
        const match = content.match(regex);
        if (!match) return 0;
        return match[1].trim().split("\n").filter(l => l.trim()).length;
      };

      const nodeLoadCount = sectionCount("NODE_LOADS", "END_NODE_LOADS");
      const distLoadCount = sectionCount("DIRECT_DISTRIBUTED_LOADS", "END_DIRECT_DISTRIBUTED_LOADS");
      const areaLoadCount = sectionCount("AREA_LOADS", "END_AREA_LOADS");

      const report = [];

      report.push("RISA LOAD CASE COUNT DEBUG");
      report.push(`File: ${filePath}`);
      report.push("");
      report.push("Actual raw section counts:");
      report.push(`NODE_LOADS: ${nodeLoadCount}`);
      report.push(`DIRECT_DISTRIBUTED_LOADS: ${distLoadCount}`);
      report.push(`AREA_LOADS: ${areaLoadCount}`);

      report.push("\nBASIC_LOAD_CASES token breakdown:");
      report.push("BLC,Name,Field2,Field3,Field4,Field5,Field6,Field7,Field8,LastField,RawTokenCount");

      Object.values(blcData.byIndex)
        .sort((a, b) => a.index - b.index)
        .forEach(blc => {
          const t = blc.rawTokens || [];
          report.push([
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

      report.push("\nNote:");
      report.push("This tool does not decide the final mapping.");
      report.push("It shows the raw counts so we can compare RISA's visible load-case table against the .r3d sections.");

      return {
        content: [{ type: "text", text: report.join("\n") }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);


// Tool 31: debug_risa_member_load_rows
// Temporary diagnostic helper for clone_model_with_changes.
// Given a member label, shows every DIRECT_DISTRIBUTED_LOADS row that belongs
// to that member and labels each token position.
server.tool(
  "debug_risa_member_load_rows",
  {
    filePath: z.string().describe("Full path to the .r3d file"),
    memberLabel: z.string().describe("Member label to inspect, e.g. M41")
  },
  async ({ filePath, memberLabel }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const nodesOrdered = parseNodesOrdered(content);
      const members = parseMembersResolved(content, nodesOrdered);

      const memberIndex = members.findIndex(m => m.label === memberLabel) + 1;

      if (memberIndex <= 0) {
        return {
          content: [{
            type: "text",
            text: `Member "${memberLabel}" not found.`
          }]
        };
      }

      const distMatch = content.match(/\[DIRECT_DISTRIBUTED_LOADS\] <\d+>([\s\S]*?)\[END_DIRECT_DISTRIBUTED_LOADS\]/);

      if (!distMatch) {
        return {
          content: [{
            type: "text",
            text: "No DIRECT_DISTRIBUTED_LOADS section found."
          }]
        };
      }

      const lines = distMatch[1].trim().split("\n").filter(l => l.trim());
      const matched = lines.filter(line => {
        const parts = line.trim().replace(";", "").split(/\s+/);
        return parseInt(parts[0], 10) === memberIndex;
      });

      const report = [];

      report.push("RISA MEMBER LOAD ROW DEBUG");
      report.push(`File: ${filePath}`);
      report.push(`Member label: ${memberLabel}`);
      report.push(`Member positional index: ${memberIndex}`);
      report.push(`Matching distributed load rows: ${matched.length}`);

      matched.forEach((line, rowIndex) => {
        const tokens = tokenize(line.trim().replace(";", ""));

        report.push(`\nMatched Row ${rowIndex + 1} raw:`);
        report.push(line.trim());

        tokens.forEach((token, i) => {
          report.push(`  [${i}] = ${cleanSemi(token)}`);
        });
      });

      return {
        content: [{ type: "text", text: report.join("\n") }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// Tool 32: batch_replace_section_size
// Applies multiple section size replacements in one model and saves a NEW .r3d file.
// NEVER overwrites the original file.
server.tool(
  "batch_replace_section_size",
  {
    filePath: z.string().describe("Full path to the source .r3d file"),
    outputPath: z.string().describe("Full path for the new .r3d file. Must be different from source."),
    replacements: z.array(z.object({
      oldSize: z.string().describe("Current section size e.g. C15X33.9"),
      newSize: z.string().describe("Replacement section size e.g. C12X20.7"),
      scope: z.enum(["set", "member", "both"]).optional().default("both"),
      filterName: z.string().optional().describe("Optional set name or member label to limit this replacement")
    })).describe("List of section size replacements to apply")
  },
  async ({ filePath, outputPath, replacements }) => {
    try {
      if (filePath.toLowerCase() === outputPath.toLowerCase()) {
        return {
          content: [{
            type: "text",
            text: "Error: outputPath must be different from filePath. This tool never overwrites the original file."
          }]
        };
      }

      if (!replacements || replacements.length === 0) {
        return {
          content: [{
            type: "text",
            text: "Error: replacements array is empty. Provide at least one oldSize/newSize replacement."
          }]
        };
      }

      let content = fs.readFileSync(filePath, "utf8");
      const report = [];

      report.push("BATCH SECTION SIZE REPLACEMENT");
      report.push(`Source: ${filePath}`);
      report.push(`Output: ${outputPath}`);
      report.push("");

      let totalSetsChanged = 0;
      let totalMembersChanged = 0;

      for (const replacement of replacements) {
        const result = replaceSectionSizeInContent(content, replacement);

        content = result.content;
        totalSetsChanged += result.setsChanged;
        totalMembersChanged += result.membersChanged;

        report.push([
          `${replacement.oldSize} -> ${replacement.newSize}`,
          `scope=${replacement.scope || "both"}`,
          replacement.filterName ? `filter=${replacement.filterName}` : "filter=none",
          `sets=${result.setsChanged}`,
          `members=${result.membersChanged}`
        ].join(", "));
      }

      if (totalSetsChanged === 0 && totalMembersChanged === 0) {
        report.push("");
        report.push("No matching section sizes found. No file written.");

        return {
          content: [{ type: "text", text: report.join("\n") }]
        };
      }

      fs.writeFileSync(outputPath, content, "utf8");

      report.push("");
      report.push(`Total section sets changed: ${totalSetsChanged}`);
      report.push(`Total member assignments changed: ${totalMembersChanged}`);
      report.push(`Saved new model: ${outputPath}`);
      report.push(`Original unchanged: ${filePath}`);

      return {
        content: [{ type: "text", text: report.join("\n") }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// Tool 33: batch_qc_folder
// Runs QC checks across every .r3d file in a folder and writes one Excel summary.
// Read-only against models. Creates/overwrites only the specified .xlsx output file.
server.tool(
  "batch_qc_folder",
  {
    folderPath: z.string().describe("Folder containing .r3d files"),
    outputPath: z.string().describe("Full path for the Excel output file, e.g. C:\\\\Users\\\\you\\\\Desktop\\\\qc-summary.xlsx"),
    filterName: z.string().optional().describe("Optional: only include .r3d files whose file name contains this text")
  },
  async ({ folderPath, outputPath, filterName }) => {
    try {
      const XLSX = await import("xlsx");

      if (!fs.existsSync(folderPath)) {
        return { content: [{ type: "text", text: `Error: folder does not exist: ${folderPath}` }] };
      }

      let files = fs.readdirSync(folderPath)
        .filter(f => f.toLowerCase().endsWith(".r3d"));

      if (filterName) {
        const f = filterName.toLowerCase();
        files = files.filter(name => name.toLowerCase().includes(f));
      }

      if (files.length === 0) {
        return { content: [{ type: "text", text: "No .r3d files found in the folder." }] };
      }

      const rows = [];

      for (const fileName of files) {
        const filePath = path.join(folderPath, fileName);

        try {
          const content = fs.readFileSync(filePath, "utf8");
          const qc = runQCChecks(content);

          rows.push({
            File: fileName,
            Status: qc.status,
            "Issue Count": qc.issueCount,
            Nodes: qc.nodeCount,
            Members: qc.memberCount,
            "Duplicate Node Groups": qc.duplicateNodes.length,
            "Duplicate Member Labels": qc.duplicateMemberLabels.length,
            "Members Missing Section": qc.missingSize.length,
            "Zero-Length Members": qc.zeroLength.length,
            "Invalid Node References": qc.invalidNodeRefs.length,
            "Duplicate Node Details": qc.duplicateNodes.map(g => `${g.coords}: ${g.labels.join(" | ")}`).join("; "),
            "Duplicate Member Details": qc.duplicateMemberLabels.join(", "),
            "Missing Section Details": qc.missingSize.join(", "),
            "Zero-Length Details": qc.zeroLength.join(", "),
            "Invalid Node Ref Details": qc.invalidNodeRefs.join(" | ")
          });

        } catch (fileErr) {
          rows.push({
            File: fileName,
            Status: "ERROR",
            "Issue Count": "",
            Nodes: "",
            Members: "",
            "Duplicate Node Groups": "",
            "Duplicate Member Labels": "",
            "Members Missing Section": "",
            "Zero-Length Members": "",
            "Invalid Node References": "",
            "Duplicate Node Details": "",
            "Duplicate Member Details": "",
            "Missing Section Details": "",
            "Zero-Length Details": "",
            "Invalid Node Ref Details": fileErr.message
          });
        }
      }

      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(workbook, worksheet, "QC Summary");
      XLSX.writeFile(workbook, outputPath);

      const passCount = rows.filter(r => r.Status === "PASS").length;
      const reviewCount = rows.filter(r => r.Status === "REVIEW").length;
      const errorCount = rows.filter(r => r.Status === "ERROR").length;

      return {
        content: [{
          type: "text",
          text: [
            "BATCH QC FOLDER COMPLETE",
            `Folder: ${folderPath}`,
            `Files checked: ${rows.length}`,
            `PASS: ${passCount}`,
            `REVIEW: ${reviewCount}`,
            `ERROR: ${errorCount}`,
            `Excel saved to: ${outputPath}`
          ].join("\n")
        }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// Tool 34: export_load_summary_to_excel
// Exports RISA load summary to Excel with separate sheets:
// Summary, Distributed Loads, Area Loads, Node Loads.
server.tool(
  "export_load_summary_to_excel",
  {
    filePath: z.string().describe("Full path to the source .r3d file"),
    outputPath: z.string().describe("Full path for the Excel output file, e.g. C:\\\\Users\\\\you\\\\Desktop\\\\load-summary.xlsx"),
    includeTransientLoads: z.boolean().optional().default(false)
      .describe("Include RISA-generated transient area load cases. Default false.")
  },
  async ({ filePath, outputPath, includeTransientLoads = false }) => {
    try {
      const XLSX = await import("xlsx");

      const content = fs.readFileSync(filePath, "utf8");
      const nodesOrdered = parseNodesOrdered(content);
      const members = parseMembersResolved(content, nodesOrdered);
      const parsed = parseLoadsByBasicLoadCase(content);

      const summaryRows = [];
      const distributedRows = [];
      const areaRows = [];
      const nodeRows = [];

      summaryRows.push({
        Item: "File",
        Value: filePath
      });

      summaryRows.push({
        Item: "Nodes",
        Value: nodesOrdered.length
      });

      summaryRows.push({
        Item: "Members",
        Value: members.length
      });

      summaryRows.push({
        Item: "Distributed Loads Consumed",
        Value: `${parsed.totals.consumedDistributedLoads} / ${parsed.totals.distributedLoads}`
      });

      summaryRows.push({
        Item: "Area Loads Consumed",
        Value: `${parsed.totals.consumedAreaLoads} / ${parsed.totals.areaLoads}`
      });

      summaryRows.push({
        Item: "Node Loads Consumed",
        Value: `${parsed.totals.consumedNodeLoads} / ${parsed.totals.nodeLoads}`
      });

      parsed.cases.forEach(blc => {
        const isTransient = blc.name.toLowerCase().includes("transient area loads");

        summaryRows.push({
          Item: `BLC ${blc.index}: ${blc.name}`,
          Value: isTransient && !includeTransientLoads
            ? `Skipped transient loads. Distributed=${blc.distributedLoads.length}, Area=${blc.areaLoads.length}, Node=${blc.nodeLoads.length}`
            : `Distributed=${blc.distributedLoads.length}, Area=${blc.areaLoads.length}, Node=${blc.nodeLoads.length}`
        });

        if (isTransient && !includeTransientLoads) return;

        blc.distributedLoads.forEach(load => {
          const p = load.tokens;
          const memberIdx = parseInt(p[0], 10);
          const member = members[memberIdx - 1];

          distributedRows.push({
            "BLC Index": blc.index,
            "Load Case": blc.name,
            "Row": load.rowNumber,
            "Member": member ? member.label : `(idx ${memberIdx})`,
            "Member Index": memberIdx,
            "Start Magnitude": parseFloat(p[2]),
            "End Magnitude": parseFloat(p[3]),
            "Start Location": parseFloat(p[4]),
            "End Location": parseFloat(p[5]),
            "Raw ID": p[1]
          });
        });

        blc.areaLoads.forEach(load => {
          const p = load.tokens;

          const cornerLabels = [0, 1, 2, 3].map(i => {
            const node = nodesOrdered[parseInt(p[i], 10) - 1];
            return node ? node.label : `(idx ${p[i]})`;
          });

          areaRows.push({
            "BLC Index": blc.index,
            "Load Case": blc.name,
            "Row": load.rowNumber,
            "Corner 1": cornerLabels[0],
            "Corner 2": cornerLabels[1],
            "Corner 3": cornerLabels[2],
            "Corner 4": cornerLabels[3],
            "Corners": cornerLabels.join("-"),
            "Direction Code": p[5],
            "Magnitude": parseFloat(p[6]),
            "Raw ID": p[4]
          });
        });

        blc.nodeLoads.forEach(load => {
          const p = load.tokens;
          const nodeIdx = parseInt(p[0], 10);
          const node = nodesOrdered[nodeIdx - 1];

          nodeRows.push({
            "BLC Index": blc.index,
            "Load Case": blc.name,
            "Row": load.rowNumber,
            "Node": node ? node.label : `(idx ${nodeIdx})`,
            "Node Index": nodeIdx,
            "Magnitude": parseFloat(p[2]),
            "Direction Code": p[3],
            "Raw ID": p[1]
          });
        });
      });

      const workbook = XLSX.utils.book_new();

      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet(summaryRows),
        "Summary"
      );

      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet(distributedRows),
        "Distributed Loads"
      );

      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet(areaRows),
        "Area Loads"
      );

      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet(nodeRows),
        "Node Loads"
      );

      XLSX.writeFile(workbook, outputPath);

      return {
        content: [{
          type: "text",
          text: [
            "LOAD SUMMARY EXCEL EXPORT COMPLETE",
            `Source: ${filePath}`,
            `Output: ${outputPath}`,
            `Distributed load rows exported: ${distributedRows.length}`,
            `Area load rows exported: ${areaRows.length}`,
            `Node load rows exported: ${nodeRows.length}`,
            `Include transient loads: ${includeTransientLoads}`
          ].join("\n")
        }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// Tool 35: move_node
// Moves an existing node by updating its coordinates and saves a NEW .r3d file.
// Node order is preserved, so existing member connectivity stays intact.
// NEVER overwrites the original file.
server.tool(
  "move_node",
  {
    filePath: z.string().describe("Full path to the source .r3d file"),
    outputPath: z.string().describe("Full path for the new .r3d file. Must be different from source."),
    nodeLabel: z.string().describe("Existing node label to move, e.g. N44"),
    x: z.number().describe("New X coordinate"),
    y: z.number().describe("New Y coordinate"),
    z: z.number().describe("New Z coordinate")
  },
  async ({ filePath, outputPath, nodeLabel, x, y, z }) => {
    try {
      if (filePath.toLowerCase() === outputPath.toLowerCase()) {
        return {
          content: [{
            type: "text",
            text: "Error: outputPath must be different from filePath. This tool never overwrites the original file."
          }]
        };
      }

      let fileContent = fs.readFileSync(filePath, "utf8");

      const nodesMatch = fileContent.match(/(\[NODES\] <\d+>)([\s\S]*?)(\[END_NODES\])/);
      if (!nodesMatch) {
        return {
          content: [{ type: "text", text: "Error: could not find [NODES] section in file." }]
        };
      }

      function formatSciNotation(val) {
        return val.toExponential(12).replace(/e([+-])(\d+)/, (m, sign, digits) => {
          return `e${sign}${digits.padStart(2, "0")}`;
        });
      }

      const nodeLines = nodesMatch[2].split("\n");
      let found = false;
      let oldCoords = null;

      const updatedNodeLines = nodeLines.map(line => {
        if (!line.trim()) return line;

        const t = tokenize(line);
        const label = clean(t[0]);

        if (label !== nodeLabel) return line;

        found = true;

        oldCoords = {
          x: parseFloat(t[1]),
          y: parseFloat(t[2]),
          z: parseFloat(t[3])
        };

        const trailingFields = t.slice(4).join(" ").replace(/;\s*$/, "");

        return [
          t[0],
          formatSciNotation(x),
          formatSciNotation(y),
          formatSciNotation(z),
          trailingFields + ";"
        ].join("   ");
      });

      if (!found) {
        return {
          content: [{
            type: "text",
            text: `Error: node "${nodeLabel}" not found in model. Use list_nodes to see available node labels.`
          }]
        };
      }

      const updatedNodesBlock = updatedNodeLines.join("\n");
      fileContent = fileContent.replace(nodesMatch[2], updatedNodesBlock);

      fs.writeFileSync(outputPath, fileContent, "utf8");

      return {
        content: [{
          type: "text",
          text: [
            "NODE MOVED",
            `Node: ${nodeLabel}`,
            `Old coordinates: (${oldCoords.x}, ${oldCoords.y}, ${oldCoords.z})`,
            `New coordinates: (${x}, ${y}, ${z})`,
            `Saved new model: ${outputPath}`,
            `Original unchanged: ${filePath}`,
            "",
            "IMPORTANT: open the saved file in RISA-3D and confirm the moved node/model geometry before relying on this model."
          ].join("\n")
        }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// Tool 36: delete_member
// Deletes one or more existing members by label and saves a NEW .r3d file.
// Recalculates the MEMBERS_MAIN_DATA header count.
// NEVER overwrites the original file.
server.tool(
  "delete_member",
  {
    filePath: z.string().describe("Full path to the source .r3d file"),
    outputPath: z.string().describe("Full path for the new .r3d file. Must be different from source."),
    memberLabels: z.array(z.string()).describe("Member labels to delete, e.g. ['M41', 'M42']")
  },
  async ({ filePath, outputPath, memberLabels }) => {
    try {
      if (filePath.toLowerCase() === outputPath.toLowerCase()) {
        return {
          content: [{
            type: "text",
            text: "Error: outputPath must be different from filePath. This tool never overwrites the original file."
          }]
        };
      }

      if (!memberLabels || memberLabels.length === 0) {
        return {
          content: [{
            type: "text",
            text: "Error: memberLabels is empty. Provide at least one member label to delete."
          }]
        };
      }

      let fileContent = fs.readFileSync(filePath, "utf8");

      const membersMatch = fileContent.match(/(\[\.MEMBERS_MAIN_DATA\] <)(\d+)(>)([\s\S]*?)(\[\.END_MEMBERS_MAIN_DATA\])/);

      if (!membersMatch) {
        return {
          content: [{ type: "text", text: "Error: could not find [.MEMBERS_MAIN_DATA] section in file." }]
        };
      }

      const labelsToDelete = new Set(memberLabels.map(l => l.trim()));
      const membersBlockBody = membersMatch[4];
      const memberLines = membersBlockBody.split("\n");

      const deleted = [];
      const keptLines = [];

      memberLines.forEach(line => {
        if (!line.trim()) {
          keptLines.push(line);
          return;
        }

        const t = tokenize(line);
        const label = clean(t[0]);

        if (labelsToDelete.has(label)) {
          deleted.push(label);
        } else {
          keptLines.push(line);
        }
      });

      const missing = memberLabels.filter(label => !deleted.includes(label));

      if (deleted.length === 0) {
        return {
          content: [{
            type: "text",
            text: [
              "No members deleted. No file written.",
              `Requested: ${memberLabels.join(", ")}`,
              `Not found: ${missing.join(", ")}`
            ].join("\n")
          }]
        };
      }

      const nonEmptyKeptCount = keptLines.filter(l => l.trim()).length;
      const updatedMembersBody = keptLines.join("\n").replace(/\s*$/, "") + "\n";
      const updatedMembersSection =
        `${membersMatch[1]}${nonEmptyKeptCount}${membersMatch[3]}${updatedMembersBody}${membersMatch[5]}`;

      fileContent = fileContent.replace(membersMatch[0], updatedMembersSection);

      fs.writeFileSync(outputPath, fileContent, "utf8");

      return {
        content: [{
          type: "text",
          text: [
            "MEMBER DELETE COMPLETE",
            `Deleted member(s): ${deleted.join(", ")}`,
            missing.length > 0 ? `Not found / skipped: ${missing.join(", ")}` : "Not found / skipped: none",
            `Updated member count: ${nonEmptyKeptCount}`,
            `Saved new model: ${outputPath}`,
            `Original unchanged: ${filePath}`,
            "",
            "IMPORTANT: open the saved file in RISA-3D and confirm the model loads correctly before relying on it."
          ].join("\n")
        }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// Tool 37: find_connected_members
// Given a member label, shows all members connected to its i-node and j-node.
server.tool(
  "find_connected_members",
  {
    filePath: z.string().describe("Full path to the .r3d file"),
    memberLabel: z.string().describe("Member label to inspect, e.g. M142")
  },
  async ({ filePath, memberLabel }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const nodesOrdered = parseNodesOrdered(content);
      const members = parseMembersResolved(content, nodesOrdered);

      const target = members.find(m => m.label === memberLabel);

      if (!target) {
        return {
          content: [{ type: "text", text: `Error: member "${memberLabel}" not found.` }]
        };
      }

      const connectedAtINode = members
        .filter(m => m.label !== memberLabel && (m.iNode === target.iNode || m.jNode === target.iNode))
        .map(m => `${m.label} (${m.iNode} -> ${m.jNode}, ${m.size})`);

      const connectedAtJNode = members
        .filter(m => m.label !== memberLabel && (m.iNode === target.jNode || m.jNode === target.jNode))
        .map(m => `${m.label} (${m.iNode} -> ${m.jNode}, ${m.size})`);

      const report = [];

      report.push("CONNECTED MEMBER CHECK");
      report.push(`File: ${filePath}`);
      report.push(`Target member: ${target.label}`);
      report.push(`Type: ${target.type}`);
      report.push(`Size: ${target.size}`);
      report.push(`i-node: ${target.iNode}`);
      report.push(`j-node: ${target.jNode}`);

      report.push(`\nMembers connected at i-node (${target.iNode}):`);
      report.push(connectedAtINode.length > 0 ? connectedAtINode.join("\n") : "None found.");

      report.push(`\nMembers connected at j-node (${target.jNode}):`);
      report.push(connectedAtJNode.length > 0 ? connectedAtJNode.join("\n") : "None found.");

      return {
        content: [{ type: "text", text: report.join("\n") }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// Tool 38: get_member_connectivity_at_node
// Given a node label, lists every member connected to that node.
server.tool(
  "get_member_connectivity_at_node",
  {
    filePath: z.string().describe("Full path to the .r3d file"),
    nodeLabel: z.string().describe("Node label to inspect, e.g. N55")
  },
  async ({ filePath, nodeLabel }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const nodesOrdered = parseNodesOrdered(content);
      const members = parseMembersResolved(content, nodesOrdered);

      const nodeExists = nodesOrdered.some(n => n.label === nodeLabel);

      if (!nodeExists) {
        return {
          content: [{ type: "text", text: `Error: node "${nodeLabel}" not found.` }]
        };
      }

      const connectedMembers = members
        .filter(m => m.iNode === nodeLabel || m.jNode === nodeLabel)
        .map(m => ({
          label: m.label,
          type: m.type,
          size: m.size,
          iNode: m.iNode,
          jNode: m.jNode,
          end: m.iNode === nodeLabel ? "i-node" : "j-node"
        }));

      const report = [];

      report.push("MEMBER CONNECTIVITY AT NODE");
      report.push(`File: ${filePath}`);
      report.push(`Node: ${nodeLabel}`);
      report.push(`Connected member count: ${connectedMembers.length}`);

      if (connectedMembers.length === 0) {
        report.push("\nNo connected members found.");
      } else {
        report.push("\nMember,ConnectedEnd,Type,Size,iNode,jNode");

        connectedMembers.forEach(m => {
          report.push([
            m.label,
            m.end,
            m.type,
            m.size,
            m.iNode,
            m.jNode
          ].join(","));
        });
      }

      return {
        content: [{ type: "text", text: report.join("\n") }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// Tool 39: copy_member
// Copies one existing member's full field structure and reconnects it between two existing nodes.
// Saves a NEW .r3d file. NEVER overwrites the original file.
server.tool(
  "copy_member",
  {
    filePath: z.string().describe("Full path to the source .r3d file"),
    outputPath: z.string().describe("Full path for the new .r3d file. Must be different from source."),
    sourceMemberLabel: z.string().describe("Existing member label to copy, e.g. M41"),
    newMemberLabel: z.string().describe("Label for the new copied member, e.g. M999"),
    iNodeLabel: z.string().describe("Existing node label for the new member start node, e.g. N10"),
    jNodeLabel: z.string().describe("Existing node label for the new member end node, e.g. N20")
  },
  async ({ filePath, outputPath, sourceMemberLabel, newMemberLabel, iNodeLabel, jNodeLabel }) => {
    try {
      if (filePath.toLowerCase() === outputPath.toLowerCase()) {
        return {
          content: [{
            type: "text",
            text: "Error: outputPath must be different from filePath. This tool never overwrites the original file."
          }]
        };
      }

      if (iNodeLabel === jNodeLabel) {
        return {
          content: [{
            type: "text",
            text: "Error: iNodeLabel and jNodeLabel cannot be the same. A member cannot have zero length."
          }]
        };
      }

      let fileContent = fs.readFileSync(filePath, "utf8");

      const nodesOrdered = parseNodesOrdered(fileContent);
      const nodeLabelToIndex = {};
      nodesOrdered.forEach((n, i) => {
        nodeLabelToIndex[n.label] = i + 1;
      });

      const iIndex = nodeLabelToIndex[iNodeLabel];
      const jIndex = nodeLabelToIndex[jNodeLabel];

      if (!iIndex) {
        return {
          content: [{ type: "text", text: `Error: i-node "${iNodeLabel}" not found.` }]
        };
      }

      if (!jIndex) {
        return {
          content: [{ type: "text", text: `Error: j-node "${jNodeLabel}" not found.` }]
        };
      }

      const membersMatch = fileContent.match(/(\[\.MEMBERS_MAIN_DATA\] <)(\d+)(>)([\s\S]*?)(\[\.END_MEMBERS_MAIN_DATA\])/);

      if (!membersMatch) {
        return {
          content: [{ type: "text", text: "Error: could not find [.MEMBERS_MAIN_DATA] section in file." }]
        };
      }

      const membersBlockBody = membersMatch[4];
      const memberLines = membersBlockBody.split("\n").filter(l => l.trim());

      let sourceLine = null;
      const existingMemberLabels = new Set();

      memberLines.forEach(line => {
        const t = tokenize(line);
        const label = clean(t[0]);
        existingMemberLabels.add(label);

        if (label === sourceMemberLabel) {
          sourceLine = line;
        }
      });

      if (!sourceLine) {
        return {
          content: [{ type: "text", text: `Error: source member "${sourceMemberLabel}" not found.` }]
        };
      }

      if (existingMemberLabels.has(newMemberLabel)) {
        return {
          content: [{ type: "text", text: `Error: new member label "${newMemberLabel}" already exists in the model.` }]
        };
      }

      const sourceTokens = tokenize(sourceLine);

      if (sourceTokens.length < 5) {
        return {
          content: [{ type: "text", text: `Error: source member "${sourceMemberLabel}" line could not be parsed safely.` }]
        };
      }

      const newTokens = [...sourceTokens];

      newTokens[0] = `"${padRISA(newMemberLabel)}"`;
      newTokens[3] = String(iIndex);
      newTokens[4] = String(jIndex);

      const newMemberLine = newTokens.join(" ");

      const updatedMembersBody =
        membersBlockBody.replace(/\s*$/, "") +
        "\n" +
        newMemberLine +
        "\n";

      const newMemberCount = memberLines.length + 1;

      const updatedMembersSection =
        `${membersMatch[1]}${newMemberCount}${membersMatch[3]}${updatedMembersBody}${membersMatch[5]}`;

      fileContent = fileContent.replace(membersMatch[0], updatedMembersSection);

      fs.writeFileSync(outputPath, fileContent, "utf8");

      return {
        content: [{
          type: "text",
          text: [
            "MEMBER COPY COMPLETE",
            `Source member: ${sourceMemberLabel}`,
            `New member: ${newMemberLabel}`,
            `Copied type: ${clean(sourceTokens[1])}`,
            `Copied size: ${clean(sourceTokens[2])}`,
            `New connectivity: ${iNodeLabel} (idx ${iIndex}) -> ${jNodeLabel} (idx ${jIndex})`,
            `Updated member count: ${newMemberCount}`,
            `Saved new model: ${outputPath}`,
            `Original unchanged: ${filePath}`,
            "",
            "IMPORTANT: open the saved file in RISA-3D and confirm the copied member appears correctly before relying on this model."
          ].join("\n")
        }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }]
      };
    }
  }
);

// Tool 40: split_member
// Splits one existing member into two members by inserting a new node along its length.
// Keeps the original member label for the first segment and creates a new member for the second segment.
// Saves a NEW .r3d file. NEVER overwrites the original file.
server.tool(
  "split_member",
  {
    filePath: z.string().describe("Full path to the source .r3d file"),
    outputPath: z.string().describe("Full path for the new .r3d file. Must be different from source."),
    memberLabel: z.string().describe("Existing member label to split, e.g. M41"),
    splitFraction: z.number().describe("Fraction along member length where split occurs. Use 0.5 for midpoint."),
    newNodeLabel: z.string().optional().describe("Optional label for inserted node. If omitted, an unused label is generated."),
    newSecondMemberLabel: z.string().optional().describe("Optional label for second member. If omitted, an unused label is generated.")
  },
  async ({ filePath, outputPath, memberLabel, splitFraction, newNodeLabel, newSecondMemberLabel }) => {
    try {
      if (filePath.toLowerCase() === outputPath.toLowerCase()) {
        return { content: [{ type: "text", text: "Error: outputPath must be different from filePath. This tool never overwrites the original file." }] };
      }

      if (splitFraction <= 0 || splitFraction >= 1) {
        return { content: [{ type: "text", text: "Error: splitFraction must be between 0 and 1, for example 0.5 for midpoint." }] };
      }

      let fileContent = fs.readFileSync(filePath, "utf8");

      const nodesOrdered = parseNodesOrdered(fileContent);
      const members = parseMembersResolved(fileContent, nodesOrdered);
      const target = members.find(m => m.label === memberLabel);

      if (!target) {
        return { content: [{ type: "text", text: `Error: member "${memberLabel}" not found.` }] };
      }

      if (!target.iCoord || !target.jCoord) {
        return { content: [{ type: "text", text: `Error: member "${memberLabel}" has invalid node references and cannot be split.` }] };
      }

      const newX = target.iCoord.x + (target.jCoord.x - target.iCoord.x) * splitFraction;
      const newY = target.iCoord.y + (target.jCoord.y - target.iCoord.y) * splitFraction;
      const newZ = target.iCoord.z + (target.jCoord.z - target.iCoord.z) * splitFraction;

      const nodesMatch = fileContent.match(/(\[NODES\] <)(\d+)(>)([\s\S]*?)(\[END_NODES\])/);
      if (!nodesMatch) {
        return { content: [{ type: "text", text: "Error: could not find [NODES] section in file." }] };
      }

      const nodesBlockBody = nodesMatch[4];
      const nodeLines = nodesBlockBody.split("\n").filter(l => l.trim());
      const existingNodeLabels = new Set(nodeLines.map(line => clean(tokenize(line)[0])));

      function generateUnusedNodeLabel(usedSet) {
        let n = 9001;
        while (usedSet.has(`N${n}`)) n++;
        return `N${n}`;
      }

      const insertedNodeLabel = newNodeLabel || generateUnusedNodeLabel(existingNodeLabels);

      if (existingNodeLabels.has(insertedNodeLabel)) {
        return { content: [{ type: "text", text: `Error: node label "${insertedNodeLabel}" already exists.` }] };
      }

      const newNodeIndex = nodeLines.length + 1;

      const lastNodeLine = nodeLines[nodeLines.length - 1];
      const lastNodeTokens = tokenize(lastNodeLine);
      const trailingNodeFields = lastNodeTokens.slice(4).join(" ").replace(/;\s*$/, "");

      function formatSciNotation(val) {
        return val.toExponential(12).replace(/e([+-])(\d+)/, (m, sign, digits) => {
          return `e${sign}${digits.padStart(2, "0")}`;
        });
      }

      const newNodeLine =
        `"${padRISA(insertedNodeLabel)}"   ` +
        `${formatSciNotation(newX)}   ` +
        `${formatSciNotation(newY)}   ` +
        `${formatSciNotation(newZ)}   ` +
        `${trailingNodeFields};`;

      const updatedNodesBody =
        nodesBlockBody.replace(/\s*$/, "") +
        "\n" +
        newNodeLine +
        "\n";

      const updatedNodesSection =
        `${nodesMatch[1]}${newNodeIndex}${nodesMatch[3]}${updatedNodesBody}${nodesMatch[5]}`;

      fileContent = fileContent.replace(nodesMatch[0], updatedNodesSection);

      const membersMatch = fileContent.match(/(\[\.MEMBERS_MAIN_DATA\] <)(\d+)(>)([\s\S]*?)(\[\.END_MEMBERS_MAIN_DATA\])/);
      if (!membersMatch) {
        return { content: [{ type: "text", text: "Error: could not find [.MEMBERS_MAIN_DATA] section in file." }] };
      }

      const membersBlockBody = membersMatch[4];
      const memberLines = membersBlockBody.split("\n").filter(l => l.trim());

      const existingMemberLabels = new Set(memberLines.map(line => clean(tokenize(line)[0])));

      function generateUnusedMemberLabel(usedSet) {
        let n = 9001;
        while (usedSet.has(`M${n}`)) n++;
        return `M${n}`;
      }

      const secondMemberLabel = newSecondMemberLabel || generateUnusedMemberLabel(existingMemberLabels);

      if (existingMemberLabels.has(secondMemberLabel)) {
        return { content: [{ type: "text", text: `Error: member label "${secondMemberLabel}" already exists.` }] };
      }

      let sourceLineFound = false;
      let secondMemberLine = null;

      const updatedMemberLines = memberLines.map(line => {
        const t = tokenize(line);
        const label = clean(t[0]);

        if (label !== memberLabel) return line;

        sourceLineFound = true;

        const firstTokens = [...t];
        firstTokens[4] = String(newNodeIndex);

        const secondTokens = [...t];
        secondTokens[0] = `"${padRISA(secondMemberLabel)}"`;
        secondTokens[3] = String(newNodeIndex);
        secondTokens[4] = String(target.jNodeIndex);

        secondMemberLine = secondTokens.join(" ");

        return firstTokens.join(" ");
      });

      if (!sourceLineFound || !secondMemberLine) {
        return { content: [{ type: "text", text: `Error: could not safely rewrite member "${memberLabel}".` }] };
      }

      updatedMemberLines.push(secondMemberLine);

      const newMemberCount = updatedMemberLines.length;
      const updatedMembersBody = updatedMemberLines.join("\n") + "\n";

      const updatedMembersSection =
        `${membersMatch[1]}${newMemberCount}${membersMatch[3]}${updatedMembersBody}${membersMatch[5]}`;

      fileContent = fileContent.replace(membersMatch[0], updatedMembersSection);

      fs.writeFileSync(outputPath, fileContent, "utf8");

      return {
        content: [{
          type: "text",
          text: [
            "MEMBER SPLIT COMPLETE",
            `Original member: ${memberLabel}`,
            `First segment: ${memberLabel} (${target.iNode} -> ${insertedNodeLabel})`,
            `Second segment: ${secondMemberLabel} (${insertedNodeLabel} -> ${target.jNode})`,
            `Inserted node: ${insertedNodeLabel} at (${newX}, ${newY}, ${newZ})`,
            `Split fraction: ${splitFraction}`,
            `Updated node count: ${newNodeIndex}`,
            `Updated member count: ${newMemberCount}`,
            `Saved new model: ${outputPath}`,
            `Original unchanged: ${filePath}`,
            "",
            "IMPORTANT: open the saved file in RISA-3D and confirm the split member appears correctly before relying on this model."
          ].join("\n")
        }]
      };

    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Tool 41: merge_members
// Merges two collinear-ish members that share one common node into one member.
// Keeps the first member label, deletes the second member.
// Saves a NEW .r3d file. NEVER overwrites the original file.
server.tool(
  "merge_members",
  {
    filePath: z.string().describe("Full path to the source .r3d file"),
    outputPath: z.string().describe("Full path for the new .r3d file. Must be different from source."),
    memberLabel1: z.string().describe("First member label, e.g. M41. This label is kept."),
    memberLabel2: z.string().describe("Second member label, e.g. M42. This member is deleted.")
  },
  async ({ filePath, outputPath, memberLabel1, memberLabel2 }) => {
    try {
      if (filePath.toLowerCase() === outputPath.toLowerCase()) {
        return { content: [{ type: "text", text: "Error: outputPath must be different from filePath. This tool never overwrites the original file." }] };
      }

      if (memberLabel1 === memberLabel2) {
        return { content: [{ type: "text", text: "Error: memberLabel1 and memberLabel2 cannot be the same." }] };
      }

      let fileContent = fs.readFileSync(filePath, "utf8");
      const nodesOrdered = parseNodesOrdered(fileContent);
      const members = parseMembersResolved(fileContent, nodesOrdered);

      const m1 = members.find(m => m.label === memberLabel1);
      const m2 = members.find(m => m.label === memberLabel2);

      if (!m1) {
        return { content: [{ type: "text", text: `Error: member "${memberLabel1}" not found.` }] };
      }

      if (!m2) {
        return { content: [{ type: "text", text: `Error: member "${memberLabel2}" not found.` }] };
      }

      if (m1.type !== m2.type) {
        return { content: [{ type: "text", text: `Error: members have different types: ${memberLabel1}=${m1.type}, ${memberLabel2}=${m2.type}.` }] };
      }

      if (m1.size !== m2.size) {
        return { content: [{ type: "text", text: `Error: members have different sizes: ${memberLabel1}=${m1.size}, ${memberLabel2}=${m2.size}.` }] };
      }

      const m1Nodes = [
        { label: m1.iNode, index: m1.iNodeIndex },
        { label: m1.jNode, index: m1.jNodeIndex }
      ];

      const m2Nodes = [
        { label: m2.iNode, index: m2.iNodeIndex },
        { label: m2.jNode, index: m2.jNodeIndex }
      ];

      const common = m1Nodes.filter(a => m2Nodes.some(b => b.label === a.label));

      if (common.length !== 1) {
        return {
          content: [{
            type: "text",
            text: `Error: members must share exactly one common node. Found ${common.length} common node(s).`
          }]
        };
      }

      const commonNode = common[0];

      const outer1 = m1Nodes.find(n => n.label !== commonNode.label);
      const outer2 = m2Nodes.find(n => n.label !== commonNode.label);

      if (!outer1 || !outer2) {
        return {
          content: [{
            type: "text",
            text: "Error: could not determine outer nodes for merged member."
          }]
        };
      }

      if (outer1.label === outer2.label) {
        return {
          content: [{
            type: "text",
            text: "Error: merge would create a zero-length member because outer nodes are the same."
          }]
        };
      }

      const membersMatch = fileContent.match(/(\[\.MEMBERS_MAIN_DATA\] <)(\d+)(>)([\s\S]*?)(\[\.END_MEMBERS_MAIN_DATA\])/);

      if (!membersMatch) {
        return {
          content: [{ type: "text", text: "Error: could not find [.MEMBERS_MAIN_DATA] section in file." }]
        };
      }

      const membersBlockBody = membersMatch[4];
      const memberLines = membersBlockBody.split("\n").filter(l => l.trim());

      let updatedM1 = false;
      let deletedM2 = false;

      const updatedMemberLines = [];

      memberLines.forEach(line => {
        const t = tokenize(line);
        const label = clean(t[0]);

        if (label === memberLabel2) {
          deletedM2 = true;
          return;
        }

        if (label === memberLabel1) {
          const newTokens = [...t];
          newTokens[3] = String(outer1.index);
          newTokens[4] = String(outer2.index);
          updatedMemberLines.push(newTokens.join(" "));
          updatedM1 = true;
          return;
        }

        updatedMemberLines.push(line);
      });

      if (!updatedM1 || !deletedM2) {
        return {
          content: [{
            type: "text",
            text: "Error: could not safely update/delete member lines."
          }]
        };
      }

      const newMemberCount = updatedMemberLines.length;
      const updatedMembersBody = updatedMemberLines.join("\n") + "\n";

      const updatedMembersSection =
        `${membersMatch[1]}${newMemberCount}${membersMatch[3]}${updatedMembersBody}${membersMatch[5]}`;

      fileContent = fileContent.replace(membersMatch[0], updatedMembersSection);

      fs.writeFileSync(outputPath, fileContent, "utf8");

      return {
        content: [{
          type: "text",
          text: [
            "MEMBER MERGE COMPLETE",
            `Kept member: ${memberLabel1}`,
            `Deleted member: ${memberLabel2}`,
            `Type: ${m1.type}`,
            `Size: ${m1.size}`,
            `Common node removed from connectivity: ${commonNode.label}`,
            `New connectivity: ${outer1.label} (idx ${outer1.index}) -> ${outer2.label} (idx ${outer2.index})`,
            `Updated member count: ${newMemberCount}`,
            `Saved new model: ${outputPath}`,
            `Original unchanged: ${filePath}`,
            "",
            "IMPORTANT: open the saved file in RISA-3D and confirm the merged member appears correctly before relying on this model."
          ].join("\n")
        }]
      };

    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Tool 42: mirror_geometry
// Mirrors selected members by creating mirrored copies.
// Creates/reuses nodes at mirrored coordinates. Saves a NEW .r3d file.
server.tool(
  "mirror_geometry",
  {
    filePath: z.string(),
    outputPath: z.string(),
    memberLabels: z.array(z.string()),
    mirrorPlane: z.enum(["XY", "YZ", "XZ"]).describe("XY mirrors Z, YZ mirrors X, XZ mirrors Y"),
    mirrorAt: z.number().optional().default(0),
    tolerance: z.number().optional().default(0.001)
  },
  async ({ filePath, outputPath, memberLabels, mirrorPlane, mirrorAt = 0, tolerance = 0.001 }) => {
    try {
      if (filePath.toLowerCase() === outputPath.toLowerCase()) {
        return { content: [{ type: "text", text: "Error: outputPath must be different from filePath." }] };
      }

      let fileContent = fs.readFileSync(filePath, "utf8");

      const nodesSection = getNodesSection(fileContent);
      const membersSection = getMembersSection(fileContent);

      if (!nodesSection) return { content: [{ type: "text", text: "Error: [NODES] section not found." }] };
      if (!membersSection) return { content: [{ type: "text", text: "Error: [.MEMBERS_MAIN_DATA] section not found." }] };

      const nodesOrdered = parseNodesOrdered(fileContent);
      const members = parseMembersResolved(fileContent, nodesOrdered);

      const selectedMembers = members.filter(m => memberLabels.includes(m.label));
      const missingMembers = memberLabels.filter(label => !selectedMembers.some(m => m.label === label));

      if (selectedMembers.length === 0) {
        return { content: [{ type: "text", text: "Error: none of the requested members were found." }] };
      }

      const existingNodeLabels = new Set(nodesSection.lines.map(line => clean(tokenize(line)[0])));
      const existingMemberLabels = new Set(membersSection.lines.map(line => clean(tokenize(line)[0])));

      const trailingNodeFields = getTrailingNodeFields(nodesSection.lines);
      const workingNodes = nodesOrdered.map((n, i) => ({ ...n, index: i + 1 }));

      const newNodeLines = [];
      const newMemberLines = [];
      const report = [];

      function mirrorCoord(coord) {
        const c = { ...coord };

        if (mirrorPlane === "YZ") c.x = 2 * mirrorAt - c.x;
        if (mirrorPlane === "XZ") c.y = 2 * mirrorAt - c.y;
        if (mirrorPlane === "XY") c.z = 2 * mirrorAt - c.z;

        return c;
      }

      for (const m of selectedMembers) {
        const sourceLine = membersSection.lines.find(line => clean(tokenize(line)[0]) === m.label);
        if (!sourceLine) continue;

        const mirroredI = mirrorCoord(m.iCoord);
        const mirroredJ = mirrorCoord(m.jCoord);

        const newIIndex = findOrCreateNodeForGeometry({
          coord: mirroredI,
          workingNodes,
          existingNodeLabels,
          newNodeLines,
          trailingNodeFields,
          tolerance
        });

        const newJIndex = findOrCreateNodeForGeometry({
          coord: mirroredJ,
          workingNodes,
          existingNodeLabels,
          newNodeLines,
          trailingNodeFields,
          tolerance
        });

        if (newIIndex === newJIndex) {
          report.push(`Skipped ${m.label}: mirrored member would be zero length.`);
          continue;
        }

        const t = tokenize(sourceLine);
        const newLabel = generateUnusedLabel("M", existingMemberLabels);

        t[0] = `"${padRISA(newLabel)}"`;
        t[3] = String(newIIndex);
        t[4] = String(newJIndex);

        newMemberLines.push(t.join(" "));
        report.push(`${m.label} copied as ${newLabel}`);
      }

      if (newMemberLines.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No mirrored members created. No file written.\n" + report.join("\n")
          }]
        };
      }

      const updatedNodeLines = [...nodesSection.lines, ...newNodeLines];
      const updatedMemberLines = [...membersSection.lines, ...newMemberLines];

      const updatedNodesSection = rebuildNodesSection(nodesSection.match, updatedNodeLines);
      const updatedMembersSection = rebuildMembersSection(membersSection.match, updatedMemberLines);

      fileContent = fileContent.replace(nodesSection.match[0], updatedNodesSection);
      fileContent = fileContent.replace(membersSection.match[0], updatedMembersSection);

      fs.writeFileSync(outputPath, fileContent, "utf8");

      return {
        content: [{
          type: "text",
          text: [
            "MIRROR GEOMETRY COMPLETE",
            `Mirror plane: ${mirrorPlane}`,
            `Mirror at: ${mirrorAt}`,
            `Members copied: ${newMemberLines.length}`,
            `New nodes created: ${newNodeLines.length}`,
            missingMembers.length ? `Missing members skipped: ${missingMembers.join(", ")}` : "Missing members skipped: none",
            `Saved new model: ${outputPath}`,
            `Original unchanged: ${filePath}`,
            "",
            report.join("\n"),
            "",
            "IMPORTANT: open the saved file in RISA-3D and verify geometry before relying on this model."
          ].join("\n")
        }]
      };

    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Tool 43: copy_translate_geometry
// Copies selected members and translates the copied geometry by dx/dy/dz.
// Reuses existing nodes if matching coordinates are found within tolerance.
// Saves a NEW .r3d file. NEVER overwrites original.
server.tool(
  "copy_translate_geometry",
  {
    filePath: z.string(),
    outputPath: z.string(),
    memberLabels: z.array(z.string()),
    dx: z.number().describe("Translation in X"),
    dy: z.number().describe("Translation in Y"),
    dz: z.number().describe("Translation in Z"),
    tolerance: z.number().optional().default(0.001)
  },
  async ({ filePath, outputPath, memberLabels, dx, dy, dz, tolerance = 0.001 }) => {
    try {
      if (filePath.toLowerCase() === outputPath.toLowerCase()) {
        return { content: [{ type: "text", text: "Error: outputPath must be different from filePath." }] };
      }

      let fileContent = fs.readFileSync(filePath, "utf8");

      const nodesSection = getNodesSection(fileContent);
      const membersSection = getMembersSection(fileContent);

      if (!nodesSection) return { content: [{ type: "text", text: "Error: [NODES] section not found." }] };
      if (!membersSection) return { content: [{ type: "text", text: "Error: [.MEMBERS_MAIN_DATA] section not found." }] };

      const nodesOrdered = parseNodesOrdered(fileContent);
      const members = parseMembersResolved(fileContent, nodesOrdered);

      const selectedMembers = members.filter(m => memberLabels.includes(m.label));
      const missingMembers = memberLabels.filter(label => !selectedMembers.some(m => m.label === label));

      if (selectedMembers.length === 0) {
        return { content: [{ type: "text", text: "Error: none of the requested members were found." }] };
      }

      const existingNodeLabels = new Set(nodesSection.lines.map(line => clean(tokenize(line)[0])));
      const existingMemberLabels = new Set(membersSection.lines.map(line => clean(tokenize(line)[0])));

      const trailingNodeFields = getTrailingNodeFields(nodesSection.lines);
      const workingNodes = nodesOrdered.map((n, i) => ({ ...n, index: i + 1 }));

      const newNodeLines = [];
      const newMemberLines = [];
      const report = [];

      function translateCoord(coord) {
        return {
          x: coord.x + dx,
          y: coord.y + dy,
          z: coord.z + dz
        };
      }

      for (const m of selectedMembers) {
        const sourceLine = membersSection.lines.find(line => clean(tokenize(line)[0]) === m.label);
        if (!sourceLine) continue;

        const translatedI = translateCoord(m.iCoord);
        const translatedJ = translateCoord(m.jCoord);

        const newIIndex = findOrCreateNodeForGeometry({
          coord: translatedI,
          workingNodes,
          existingNodeLabels,
          newNodeLines,
          trailingNodeFields,
          tolerance
        });

        const newJIndex = findOrCreateNodeForGeometry({
          coord: translatedJ,
          workingNodes,
          existingNodeLabels,
          newNodeLines,
          trailingNodeFields,
          tolerance
        });

        if (newIIndex === newJIndex) {
          report.push(`Skipped ${m.label}: translated member would be zero length.`);
          continue;
        }

        const t = tokenize(sourceLine);
        const newLabel = generateUnusedLabel("M", existingMemberLabels);

        t[0] = `"${padRISA(newLabel)}"`;
        t[3] = String(newIIndex);
        t[4] = String(newJIndex);

        newMemberLines.push(t.join(" "));
        report.push(`${m.label} copied as ${newLabel}`);
      }

      if (newMemberLines.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No translated members created. No file written.\n" + report.join("\n")
          }]
        };
      }

      const updatedNodeLines = [...nodesSection.lines, ...newNodeLines];
      const updatedMemberLines = [...membersSection.lines, ...newMemberLines];

      const updatedNodesSection = rebuildNodesSection(nodesSection.match, updatedNodeLines);
      const updatedMembersSection = rebuildMembersSection(membersSection.match, updatedMemberLines);

      fileContent = fileContent.replace(nodesSection.match[0], updatedNodesSection);
      fileContent = fileContent.replace(membersSection.match[0], updatedMembersSection);

      fs.writeFileSync(outputPath, fileContent, "utf8");

      return {
        content: [{
          type: "text",
          text: [
            "COPY / TRANSLATE GEOMETRY COMPLETE",
            `Translation: dx=${dx}, dy=${dy}, dz=${dz}`,
            `Members copied: ${newMemberLines.length}`,
            `New nodes created: ${newNodeLines.length}`,
            missingMembers.length ? `Missing members skipped: ${missingMembers.join(", ")}` : "Missing members skipped: none",
            `Saved new model: ${outputPath}`,
            `Original unchanged: ${filePath}`,
            "",
            report.join("\n"),
            "",
            "IMPORTANT: open the saved file in RISA-3D and verify geometry before relying on this model."
          ].join("\n")
        }]
      };

    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);