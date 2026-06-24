# RISA-3D MCP Server

> Connect Claude AI to your RISA-3D structural models using the Model Context Protocol (MCP).

Built by a structural engineer, for structural engineers. This MCP server lets you talk to your `.r3d` files in plain English -- no coding required after setup.

---

## Demo

> *"Summarize this model for a report"*
> *"What steel grade is this model using?"*
> *"What are the boundary conditions at the column bases?"*
> *"Compare these two models and tell me what changed"*

Once connected, just point Claude at any `.r3d` file and start asking questions.

---

## What Is This?

MCP (Model Context Protocol) is an open standard that lets AI assistants like Claude connect to external tools and files. This server acts as a bridge between Claude Desktop and your RISA-3D models. Claude reads your `.r3d` files directly and answers questions about them in plain English.

No RISA-3D API is required. This works by reading RISA-3D's plain-text `.r3d` file format directly.

---

## Project Structure

```text
risa3d-mcp-server/
  index.js        # MCP server tools for Claude/Desktop MCP clients
  risa-core.js    # Shared RISA-3D parsing helpers
  risa-cli.js     # Local command-line testing/debugging
  package.json
```

---

## What This Server Does

This MCP server reads and modifies `.r3d` RISA-3D model files.
It can:

- Read nodes, members, sections, supports, load cases, and load combinations
- Generate model summaries
- Generate load summaries grouped by RISA basic load case
- Export member schedules to Excel
- Clone a model with controlled changes
- Run QA/QC checks on RISA models
- Run CLI diagnostics without Claude/MCP

---

## What You Can Do

Once connected, you can ask Claude things like:

- *"Summarize this model for a report -- include members, nodes, loads, boundary conditions, and materials"*
- *"What steel grade and Fy value is assigned in this model?"*
- *"List all the boundary conditions -- which nodes are fixed vs. pinned?"*
- *"What section sizes are assigned to each section set?"*
- *"List all the members and their section sizes"*
- *"Run a QC check on this model"*
- *"Compare these two models and tell me what changed"*
- *"Export a member schedule for all HSS members"*

---

## Requirements

