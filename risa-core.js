// risa-core.js
// Shared RISA-3D parsing helpers used by both index.js and risa-cli.js.

// Quote-aware tokenizer: treats anything inside "..." as a single token.
export function tokenize(line) {
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

export function clean(token) {
  return (token || "").replace(/"/g, "").trim();
}

export function cleanSemi(value) {
  return String(value || "").replace(";", "").trim();
}

export function parseBasicLoadCases(content) {
  const blcMatch = content.match(/\[BASIC_LOAD_CASES\] <\d+>([\s\S]*?)\[END_BASIC_LOAD_CASES\]/);
  const byIndex = {};

  if (!blcMatch) return { byIndex };

  blcMatch[1].trim().split("\n").filter(l => l.trim()).forEach(line => {
    const t = tokenize(line);
    const index = parseInt(t[0], 10);
    const name = clean(t[1]);

    if (!isNaN(index) && name) {
      byIndex[index] = {
        index,
        name,
        rawTokens: t
      };
    }
  });

  return { byIndex };
}

export function getBasicLoadCaseName(blcData, index) {
  const id = parseInt(index, 10);
  return blcData.byIndex[id]?.name || `BLC${id}`;
}

export function buildBasicLoadCaseHelpers(content) {
  const blcData = parseBasicLoadCases(content);

  const byIndex = blcData.byIndex;
  const ordered = Object.values(byIndex).sort((a, b) => a.index - b.index);

  const nameByIndex = (idx) => {
    const n = parseInt(cleanSemi(idx), 10);
    return byIndex[n]?.name || `BLC${n}`;
  };

  const areaLoadCaseByRowIndex = (rowIndex) => {
    let cursor = 0;

    for (const blc of ordered) {
      const t = blc.rawTokens || [];
      const areaCount = parseInt(cleanSemi(t[6]), 10) || 0;

      if (rowIndex >= cursor && rowIndex < cursor + areaCount) {
        return blc.name;
      }

      cursor += areaCount;
    }

    return "Unresolved";
  };

  return { nameByIndex, areaLoadCaseByRowIndex };
}

export function getSectionLines(content, sectionName, endSectionName) {
  const regex = new RegExp(`\\[${sectionName}\\] <\\d+>([\\s\\S]*?)\\[${endSectionName}\\]`);
  const match = content.match(regex);
  if (!match) return [];
  return match[1].trim().split("\n").filter(l => l.trim());
}

function buildLoadRows(lines, cursor, count) {
  return lines.slice(cursor, cursor + count).map((line, i) => ({
    rowNumber: cursor + i + 1,
    tokens: tokenize(line.trim().replace(/;\s*$/, "")),
    raw: line.trim()
  }));
}

export function parseLoadsByBasicLoadCase(content) {
  const blcData = parseBasicLoadCases(content);

  const nodeLines = getSectionLines(content, "NODE_LOADS", "END_NODE_LOADS");
  const distLines = getSectionLines(content, "DIRECT_DISTRIBUTED_LOADS", "END_DIRECT_DISTRIBUTED_LOADS");
  const areaLines = getSectionLines(content, "AREA_LOADS", "END_AREA_LOADS");

  let nodeCursor = 0;
  let distCursor = 0;
  let areaCursor = 0;

  const cases = Object.values(blcData.byIndex)
    .sort((a, b) => a.index - b.index)
    .map(blc => {
      const t = blc.rawTokens || [];

      const nodeCount = parseInt(cleanSemi(t[2]), 10) || 0;
      const distCount = parseInt(cleanSemi(t[5]), 10) || 0;
      const areaCount = parseInt(cleanSemi(t[6]), 10) || 0;

      const nodeLoads = buildLoadRows(nodeLines, nodeCursor, nodeCount);
      const distributedLoads = buildLoadRows(distLines, distCursor, distCount);
      const areaLoads = buildLoadRows(areaLines, areaCursor, areaCount);

      nodeCursor += nodeCount;
      distCursor += distCount;
      areaCursor += areaCount;

      return {
        index: blc.index,
        name: blc.name,
        nodeLoads,
        distributedLoads,
        areaLoads
      };
    });

  return {
    cases,
    totals: {
      nodeLoads: nodeLines.length,
      distributedLoads: distLines.length,
      areaLoads: areaLines.length,
      consumedNodeLoads: nodeCursor,
      consumedDistributedLoads: distCursor,
      consumedAreaLoads: areaCursor
    }
  };
}

export function parseNodesOrdered(content) {
  const match = content.match(/\[NODES\] <\d+>([\s\S]*?)\[END_NODES\]/);
  if (!match) return [];

  return match[1].trim().split("\n").filter(l => l.trim()).map(line => {
    const t = tokenize(line);
    return {
      label: clean(t[0]),
      x: parseFloat(t[1]),
      y: parseFloat(t[2]),
      z: parseFloat(t[3])
    };
  });
}

export function parseMembersResolved(content, nodesOrdered) {
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
      label,
      type,
      size,
      iNodeIndex: iIdx,
      jNodeIndex: jIdx,
      iNode: iNodeObj ? iNodeObj.label : null,
      jNode: jNodeObj ? jNodeObj.label : null,
      iCoord: iNodeObj || null,
      jCoord: jNodeObj || null
    };
  });
}

