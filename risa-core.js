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

export function parseLoadsByBasicLoadCase(content) {
  const blcData = parseBasicLoadCases(content);

  const getLines = (sectionName, endSectionName) => {
    const regex = new RegExp(`\\[${sectionName}\\] <\\d+>([\\s\\S]*?)\\[${endSectionName}\\]`);
    const match = content.match(regex);
    if (!match) return [];
    return match[1].trim().split("\n").filter(l => l.trim());
  };

  const nodeLines = getLines("NODE_LOADS", "END_NODE_LOADS");
  const distLines = getLines("DIRECT_DISTRIBUTED_LOADS", "END_DIRECT_DISTRIBUTED_LOADS");
  const areaLines = getLines("AREA_LOADS", "END_AREA_LOADS");

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

      const nodeLoads = nodeLines.slice(nodeCursor, nodeCursor + nodeCount).map((line, i) => ({
        rowNumber: nodeCursor + i + 1,
        tokens: line.trim().replace(";", "").split(/\s+/),
        raw: line.trim()
      }));

      const distributedLoads = distLines.slice(distCursor, distCursor + distCount).map((line, i) => ({
        rowNumber: distCursor + i + 1,
        tokens: line.trim().replace(";", "").split(/\s+/),
        raw: line.trim()
      }));

      const areaLoads = areaLines.slice(areaCursor, areaCursor + areaCount).map((line, i) => ({
        rowNumber: areaCursor + i + 1,
        tokens: line.trim().replace(";", "").split(/\s+/),
        raw: line.trim()
      }));

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