# RISA-3D MCP Server

> Connect Claude AI to your RISA-3D structural models using the Model Context Protocol (MCP).

Built by a structural engineer, for structural engineers. This MCP server lets you talk to your `.r3d` files in plain English — no coding required after setup.

---

## 🎬 Demo

> *"Read this model and summarize it for me"*
> *"List all the members in this file"*
> *"Show me all the load combinations"*

Once connected, just point Claude at any `.r3d` file and start asking questions.

---

## 🔧 What Is This?

MCP (Model Context Protocol) is an open standard that lets AI assistants like Claude connect to external tools and files. This server acts as a bridge between Claude Desktop and your RISA-3D models — Claude can read your `.r3d` files directly and answer questions about them in plain English.

No RISA-3D API is required. This works by reading RISA-3D's plain-text `.r3d` file format directly.

---

## ✅ What You Can Do

Once connected, you can ask Claude things like:

- *"Summarize this model — how many members, nodes, and load cases?"*
- *"List all the members and their section sizes"*
- *"List all the nodes and their coordinates"*
- *"Show me all the load combinations"*
- *"Read the materials section of this file"*
- *"Compare these two models and tell me what changed"*
- *"What design codes is this model using?"*

---

## 📋 Requirements

- Windows PC with RISA-3D installed
- [Claude Desktop](https://claude.ai/download) (free)
- [Node.js](https://nodejs.org) (LTS version — free)
- A Claude account (Pro plan recommended)

---

## 🚀 Installation

### Step 1 — Install Node.js

Download and install the **LTS version** from [nodejs.org](https://nodejs.org). Click through all the defaults.

Verify it worked — open Command Prompt and run:
```
node --version
npm --version
```
Both should return version numbers.

---

### Step 2 — Set Up the MCP Server

Open Command Prompt and run these one at a time:

```bash
mkdir C:\risa-mcp
cd C:\risa-mcp
npm init -y
npm install @modelcontextprotocol/sdk zod
```

---

### Step 3 — Create the Server File

In Command Prompt, run:
```
notepad index.js
```

Click **Yes** when asked to create a new file. Paste in the contents of `index.js` from this repository, then save and close.

---

### Step 4 — Update package.json

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

### Step 5 — Test the Server

In Command Prompt, run:
```
cd C:\risa-mcp
node index.js
```

If you see a blinking cursor with no errors — it's working. Press **Ctrl+C** to stop it.

---

### Step 6 — Connect to Claude Desktop

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
6. Fully quit Claude Desktop (right-click the system tray icon → Quit)
7. Reopen Claude Desktop

---

### Step 7 — Verify It's Running

In Claude Desktop:
1. Click the **+** button in the chat input box
2. Click **Connectors**
3. You should see **risa3d** listed as connected

Or go to **Settings → Developer** and confirm risa3d shows as **running**.

---

## 💬 Example Prompts

Once connected, open a new chat in Claude Desktop and try:

```
Using the risa3d tool, read this file and summarize it:
"C:\path\to\your\model.r3d"
```

```
List all the members in this RISA-3D model:
"C:\path\to\your\model.r3d"
```

```
Show me all the load combinations in:
"C:\path\to\your\model.r3d"
```

```
Compare these two RISA-3D models and tell me what changed:
"C:\path\to\model-v1.r3d" and "C:\path\to\model-v2.r3d"
```

---

## 🛠️ Available Tools

| Tool | Description |
|---|---|
| `read_risa_model` | Reads a `.r3d` file and returns a summary (title, node count, member count, etc.) |
| `list_members` | Lists all members with their labels, i/j nodes, and section shapes |
| `list_nodes` | Lists all nodes with their X, Y, Z coordinates |
| `list_load_combinations` | Lists all load combinations defined in the model |
| `get_file_section` | Returns the raw contents of any named section in the file (e.g. NODES, MEMBERS, MATERIAL_PROPERTIES) |
| `compare_risa_models` | Compares two `.r3d` files and reports differences in nodes, members, section sets, and load combinations |

---

## 🗺️ Roadmap

Future tools planned:

- [x] Compare two models and summarize differences
- [ ] Detect overstressed members from results
- [ ] Generate member schedule as Word or Excel
- [ ] Modify member sizes and save updated model
- [ ] Batch process multiple models in a folder
- [ ] QC checker for naming conventions and model standards
- [ ] Extract project info across all models in a project folder

---

## 🤝 Contributing

Pull requests are welcome! If you work with RISA-3D and have ideas for new tools, open an issue and let's discuss.

---

## 👷 About

Built by **Vibhanshu Mishra, PE** — Structural Engineer at AG&E Structural Engineers, Austin TX.

Inspired by the ETABS MCP server project from a friend. If this helped you, feel free to connect on LinkedIn!

---

## 📄 License

MIT License — free to use, modify, and share.