- Windows PC with RISA-3D installed
- [Claude Desktop](https://claude.ai/download) (free)
- [Node.js](https://nodejs.org) (LTS version -- free)
- A Claude account (Pro plan recommended)

---

## Installation

### Step 1 -- Install Node.js

Download and install the **LTS version** from [nodejs.org](https://nodejs.org). Click through all the defaults.

Verify it worked -- open Command Prompt and run:
```
node --version
npm --version
```
Both should return version numbers.

---

### Step 2 -- Set Up the MCP Server

Open Command Prompt and run these one at a time:

```bash
mkdir C:\risa-mcp
cd C:\risa-mcp
npm init -y
npm install @modelcontextprotocol/sdk zod xlsx
```

---

### Step 3 -- Create the Server File

In Command Prompt, run:
```
notepad index.js
```

Click **Yes** when asked to create a new file. Paste in the contents of `index.js` from this repository, then save and close.

---

### Step 4 -- Update package.json

In Command Prompt, run:
```
notepad package.json
```

Add `"type": "module"` so it looks like this:

```json
{
  "name": "risa-mcp",
  "version": "1.0.0",
  "main": "index.js",
  "type": "module",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.0.0"
  }
}
```

Save and close.

---

### Step 5 -- Test the Server

In Command Prompt, run:
```
cd C:\risa-mcp
node index.js
```

If you see a blinking cursor with no errors -- it is working. Press **Ctrl+C** to stop it.

---

### Step 6 -- Connect to Claude Desktop

1. Install [Claude Desktop](https://claude.ai/download) if you haven't already
2. Press **Windows + R**, type `%APPDATA%\Claude` and press Enter
3. Open or create `claude_desktop_config.json`
4. Paste in the following:

```json
{
  "mcpServers": {
    "risa3d": {
      "command": "node",
      "args": ["C:\\risa-mcp\\index.js"]
    }
  }
}
```

5. Save the file
6. Fully quit Claude Desktop (right-click the system tray icon -> Quit)
7. Reopen Claude Desktop

---

### Step 7 -- Verify It's Running

In Claude Desktop:
1. Click the **+** button in the chat input box
2. Click **Connectors**
3. You should see **risa3d** listed as connected

Or go to **Settings -> Developer** and confirm risa3d shows as **running**.

---

## Example Prompts

Once connected, open a new chat in Claude Desktop and try:

```
Summarize this model for a report:
"C:\path\to\your\model.r3d"
```

```
What steel materials are defined in this model?
"C:\path\to\your\model.r3d"
```

```
List the boundary conditions for this model:
"C:\path\to\your\model.r3d"
```

```
What section sets are defined in this model?
"C:\path\to\your\model.r3d"
```

```
List all the members in this RISA-3D model:
"C:\path\to\your\model.r3d"
```

```
List all Wide Flange members in full detail:
"C:\path\to\your\model.r3d" mode="full" filterType="Wide Flange"
```

```
Export a member schedule for Tube members only:
"C:\path\to\your\model.r3d" filterType="Tube"
```

```
Compare these two RISA-3D models and tell me what changed:
"C:\path\to\model-v1.r3d" and "C:\path\to\model-v2.r3d"
```

```
Run a QC check on this model:
"C:\path\to\your\model.r3d"
```

```
Summarize all models in this folder:
"D:\Projects\MISC STEEL\2026\My Project\Design"
```

```
Summarize all models in this folder whose name contains "stair":
"D:\Projects\MISC STEEL\2026\My Project\Design"
```

```
What basic load cases are defined in this model?
"C:\path\to\your\model.r3d"
```

```
Find all members using HSS8X8X10 in this model:
"C:\path\to\your\model.r3d"
```

```
What are the deflection limits set in this model?
"C:\path\to\your\model.r3d"
```

```
Change the Stringer section set from C15X33.9 to C12X20.7 and save as a new model:
"C:\path\to\your\model.r3d" -> "C:\path\to\your\model-revised.r3d"
```

```
Clone this model with member M41 changed to HSS6X6X10 and node N5 changed to pinned, save as a new file:
"C:\path\to\your\model.r3d" -> "C:\path\to\your\model-v2.r3d"
```

```
Give me a material takeoff for this model:
"C:\path\to\your\model.r3d"
```

```
Flag any members over 20 feet for unbraced length review:
"C:\path\to\your\model.r3d"
```

```
Export the member schedule to an Excel file:
"C:\path\to\your\model.r3d" -> "C:\Users\you\Desktop\schedule.xlsx"
```

```
Add a brace between N5 and N6 using HSS4X4X4, save as a new model:
"C:\path\to\your\model.r3d" -> "C:\path\to\your\model-braced.r3d"
```

```
Add a new HSS4X4X4 brace from node N44 to a new point at (6.0, 0.0, -12.0), save as a new model:
"C:\path\to\your\model.r3d" -> "C:\path\to\your\model-braced.r3d"
```

```
Export this model to SAF format for use in SCIA Engineer:
"C:\path\to\your\model.r3d" -> "C:\Users\you\Desktop\model.xlsx"
```

```
Check this model for duplicate nodes:
"C:\path\to\your\model.r3d"
```

```
Replace C15X33.9 with C12X20.7 across all models in this folder:
"D:\Projects\2026\MyProject\Design"
```

```
Show me what changed between these two model versions:
base: "C:\path\to\model-v1.r3d"
revised: "C:\path\to\model-v2.r3d"
```

---

## Available Tools

| Tool | Description |
|---|---|
| `read_risa_model` | Reads a `.r3d` file and returns a project summary (title, node count, member count, plate count, file size) |
| `list_members` | Returns a type breakdown summary by default (token-efficient). Use `mode="full"` for full CSV detail. Optional `filterType` (e.g. `"Tube"`, `"Wide Flange"`) to narrow results. |
| `list_nodes` | Lists all nodes with their X, Y, Z coordinates |
| `list_load_combinations` | Lists all load combinations defined in the model |
| `get_file_section` | Returns the raw contents of any named section in the file (e.g. NODES, MEMBERS, BOUNDARY_CONDITIONS) |
| `compare_risa_models` | Compares two `.r3d` files and reports differences in nodes, member sizes/connectivity, section sets, and load combinations |
| `export_member_schedule` | Generates a member schedule as CSV (label, type, size, nodes, length). Optional `filterType` to export one section type. Optional `maxRows` cap (default 200). |
| `qc_check_risa_model` | Checks for duplicate nodes, duplicate member labels, missing section sizes, zero-length members, and invalid node references |
| `get_model_materials` | Lists all HR and CF steel materials defined in the model with Grade, E, Fy, and Fu values |
| `get_boundary_conditions` | Lists all support conditions with node labels, constraint codes (Fixed/Free/Pinned), and plain-English descriptions |
| `get_section_sets` | Lists all named section sets and their assigned types and sizes |
| `summarize_model_for_report` | Single-call summary combining project info, nodes, members, section sets, materials, boundary conditions, load combinations, area loads, distributed loads, and point loads -- ready to paste into a calculation package |
| `batch_summarize_folder` | Scans a folder for all `.r3d` files and returns a CSV summary table (file name, title, designer, node count, member count, section sets, load combos, file size, QC status). Optional `filterName` parameter to match specific file names. |
| `get_load_cases` | Lists all basic load cases defined in the model with their index, name, and load type (Gravity, Seismic, Wind, etc.) |
| `find_members_by_section` | Returns all members assigned a specific section size. Accepts partial, case-insensitive matches (e.g. `"hss8"` matches `"HSS8X8X10"`). If no match, lists all sizes in the model. |
| `get_deflection_limits` | Returns the deflection limit ratios (L/240, L/360, etc.) defined in both the global deflection rules and member deflection rules. Shows "Not checked" for any category set to -1. |
| `modify_section_set` | Changes a section size and saves a NEW `.r3d` file (never overwrites the original). Can change the section set definition, specific member assignments, or both. Optional `setName` or `memberLabel` to narrow the change to a single set or member. |
| `clone_model_with_changes` | Saves a copy of the model with one or more changes applied: section sizes, boundary conditions, and member distributed load magnitudes. Always writes to a new file. Useful for parametric studies and what-if comparisons. |
| `get_material_takeoff` | Returns total weight by section size and a grand total, calculated from AISC shape designations (W/C shapes: number after the X is lb/ft) plus a lookup table for HSS and angle shapes. Sizes not in the table are flagged as unknown rather than guessed, and excluded from the total. |
| `find_unbraced_length_issues` | Flags members longer than a threshold (default 15 ft, adjustable) for manual review. This is a length screen only -- it does NOT calculate KL/r, apply K-factors, or account for intermediate brace points. Intended to surface candidates for engineering judgment, not to replace it. |
| `export_member_schedule_to_excel` | Writes the member schedule directly to a real `.xlsx` file at a path you specify, instead of returning CSV text to copy-paste. |
| `batch_summarize_folder_to_excel` | Writes the batch folder summary directly to a real `.xlsx` file. Same data as `batch_summarize_folder`, saved as an actual spreadsheet. |
| `add_member` | Adds a new member to the model and saves a NEW `.r3d` file. Connects to two existing nodes (by label) or creates new nodes at given coordinates, always appended to the end of the model so no existing member's node references shift. Clones the field structure from an existing member of the same type to avoid guessing internal RISA codes. Requires at least one existing member of the target type already in the model. |
| `export_to_saf` | Exports a RISA-3D model to SAF format (`.xlsx`), the open exchange standard used by SCIA Engineer, SOFiSTiK, AxisVM, and other structural analysis software. Produces five sheets: StructuralMaterial, StructuralCrossSection, StructuralPointConnection, StructuralCurveMember, StructuralPointSupport, plus a NOTES sheet documenting two key limitations: (1) coordinates are converted from feet to meters, and (2) RISA's Y-vertical axis is NOT swapped to Z-vertical -- the receiving engineer must handle axis orientation. Loads are not included in this export. |
| `find_duplicate_nodes` | Scans all nodes for pairs with nearly identical coordinates (default tolerance 0.001 ft, ~0.3mm). Duplicate nodes cause members to appear connected when they aren't, or produce zero-length members that silently corrupt analysis results. Flags pairs by label with exact distance and coordinates. |
| `replace_section_size_in_folder` | Replaces a section size string across every `.r3d` file in a folder, saving each as a new file with a configurable suffix (never overwrites originals). Useful for applying a spec change across an entire project folder at once. Reports how many replacements were made per file, and skips files with no matches. |
| `compare_risa_models` | Diffs two `.r3d` files and reports exactly what changed: nodes added, removed, or moved; members added, removed, or changed (size, type, or connectivity); section sets added, removed, or resized; and load combination count changes. Useful for tracking design iterations and documenting changes between submittals. |

---

## Important RISA-3D Load Parsing Note

RISA-3D `.r3d` files do not always store visible load case names directly inside load rows. For example, load rows may contain internal raw IDs like:

```text
88
89
90
```

These are not necessarily the visible Basic Load Case numbers shown in RISA.

This project resolves loads using the confirmed RISA pattern:

```text
[BASIC_LOAD_CASES]
  -> distributed load count
  -> area load count
  -> node load count
  -> row order inside load tables
```

The shared helper `parseLoadsByBasicLoadCase(content)` groups loads by visible RISA Basic Load Case name, such as:

```text
DL
LL
WLx
WLz
BLC 1 Transient Area Loads
```

instead of exposing internal raw IDs.

---

## Current Load Editing Support

`clone_model_with_changes` currently supports:

- Section size changes
- Boundary condition changes
- Member distributed load magnitude changes
- Node load magnitude changes

It does **not** currently edit area loads.

Area loads are intentionally excluded because RISA may generate transient/memberized distributed loads from area loads. Editing area loads without regenerating those derived loads could create an inconsistent model.

---

## CLI Usage

The CLI lives in `risa-cli.js`. Run commands from the project folder:

```cmd
node risa-cli.js help
```

### Generate Load Summary

```cmd
node risa-cli.js generate-load-summary "C:\path\to\model.r3d"
```

Include generated transient load cases:

```cmd
node risa-cli.js generate-load-summary "C:\path\to\model.r3d" --include-transient
```

### Debug Load Case Counts

```cmd
node risa-cli.js debug-load-case-counts "C:\path\to\model.r3d"
```

### Debug Raw Load Structure

```cmd
node risa-cli.js debug-load-structure "C:\path\to\model.r3d" 10
```

### Debug Member Load Rows

```cmd
node risa-cli.js debug-member-load-rows "C:\path\to\model.r3d" M41
```

### Debug Load Membership

```cmd
node risa-cli.js debug-load-membership "C:\path\to\model.r3d"
```

---

## MCP Usage

Start the MCP server with:

```cmd
node index.js
```

In your MCP client config, point to:

```cmd
node C:\path\to\risa3d-mcp-server\index.js
```

---

## Safety Notes

- The server never overwrites the original file when cloning.
- Use `clone_model_with_changes` with a different `outputPath`.
- Always open cloned `.r3d` files in RISA-3D and verify the model before using them for design.
- Write/edit tools should be treated as engineering-assist tools, not final design authority.

---

## Developer Checks

Before committing changes, run:

```cmd
node --check index.js
node --check risa-core.js
node --check risa-cli.js
```

---

## Recommended GitHub Files

Do commit:

```text
index.js
risa-core.js
risa-cli.js
package.json
README.md
```

Do not commit:

```text
*.r3d
*.xlsx
node_modules/
temporary test models
client project files
```

Add this to `.gitignore`:

```gitignore
node_modules/
*.r3d
*.xlsx
*.xls
*.csv
.DS_Store
.env
```

---

## Technical Notes on the `.r3d` Format

Several non-obvious quirks in RISA's file format that this server handles, documented here for anyone extending it:

**1. Fixed-width quoted fields.** Labels, types, and section sizes are stored as quote-padded strings, e.g. `"M14                             "`. A naive whitespace split breaks these into multiple phantom tokens. This server uses a quote-aware tokenizer that treats anything inside `"..."` (including internal spaces) as a single field.

**2. Members reference nodes by position, not by label.** In `[.MEMBERS_MAIN_DATA]`, the i-node and j-node fields are 1-based indices into the order of the `[NODES]` list -- not the node label strings. For example, a member line containing `1 7` means the 1st node listed to the 7th node listed, which might resolve to `N5` and `N18`. This server resolves those indices against an ordered node array.

**3. Load section names.** Point/nodal loads are stored under `[NODE_LOADS]`, not `[JOINT_LOADS]`. Member distributed loads are stored under `[DIRECT_DISTRIBUTED_LOADS]`, not `[MEMBER_DISTRIBUTED_LOADS]`.

**4. Load case IDs in load sections.** The load case index stored in `[NODE_LOADS]`, `[DIRECT_DISTRIBUTED_LOADS]`, and `[AREA_LOADS]` entries is an internal RISA database ID, not the sequential 1-based index from `[BASIC_LOAD_CASES]`. When no name match is found, the tool labels the load case as `LC{n}`.

The member line format (after tokenizing) is:
```
Label, Type (e.g. "Wide Flange", "Tube", "Channel", "None"), Size (e.g. "W14X22", "HSS8X8X10"), iNodeIndex, jNodeIndex, ...
```

---

## Roadmap

- [x] Read and summarize any `.r3d` model
- [x] List members with type, size, and resolved node connectivity
- [x] List nodes with coordinates
- [x] List load combinations
- [x] Get raw file section by name
- [x] Compare two models and summarize differences
- [x] Export member schedule as CSV
- [x] QC checker for common modeling issues
- [x] Get steel material properties (Grade, E, Fy, Fu)
- [x] Get boundary conditions with plain-English descriptions
- [x] Get section sets and assigned sizes
- [x] Summarize model for report in a single call (includes loads)
- [x] Batch summarize all models in a project folder
- [x] Get basic load cases with load type classification
- [x] Find all members using a specific section size
- [x] Get deflection limit rules (global and per-member)
- [x] Modify member section sizes and save the updated model
- [x] Clone a model with section, boundary condition, and load changes applied
- [x] Material takeoff with AISC shape weights
- [x] Length-based screen for unbraced length review
- [x] Direct .xlsx export (member schedule and batch summary)
- [x] Add new members (braces, posts, etc.) connecting existing or new nodes
- [x] Export to SAF format (.xlsx) for import into SCIA, SOFiSTiK, AxisVM, and other SAF-compatible software
- [x] Detect duplicate nodes (coordinate tolerance scan)
- [x] Replace section size globally across a folder of models
- [x] Diff two model versions (nodes, members, section sets, load combinations)

---

## Contributing

Pull requests are welcome. If you work with RISA-3D and have ideas for new tools, open an issue and let's discuss.

---

## About

Built by **Vibhanshu Mishra, PE** -- Structural Engineer at AG&E Structural Engineers, Austin TX.

Specializing in steel and mission-critical structures. Building AI tools for a niche where none existed.

---

## License

MIT License -- free to use, modify, and share.