export function distance3D(a, b) {
  if (!a || !b) return null;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;

  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function replaceQuotedToken(line, oldValue, newValue) {
  const oldQuotedRegex = new RegExp(`"${oldValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*"`, "i");

  if (oldQuotedRegex.test(line)) {
    return line.replace(oldQuotedRegex, `"${newValue.padEnd(oldValue.length, " ")}"`);
  }

  return line;
}

export function replaceSectionSizeInContent(content, replacement) {
  const oldSize = replacement.oldSize;
  const newSize = replacement.newSize;
  const scope = replacement.scope || "both";
  const filterName = replacement.filterName;

  let updatedContent = content;
  let setsChanged = 0;
  let membersChanged = 0;

  if (scope === "set" || scope === "both") {
    const setsMatch = updatedContent.match(/(\[\.HR_STEEL_SECTION_SETS\] <\d+>)([\s\S]*?)(\[\.END_HR_STEEL_SECTION_SETS\])/);

    if (setsMatch) {
      const newBlock = setsMatch[2].split("\n").map(line => {
        if (!line.trim()) return line;

        const t = tokenize(line);
        if (!t || t.length < 3) return line;

        if (filterName && clean(t[0]) !== filterName) return line;

        if (clean(t[2]).toUpperCase() === oldSize.toUpperCase()) {
          setsChanged++;
          return replaceQuotedToken(line, clean(t[2]), newSize);
        }

        return line;
      }).join("\n");

      updatedContent = updatedContent.replace(setsMatch[2], newBlock);
    }
  }

  if (scope === "member" || scope === "both") {
    const membersMatch = updatedContent.match(/(\[\.MEMBERS_MAIN_DATA\] <\d+>)([\s\S]*?)(\[\.END_MEMBERS_MAIN_DATA\])/);

    if (membersMatch) {
      const newBlock = membersMatch[2].split("\n").map(line => {
        if (!line.trim()) return line;

        const t = tokenize(line);
        if (!t || t.length < 3) return line;

        if (filterName && clean(t[0]) !== filterName) return line;

        if (clean(t[2]).toUpperCase() === oldSize.toUpperCase()) {
          membersChanged++;
          return replaceQuotedToken(line, clean(t[2]), newSize);
        }

        return line;
      }).join("\n");

      updatedContent = updatedContent.replace(membersMatch[2], newBlock);
    }
  }

  return {
    content: updatedContent,
    setsChanged,
    membersChanged
  };
}

export function runQCChecks(content) {
  const nodesOrdered = parseNodesOrdered(content);

  const nodeCoordMap = {};
  nodesOrdered.forEach(n => {
    const key = `${n.x},${n.y},${n.z}`;
    if (!nodeCoordMap[key]) nodeCoordMap[key] = [];
    nodeCoordMap[key].push(n.label);
  });

  const duplicateNodes = Object.entries(nodeCoordMap)
    .filter(([coords, labels]) => labels.length > 1)
    .map(([coords, labels]) => ({
      coords,
      labels
    }));

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

    if (!m.iNode) {
      invalidNodeRefs.push(`${m.label}: i-node index ${m.iNodeIndex} is out of range (model has ${nodesOrdered.length} nodes)`);
    }

    if (!m.jNode) {
      invalidNodeRefs.push(`${m.label}: j-node index ${m.jNodeIndex} is out of range (model has ${nodesOrdered.length} nodes)`);
    }

    if (m.iNode && m.jNode) {
      const len = distance3D(m.iCoord, m.jCoord);
      if (len !== null && len < 0.001) {
        zeroLength.push(`${m.label} (${m.iNode} = ${m.jNode})`);
      }
    }
  });

  const issueCount =
    duplicateNodes.length +
    duplicateMemberLabels.length +
    missingSize.length +
    zeroLength.length +
    invalidNodeRefs.length;

  return {
    nodeCount: nodesOrdered.length,
    memberCount: members.length,
    duplicateNodes,
    duplicateMemberLabels,
    missingSize,
    zeroLength,
    invalidNodeRefs,
    issueCount,
    status: issueCount === 0 ? "PASS" : "REVIEW"
  };
}

