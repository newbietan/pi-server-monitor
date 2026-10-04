# pi-server-monitor 🖥️⚡

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Pi Package](https://img.shields.io/badge/Pi%20Package-Extension-green.svg)](https://pi.dev)

A high-performance real-time remote server hardware monitoring extension for [Pi Agent](https://pi.dev).

Specifically designed for **Deep Learning Model Training & Remote Cloud GPU Clusters** (AutoDL, RunPod, Lambda Labs, Vast.ai, Slurm nodes, or private GPU servers).

---

## 🚀 Key Features

- **⚡ Zero-Lag SSH Connection Multiplexing (OpenSSH ControlMaster)**:
  Uses OpenSSH `ControlMaster` socket multiplexing. After the initial connection, subsequent metric polls take only **10–20ms** with zero TCP/SSH re-authentication overhead.
- **📊 Real-Time TUI Dashboard Widget**:
  Renders directly above the prompt editor (`aboveEditor`) with ANSI color-coded progress bars:
  - **CPU Utilization & Core Count** (with load averages)
  - **System RAM Usage** (Used / Total in GB, percentage, available memory)
  - **GPU Model & Compute Utilization** (`NVIDIA A100`, `RTX 4090`, `H100`, etc.)
  - **VRAM (GPU Memory) Usage** (Used / Total in GB, percentage, free headroom)
  - **Hardware Health**: GPU temperature (°C) & Power draw vs. limit (W)
  - **Active Deep Learning Processes**: Detects `python train.py` PID and per-process VRAM allocation
- **🤖 Native AI Agent Tool (`get_remote_hardware_info`)**:
  Exposes a structured tool to Pi Agent. The LLM can proactively check GPU memory headroom before tuning batch sizes, verify whether a training script actually started on the GPU, or diagnose data loader bottlenecks (e.g., GPU dropping to 0%).
- **🎮 Multi-Card & Cluster Support**:
  Gracefully handles single-GPU workstations, multi-GPU nodes (2x/4x/8x GPUs), and CPU-only servers.
- **🔄 Flexible Display Modes**:
  - `widget`: Interactive ASCII dashboard box above the editor (default)
  - `footer`: Compact single-line status in the footer bar
  - `both`: Both widget and footer
  - `none`: Silent background mode (tool queries still work)

---

## 📦 Architecture & Design

```text
┌─────────────────────────────────────────────────────────────┐
│                       Pi Agent TUI                          │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ ┌─ SSH Monitor [root@gpu-node-01] (● Connected) ────┐ │  │
│  │ │ CPU: [██████░░░░] 41.2% (32C) │ RAM: [████████░░] │ │  │
│  │ │ GPU 0: NVIDIA A100-SXM4-80GB                      │ │  │
│  │ │   Compute: [████████████████░░] 88% │ VRAM: 78%   │ │  │
│  │ │   Status: 68°C │ 350W │ PID 48219 (python): 64GB  │ │  │
│  │ └──────────────────────────────────── ⏱️ 2s refresh ─┘ │  │
│  └───────────────────────────────────────────────────────┘  │
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
 (CPU & Cores)         (RAM & Avail)   (GPU, VRAM, PIDs)
```

---

## 🛠️ Quick Start

### 1. Installation

You can load this package directly into Pi Agent:

```bash
# Load directly during a session
pi --extension ./pi-server-monitor/dist/index.js

# Or install it into your local Pi settings
pi install ./pi-server-monitor
```

### 2. Connect to Remote Server

There are 3 ways to specify the SSH target:

#### Method A: CLI Flag
```bash
pi -e ./pi-server-monitor/dist/index.js --ssh-monitor root@192.168.1.100
# or custom port:
pi -e ./pi-server-monitor/dist/index.js --ssh-monitor root@gpu-cluster.internal:2222
```

#### Method B: Integrated with Pi's `--ssh` Flag
If you use Pi's remote execution `--ssh` flag:
```bash
pi -e ./pi-server-monitor/dist/index.js --ssh user@my-server:/workspace
# The monitor automatically detects 'user@my-server' and starts monitoring!
```

#### Method C: Interactive Slash Commands
Inside Pi Agent's interactive session:
```text
/ssh-mon connect root@192.168.1.100:2222
```

---

## 💬 Slash Commands

| Command | Description |
|---|---|
| `/ssh-mon connect <target>` | Connect to `user@host[:port]` and start real-time monitoring |
| `/ssh-mon disconnect` | Stop monitoring and gracefully close SSH multiplexing sockets |
| `/ssh-mon interval <seconds>` | Adjust polling frequency (e.g. `/ssh-mon interval 3`) |
| `/ssh-mon mode <mode>` | Switch display mode: `widget`, `footer`, `both`, or `none` |
| `/ssh-mon info` | Dump a full snapshot of current hardware status into conversation |
| `/gpu` | Quick view of all GPU cards, VRAM usage, temperature, and training PIDs |
| `/ssh-mon help` | Display available commands and usage guide |

---

## 🤖 Agent Tool: `get_remote_hardware_info`

The extension automatically registers the `get_remote_hardware_info` tool for the AI Agent.

### Tool Definition
- **Name**: `get_remote_hardware_info`
- **Parameters**:
  - `target` *(string, optional)*: Remote SSH target. Defaults to active connected server.
  - `forceRefresh` *(boolean, optional)*: Force an immediate live query instead of cached real-time metrics.

### Example Prompts for Pi Agent
- *"Check if the GPU has enough free VRAM for me to increase the batch size from 4 to 8."*
- *"Is the training script running? Check GPU utilization."*
- *"Why is training so slow? Check if there's a CPU or memory bottleneck."*

---

## ⚙️ Requirements

- **Local Machine**:
  - Node.js >= 18
  - OpenSSH client (`ssh`)
  - SSH key-based authentication configured to the remote host (so SSH commands do not block for passwords).
- **Remote Server**:
  - Linux (Ubuntu/Debian/CentOS/Rocky, etc.)
  - Python 3 (standard on all deep learning environments; no third-party pip packages required).
  - `nvidia-smi` (for NVIDIA GPU metrics).

---

## 🧪 Development & Testing

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

## 📄 License

MIT © [newbietan](https://github.com/newbietan)
