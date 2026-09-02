# Lemon 🍋
A VS Code extension that downloads, hosts, and runs the [Lemonade Server](https://lemonade-server.ai/) embeddable binary (`lemond`) locally, enabling AI chat with local LLMs directly in VS Code.
<a href="https://marketplace.visualstudio.com/items?itemName=	lanly-dev.lemon" target="_blank">
  <img src='https://code.visualstudio.com/favicon.ico' width='12'/>
</a>
<a href="https://open-vsx.org/extension/lanly-dev/lemon" target="_blank">
  <img src='https://open-vsx.org/favicon.ico' width='11'/>
</a>

> ⚠️ **Early stage**: The 0.0.1 release focuses primarily on setup: downloading and hosting the binary, plus basic server and model management.
> More functionality is planned for upcoming releases.
> Testing is still limited, and development has so far been done only on Windows.
> Other platforms and edge cases may not work as expected. Feedback and issue reports are welcome.

## Features
- Managing/downloading lemonade models
- Chatting integration

<img src='https://github.com/lanly-dev/vscode-lemon/blob/main/media/treeview.png?raw=true' width='450'/>

## Chat Commands
The `@lemon` chat participant supports the following slash commands:

- `/fix` - Generate a fix for the selected code
- `/explain` - Explain the selected code

## Configuration
| Setting | Default | Description |
|---------|---------|-------------|
| `lemon.chatModel` | `""` | Model to use for chat (leave empty to be prompted) |
| `lemon.customServerUrl` | (unset) | Custom Lemonade Server URL used when `lemon.targetServer` is `"custom"` (e.g., http://localhost:13305) |
| `lemon.embeddedPort` | `8000` | Port for the embedded lemon server |
| `lemon.maxLoadedModels` | (unset) | Maximum number of loaded models. Use `-1` for unlimited. |
| `lemon.standalonePort` | `13305` | Port for the standalone Lemonade Server |
| `lemon.targetServer` | `"standalone"` | Which Lemonade Server to use: `standalone`, `embedded`, or `custom` |

## Server Mode Selection
You can choose which Lemonade server the extension uses by setting **`lemon.targetServer`** (`Lemon: Select Server` lets you pick from the command palette, which updates this setting automatically):

| Value | Behavior |
|-------|----------|
| `standalone` (default) | Connects to an existing system-installed standalone Lemonade Server. |
| `embedded` | Always starts the bundled `lemond` binary. |
| `custom` | Connects to the URL in `lemon.customServerUrl`. |

## Release Notes

### 0.0.1
- Lemonade management treeview
- Chat integration

**Enjoy!**