export function padRISA(str, width = 32) {
  if (str.length >= width) return str.slice(0, width);
  return str + " ".repeat(width - str.length);
}

export function formatSciNotation(val) {
  return val.toExponential(12).replace(/e([+-])(\d+)/, (m, sign, digits) => {
    return `e${sign}${digits.padStart(2, "0")}`;
  });
}

export function generateUnusedLabel(prefix, usedSet, start = 9001) {
  let n = start;
  while (usedSet.has(`${prefix}${n}`)) n++;
  const label = `${prefix}${n}`;
  usedSet.add(label);
  return label;
}

export function getNodesSection(content) {
  const match = content.match(/(\[NODES\] <)(\d+)(>)([\s\S]*?)(\[END_NODES\])/);
  if (!match) return null;

  const body = match[4];
  const lines = body.split("\n").filter(l => l.trim());

  return {
    match,
    body,
    lines,
    count: lines.length
  };
}

export function getMembersSection(content) {
  const match = content.match(/(\[\.MEMBERS_MAIN_DATA\] <)(\d+)(>)([\s\S]*?)(\[\.END_MEMBERS_MAIN_DATA\])/);
  if (!match) return null;

  const body = match[4];
  const lines = body.split("\n").filter(l => l.trim());

  return {
    match,
    body,
    lines,
    count: lines.length
  };
}

export function getTrailingNodeFields(nodeLines) {
  if (!nodeLines || nodeLines.length === 0) return "";
  const lastNodeTokens = tokenize(nodeLines[nodeLines.length - 1]);
  return lastNodeTokens.slice(4).join(" ").replace(/;\s*$/, "");
}

export function buildNodeLine(label, x, y, z, trailingNodeFields) {
  return (
    `"${padRISA(label)}"   ` +
    `${formatSciNotation(x)}   ` +
    `${formatSciNotation(y)}   ` +
    `${formatSciNotation(z)}   ` +
    `${trailingNodeFields};`
  );
}

export function rebuildNodesSection(nodesMatch, updatedNodeLines) {
  const newCount = updatedNodeLines.filter(l => l.trim()).length;
  const updatedBody = updatedNodeLines.join("\n").replace(/\s*$/, "") + "\n";
  return `${nodesMatch[1]}${newCount}${nodesMatch[3]}${updatedBody}${nodesMatch[5]}`;
}

export function rebuildMembersSection(membersMatch, updatedMemberLines) {
  const newCount = updatedMemberLines.filter(l => l.trim()).length;
  const updatedBody = updatedMemberLines.join("\n").replace(/\s*$/, "") + "\n";
  return `${membersMatch[1]}${newCount}${membersMatch[3]}${updatedBody}${membersMatch[5]}`;
}

export function findExistingNodeByCoord(workingNodes, coord, tolerance = 0.001) {
  return workingNodes.find(n =>
    Math.abs(n.x - coord.x) <= tolerance &&
    Math.abs(n.y - coord.y) <= tolerance &&
    Math.abs(n.z - coord.z) <= tolerance
  );
}

export function findOrCreateNodeForGeometry({
  coord,
  workingNodes,
  existingNodeLabels,
  newNodeLines,
  trailingNodeFields,
  tolerance = 0.001
}) {
  const existing = findExistingNodeByCoord(workingNodes, coord, tolerance);

  if (existing) {
    return existing.index;
  }

  const label = generateUnusedLabel("N", existingNodeLabels);
  const index = workingNodes.length + 1;

  const newLine = buildNodeLine(
    label,
    coord.x,
    coord.y,
    coord.z,
    trailingNodeFields
  );

  newNodeLines.push(newLine);

  workingNodes.push({
    label,
    x: coord.x,
    y: coord.y,
    z: coord.z,
    index
  });

  return index;
}