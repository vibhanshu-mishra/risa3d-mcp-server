import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";

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
      const lines = content.split("\n");

      // Extract key info
      const nodeMatch = content.match(/\[NODES\] <(\d+)>/);
      const memberMatch = content.match(/\[MEMBERS_MAIN_DATA\] <(\d+)>/);
      const plateMatch = content.match(/\[PLATES\] <(\d+)>/);

      // Get project description
      const titleMatch = content.match(/\[\.\.MODEL_TITLE\] <1>\s*\n([^\n]+)/);
      const companyMatch = content.match(/\[\.\.COMPANY_NAME\] <1>\s*\n([^\n]+)/);
      const designerMatch = content.match(/\[\.\.DESIGNER_NAME\] <1>\s*\n([^\n]+)/);

      const summary = {
        title: titleMatch ? titleMatch[1].trim() : "Unknown",
        company: companyMatch ? companyMatch[1].trim() : "Unknown",
        designer: designerMatch ? designerMatch[1].trim() : "Unknown",
        nodeCount: nodeMatch ? parseInt(nodeMatch[1]) : 0,
        memberCount: memberMatch ? parseInt(memberMatch[1]) : 0,
        plateCount: plateMatch ? parseInt(plateMatch[1]) : 0,
        fileSizeKB: Math.round(fs.statSync(filePath).size / 1024)
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(summary, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error reading file: ${err.message}` }]
      };
    }
  }
);

// Tool 2: List all members in a .r3d file
server.tool(
  "list_members",
  { filePath: z.string().describe("Full path to the .r3d file") },
  async ({ filePath }) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");

      const membersMatch = content.match(/\[\.MEMBERS_MAIN_DATA\] <\d+>([\s\S]*?)\[\.END_MEMBERS_MAIN_DATA\]/);
      if (!membersMatch) {
        return { content: [{ type: "text", text: "No members found in this file." }] };
      }

      const memberLines = membersMatch[1].trim().split("\n").filter(l => l.trim());
      const members = memberLines.map(line => {
        const parts = line.trim().split(/\s+/);
        return {
          label: parts[0]?.replace(/"/g, ""),
          iNode: parts[1],
          jNode: parts[2],
          shape: parts[3]?.replace(/"/g, "")
        };
      });

      return {
        content: [{
          type: "text",
          text: `Found ${members.length} members:\n` + JSON.stringify(members, null, 2)
        }]
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

      const nodesMatch = content.match(/\[NODES\] <\d+>([\s\S]*?)\[END_NODES\]/);
      if (!nodesMatch) {
        return { content: [{ type: "text", text: "No nodes found in this file." }] };
      }

      const nodeLines = nodesMatch[1].trim().split("\n").filter(l => l.trim());
      const nodes = nodeLines.map(line => {
        const parts = line.trim().split(/\s+/);
        return {
          label: parts[0]?.replace(/"/g, ""),
          x: parseFloat(parts[1]),
          y: parseFloat(parts[2]),
          z: parseFloat(parts[3])
        };
      });

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
      return {
        content: [{
          type: "text",
          text: `Found ${lcLines.length} load combinations:\n` + lcLines.join("\n")
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
      const regex = new RegExp(`\\[${sectionName}\\][\\s\\S]*?\\[END_${sectionName}\\]`);
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

const transport = new StdioServerTransport();
await server.connect(transport);