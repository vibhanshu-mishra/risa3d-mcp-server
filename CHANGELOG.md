# Changelog

All notable changes to the RISA-3D MCP Server are documented here.

---

## [1.4.0] - 2025-06

### Added

**Tool 17 -- `modify_section_set`**
First write tool. Changes a section size and saves a NEW `.r3d` file, never overwriting the original. Supports three modes: change the section set definition only, change specific member assignments only, or both. Optional `setName` or `memberLabel` parameters narrow the change to a single set or member rather than every instance of a size in the model. Returns a count of sets and members changed, or a clear message if no matches were found (with no file written).

**Tool 18 -- `clone_model_with_changes`**
Saves a copy of the model with one or more changes applied in a single call: section sizes (set-level, member-level, or both), boundary conditions (per-node, per-DOF Fixed/Free), and member distributed load magnitudes (resolved by load case name). Always writes to a new file specified by `outputPath`; never overwrites the source. Useful for parametric studies, what-if comparisons, and generating revision sets without manually editing the model in RISA.

Both write tools include a hard safety check: if `outputPath` matches `filePath`, the tool refuses to run and returns an error instead of writing the file.

---

## [1.3.0] - 2025-06

### Added

**Tool 14 -- `get_load_cases`**
Lists all basic load cases defined in the model with their 1-based index, name, and load type (Gravity, Seismic, Wind, etc.). Useful for cross-referencing load case indices that appear in the load sections of the model. Complements the existing `list_load_combinations` tool (Tool 4) which covers factored combinations.

**Tool 15 -- `find_members_by_section`**
Returns all members assigned a specific section size. Accepts partial, case-insensitive matches so `"hss8"` will match `"HSS8X8X10"`. If no match is found, lists all section sizes present in the model so you can correct the query. Useful for verifying section assignments and identifying which members will be affected before making a section change.

**Tool 16 -- `get_deflection_limits`**
Returns the deflection limit ratios (L/240, L/360, etc.) from both the global deflection rules and the per-member deflection rules. Categories covered: DL, LL, TL, and cantilever variants. Shows "Not checked" for any category set to -1 in the model. Useful for peer review and design narrative documentation.

---

## [1.2.0] - 2025-06

### Added

**Tool 13 -- `batch_summarize_folder`**
Scans a folder for all `.r3d` files and returns a single CSV summary table with one row per model. Each row includes file name, model title, designer, node count, member count, section set count, load combination count, file size, and a quick QC status (flags unassigned sections and invalid node references). Optional `filterName` parameter to match only files whose name contains a specific string. Useful for project-wide QC and cross-model reporting across all stair or platform models in a project folder.

---

## [1.1.0] - 2025-06

### Added

**Tool 9 -- `get_model_materials`**
Lists all HR and CF steel materials defined in the model. Returns Grade, E (ksi), Fy (ksi), and Fu (ksi) as CSV. Useful for QC and design narrative writing.

**Tool 10 -- `get_boundary_conditions`**
Lists all constrained nodes with their support conditions. Resolves node indices to node labels, translates RISA constraint codes (4=Fixed, 0=Free, 1=Spring, etc.) to human-readable text, and adds a plain-English description column (Fixed, Pinned, or the specific combination of constraints).

**Tool 11 -- `get_section_sets`**
Lists all named hot-rolled steel section sets and their assigned types and sizes as CSV. Directly useful for design review -- shows what sections are assigned to each named group (e.g. Stringers, Posts, Hangers).

**Tool 12 -- `summarize_model_for_report`**
Single-call model summary combining project info, nodes, members, section sets, materials, boundary conditions, load combinations, area loads, distributed loads, and point loads. Replaces 6+ separate tool calls. Output is structured for pasting directly into a calculation package or design narrative.

### Changed

**`list_members` -- token efficiency refactor**
Now returns a compact type breakdown by default (e.g. "168 members total: 62 Tube, 45 Wide Flange, 38 Channel, 23 Angle"). Use `mode="full"` for full CSV detail. Optional `filterType` parameter (e.g. `"Tube"`, `"Wide Flange"`) returns only matching members.

**`export_member_schedule` -- token efficiency refactor**
Now supports optional `filterType` to export only one member type. Added `maxRows` parameter (default 200) to prevent runaway token usage on large models. Shows a warning if the result is capped.

### Fixed

**Correct load section names documented**
RISA-3D stores point/nodal loads under `[NODE_LOADS]` (not `[JOINT_LOADS]`) and member distributed loads under `[DIRECT_DISTRIBUTED_LOADS]` (not `[MEMBER_DISTRIBUTED_LOADS]`). The summarize tool and technical notes now reflect the correct section names.

---

## [1.0.0] - 2025-05

### Added

Initial release with 8 tools:

- `read_risa_model` -- project summary (title, node count, member count, file size)
- `list_members` -- all members with type, size, and resolved i/j node labels
- `list_nodes` -- all nodes with X, Y, Z coordinates
- `list_load_combinations` -- all load combination names
- `get_file_section` -- raw contents of any named file section
- `compare_risa_models` -- diff two `.r3d` files (nodes, members, section sets, load combos)
- `export_member_schedule` -- member schedule as CSV with calculated lengths
- `qc_check_risa_model` -- checks for duplicate nodes, duplicate members, missing sections, zero-length members, invalid node references

### Technical notes documented

- Fixed-width quoted fields require a quote-aware tokenizer
- Member i/j node references are 1-based positional indices into the `[NODES]` list, not label strings
