# lemon 🍋

A VS Code extension that downloads, hosts, and runs the [Lemonade Server](https://lemonade-server.ai/) embeddable binary (`lemon`) locally, enabling AI chat with local LLMs directly in VS Code.

## Features

- **One-Click Binary Download**: Automatically downloads the platform-appropriate Lemonade Server embeddable binary
- **Local Server Management**: Start, stop, and restart the Lemonade Server from VS Code
- **AI Chat Integration**: Chat with local AI models using VS Code's built-in Chat API
- **Model Management**: Pull, load, unload, and select models through the sidebar view
- **Streaming Responses**: Real-time streaming of AI responses
- **Code Context**: Automatically includes active editor content as context for chat
- **Status Bar**: Visual indicator of server status

## Getting Started

1. Install the extension
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Run **Lemon: Start Server**
4. When prompted, click **Download** to download the Lemonade Server binary
5. Once the server is running, run **Lemon: Pull Model** to download a model (e.g., `Qwen3-0.6B-GGUF`)
6. Run **Lemon: Load Model** to load the model
7. Open the VS Code Chat view and select the **Lemonade** chat participant

## Commands

| Command | Description |
|---------|-------------|
| `Lemon: Start Server` | Start the Lemonade Server |
| `Lemon: Stop Server` | Stop the Lemonade Server |
| `Lemon: Restart Server` | Restart the Lemonade Server |
| `Lemon: Download/Update Binary` | Download or update the Lemonade Server binary |
| `Lemon: Open Chat` | Open the VS Code chat with Lemonade |
| `Lemon: Pull Model` | Download a model |
| `Lemon: Load Model` | Load a model into memory |
| `Lemon: Unload Model` | Unload a model from memory |
| `Lemon: Select Active Model` | Select the active model for chat |
| `Lemon: Select Server` | Choose which Lemonade Server to use for chat |
| `Lemon: Refresh Server Status` | Refresh the server status |

## Chat Commands

The Lemonade chat participant supports the following slash commands:

- `/fix` - Generate a fix for the selected code
- `/explain` - Explain the selected code

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `lemon.serverPort` | `13305` | Port for the standalone Lemonade Server |
| `lemon.embeddedPort` | `8000` | Port for the embedded lemon server |
| `lemon.chatModel` | `""` | Model to use for chat (leave empty to be prompted) |
| `lemon.customServerUrl` | (unset) | Custom Lemonade Server URL used when `lemon.serverMode` is `"custom"` (e.g., http://localhost:13305) |
| `lemon.serverMode` | `"auto"` | Which Lemonade Server to use: `standalone`, `embedded`, or `custom` |
| `lemon.maxLoadedModels` | (unset) | Maximum number of loaded models, Use `-1` for unlimited. |

## Server Selection

You can choose which Lemonade server the extension uses by setting **`lemon.serverMode`** (`Lemon: Select Server` lets you pick from the command palette, which updates this setting automatically):

| Mode | Behavior |
|------|----------|
| `auto` (default) | Prefers a running standalone Lemonade; otherwise starts the embedded `lemon` binary |
| `standalone` | Requires an existing system-installed standalone Lemonade; the extension does **not** start an embedded server |
| `embedded` | Always starts the bundled `lemon` binary (does not auto-connect to standalone) |
| `custom` | Connects to the URL in `lemon.customServerUrl` (e.g. a remote or other local server); no local process is launched |

In `custom` mode the URL is required — set `lemon.customServerUrl` in settings (or pick "Add Custom Server URL…" from `Lemon: Select Server`).

The active server is shown in the tree view and status bar. All chat commands, model operations, and API calls use the active server automatically. Settings changes are applied immediately.

## Sidebar

The extension adds a Lemon icon to the VS Code activity bar with a single **Servers** view that shows the active server:

### Active Server
Shows the currently selected server (either standalone or embedded):
- **Status** - Running/Starting/Stopped/Error with color-coded icons
- **Server URL** - the address of the server
- **Version** - the installed Lemonade Server binary version (embedded only)
- **Max Loaded Models** - the maximum number of models that can be loaded simultaneously (configurable for embedded server via settings)
- **Loaded Models** - expandable section showing currently loaded models with busy/idle status
- **Available Models** - expandable section listing all available models with load status

## How It Works

### No Conflicts with System-Installed Lemonade

The extension's `lemon` binary is stored in the extension's own **`bin/lemonade-server/` directory** — completely separate from any system-installed Lemonade Server. The two installations don't share binaries, models, or configuration.

**Port conflict handling**: Before starting its own server, the extension checks if a Lemonade Server is already running on the configured port (default: 13305):
- If a Lemonade Server is found → the extension **connects to the existing server** instead of starting its own
- If the port is in use by another application → the extension shows an error suggesting a different port
- If the port is free → the extension downloads and starts its own private `lemon` instance

### Architecture

1. The extension downloads the [Embeddable Lemonade](https://lemonade-server.ai/docs/embeddable/) binary from the [GitHub releases](https://github.com/lemonade-sdk/lemonade/releases)
2. The binary (`lemon`) is stored in the extension's own `bin/lemonade-server/` directory (like [vscode-emc](https://github.com/lanly-dev/vscode-emc) stores ffmpeg)
3. When you start the server, `lemon` is launched as a subprocess (unless an existing server is detected)
4. The embedded server provides an OpenAI-compatible API at `http://localhost:8000`
5. The VS Code Chat participant forwards messages to the selected server's `/v1/chat/completions` endpoint
6. Responses are streamed back in real-time

## Requirements

- VS Code 1.125.0 or later
- Supported platform: Windows x64, Linux x64/ARM64, or macOS ARM64

## License

This extension is provided as-is. The Lemonade Server is licensed under its own terms - see the [Lemonade Server repository](https://github.com/lemonade-sdk/lemonade) for details.
