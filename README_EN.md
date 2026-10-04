<div align="center">

# pi-server-monitor

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Pi Package](https://img.shields.io/badge/Pi%20Package-Extension-green.svg)](https://pi.dev)
[![npm version](https://img.shields.io/npm/v/pi-server-monitor.svg)](https://www.npmjs.com/package/pi-server-monitor)

A high-performance real-time remote server hardware monitoring extension for Pi Agent.  
Specifically designed for deep learning model training and cloud GPU clusters.

[简体中文文档](README.md)

</div>

---

## Key Features

- **Zero-Config Seamless Auto-Activation**: Kept completely silent with zero overhead by default. When the AI Agent runs any tool involving SSH (e.g. `bash: ssh user@host ...` or `scp`), the extension automatically intercepts the target host and activates monitoring within milliseconds, requiring no manual commands.
- **Ultra-Compact Single-Line Banner**: Renders exactly one compact line directly above the prompt editor (`aboveEditor`), keeping conversation and input areas unobstructed:
  ```text
  tan@100.111.71.70  │  CPU 0% (12C)  │  RAM 2.0 GB/30.6 GB (6%)  │  GPU [RTX 3070] 0% │ VRAM 130 MB/8.0 GB (2%) │ 47°C 17W
  ```
- **Connection Multiplexing (OpenSSH ControlMaster)**: Built on OpenSSH socket multiplexing. After the initial handshake, subsequent polls take only 10–20ms with zero re-authentication overhead.
- **Native AI Agent Tool (`get_remote_hardware_info`)**: Exposes hardware metrics to the LLM, enabling autonomous checks of free VRAM before tuning batch sizes or diagnosing data loader bottlenecks.
- **Adaptive Display for Single/Multi-GPU & CPU Nodes**: Seamlessly supports single GPU workstations, multi-GPU nodes (2x/4x/8x), and CPU-only servers.
- **Flexible Display Modes**:
  - `compact`: Ultra-compact single line above the editor (Default)
  - `widget`: Full multi-line ASCII dashboard box
  - `footer`: Compact single-line status in the footer bar
  - `both`: Both banner and footer
  - `none`: Silent background mode (tool queries remain available)

---

## Architecture & Design

```text
┌─────────────────────────────────────────────────────────────┐
│                       Pi Agent TUI                          │
│                                                             │
│  tan@gpu-node  │  CPU 42% (32C)  │  GPU [A100] 88% ...      │
│  ─────────────────────────────────────────────────────────  │
│  User Prompt Editor / Conversation Area                     │
└──────────────────────────┬──────────────────────────────────┘
                           │
                 [ResourceCollector (2s)]
                           │ (SSH ControlMaster /tmp/pi-mon-*.sock)
                           ▼
              Remote Server (Linux GPU Host)
                           │
             [Embedded Fast Python / Shell Probe]
                           │
      ┌────────────────────┼────────────────────┐
      ▼                    ▼                    ▼
 /proc/stat           /proc/meminfo        nvidia-smi
 (CPU & Cores)         (RAM & Avail)   (GPU, VRAM)
```

---

## Installation

### 1. Install via npm (Recommended)

Pi Agent natively supports installing extensions directly from the npm registry:

```bash
# Global installation (persists in ~/.pi/agent/settings.json, recommended)
pi install npm:pi-server-monitor

# Install a specific pinned version
pi install npm:pi-server-monitor@0.2.0

# Install for current project only (persists in .pi/settings.json)
pi install npm:pi-server-monitor -l
```

### 2. Temporary Session Load (Zero Config)

Load the extension on demand without saving to local configuration:

```bash
pi -e npm:pi-server-monitor
```

### 3. Install from GitHub

```bash
pi install github:newbietan/pi-server-monitor
```

### 4. Local Development Installation

If you clone the repository locally for development:

```bash
# Global installation from local path
pi install ./pi-server-monitor

# Or temporary session load from built artifact
pi --extension ./pi-server-monitor/dist/index.js
```

---

## Connection & Usage

- **Automatic Mode (Recommended)**: No manual command needed. When the AI Agent executes remote tasks over SSH, monitoring starts automatically.
- **CLI Flag**:
  ```bash
  pi --ssh-monitor root@192.168.1.100
  ```
- **Integrated with Pi's `--ssh` Flag**:
  ```bash
  pi --ssh user@my-server:/workspace
  ```

---

## Slash Commands

| Command | Description |
|---|---|
| `/ssh-mon connect <target>` | Manually connect to target host and start monitoring |
| `/ssh-mon disconnect` | Stop monitoring and release SSH multiplexing sockets |
| `/ssh-mon interval <seconds>` | Adjust polling frequency (e.g. `/ssh-mon interval 3`) |
| `/ssh-mon mode <mode>` | Switch display mode: `compact` (default), `widget`, `footer`, `both`, or `none` |
| `/ssh-mon info` | Output a full hardware snapshot into conversation |
| `/gpu` | Quick view of all GPU cards, VRAM usage, temperature, and power draw |
| `/ssh-mon help` | Display help and usage guide |

---

## Agent Tool: `get_remote_hardware_info`

The extension automatically registers `get_remote_hardware_info` for the AI Agent.

### Parameters
- `target` *(string, optional)*: Remote SSH target (`user@host` or `user@host:port`). Defaults to currently connected host.
- `forceRefresh` *(boolean, optional)*: Force an immediate live query instead of returning cached metrics.

### Example Prompts for Pi Agent
- *"Check if the GPU has enough free VRAM for me to increase the batch size from 4 to 8."*
- *"Is the training script running? Check GPU utilization."*
- *"Why is training so slow? Check if there's a CPU or memory bottleneck."*

---

## Requirements

- **Local Machine**:
  - Node.js >= 18
  - OpenSSH client (`ssh`)
  - SSH key-based authentication configured to the remote host.
- **Remote Server**:
  - Linux (Ubuntu/Debian/CentOS/Rocky, etc.)
  - Python 3 (standard library only; shell fallback is used if Python is absent)
  - `nvidia-smi` (for NVIDIA GPU metrics)

---

## Development & Testing

```bash
cd pi-server-monitor

# Install dependencies
npm install

# Build TypeScript
npm run build

# Run unit tests
npm test
```

---

## License

MIT © [newbietan](https://github.com/newbietan)
