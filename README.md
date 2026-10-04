<div align="center">

# pi-server-monitor

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Pi Package](https://img.shields.io/badge/Pi%20Package-Extension-green.svg)](https://pi.dev)
[![npm version](https://img.shields.io/npm/v/pi-server-monitor.svg)](https://www.npmjs.com/package/pi-server-monitor)

适用于 Pi Agent 的高性能远程 SSH 硬件资源实时监控扩展插件。  
专为深度学习模型训练与远程 GPU 集群环境设计。

[English Documentation](README_EN.md)

</div>

---

## 核心特性

- **无感知自动激活**：默认保持完全静默与零资源占用。当 AI Agent 在执行命令中调用 SSH（如 `bash: ssh user@host ...` 或 `scp`）时，插件自动捕获目标主机并毫秒级激活监控，无需手动输入连接指令。
- **超紧凑单行展示**：默认仅在终端输入框正上方（`aboveEditor`）显示单行状态，去除冗余图标与系统进程信息，不遮挡任何对话流或输入区域：
  ```text
  tan@100.111.71.70  │  CPU 0% (12C)  │  RAM 2.0 GB/30.6 GB (6%)  │  GPU [RTX 3070] 0% │ VRAM 130 MB/8.0 GB (2%) │ 47°C 17W
  ```
- **连接复用（OpenSSH ControlMaster）**：基于 OpenSSH 套接字复用技术，一次建立连接后，后续轮询开销仅 10–20ms，无重新鉴权开销。
- **智能体原生工具 (`get_remote_hardware_info`)**：为 Pi Agent 提供硬件自省工具，LLM 可在调参、调 batch size 前主动感知剩余显存，或诊断训练进程与数据加载瓶颈。
- **多卡与单卡自适应**：原生适配单卡训练节点、多卡集群（2卡/4卡/8卡）及无 GPU 的纯 CPU 服务器。
- **灵活的显示模式**：
  - `compact`：输入框上方极简单行展示（默认）
  - `widget`：多行 ASCII 仪表盘卡片
  - `footer`：底部状态栏紧凑单行
  - `both`：同时启用上方单行与底部状态栏
  - `none`：后台静默模式（仍可通过 Agent 工具查询）

---

## 安装方法

### 1. 通过 npm 安装（推荐）

Pi Agent 原生支持从 npm 仓库拉取并配置插件：

```bash
# 全局安装（永久生效，推荐）
pi install npm:pi-server-monitor

# 安装指定版本（例如锁定 0.2.0）
pi install npm:pi-server-monitor@0.2.0

# 仅在当前项目生效（写入当前项目的 .pi/settings.json）
pi install npm:pi-server-monitor -l
```

### 2. 免安装临时体验

无需写入本地配置文件，在当前单次会话中直接按需从 npm 临时加载：

```bash
pi -e npm:pi-server-monitor
```

### 3. 从 GitHub 仓库直接安装（备用途径）

```bash
pi install github:newbietan/pi-server-monitor
```

---

## 连接与使用

- **自动模式（推荐）**：无需任何手动操作。在对话中只要 AI Agent 执行了涉及远程主机的操作（如运行训练脚本），插件将自动开启监控。
- **指定参数启动**：
  ```bash
  pi --ssh-monitor root@192.168.1.100
  ```
- **与 Pi 原生 `--ssh` 联动**：
  ```bash
  pi --ssh user@my-server:/workspace
  ```

---

## 斜杠命令

| 命令 | 说明 |
|---|---|
| `/ssh-mon connect <target>` | 手动连接到目标主机并开启监控 |
| `/ssh-mon disconnect` | 停止监控并关闭释放 SSH 复用连接 |
| `/ssh-mon interval <seconds>` | 调整轮询频率（例如 `/ssh-mon interval 3`） |
| `/ssh-mon mode <mode>` | 切换显示模式：`compact`（默认单行）、`widget`、`footer`、`both` 或 `none` |
| `/ssh-mon info` | 在对话流中打印一次完整的硬件数据快照 |
| `/gpu` | 快捷查看所有显卡状态、显存剩余、温度及功耗 |
| `/ssh-mon help` | 查看帮助说明 |

---

## Agent 原生工具：`get_remote_hardware_info`

插件为 Pi Agent 自动注册了结构化硬件查询工具。

### 工具参数定义
- `target` *(string, optional)*：SSH 目标（user@host 或 user@host:port）。默认使用当前监控中的连接。
- `forceRefresh` *(boolean, optional)*：是否强制立即发送 SSH 探测而非读取最近缓存。

### 自然语言使用示例
- “帮我看看远端机器显存还剩多少，够不够增加 batch size？”
- “检查一下远程服务器上的 GPU 利用率，训练进程是否正常运行中。”
- “帮我分析一下为什么训练很慢，是不是存在 CPU 或内存瓶颈？”

---

## 环境要求

- **本地机器**：
  - Node.js >= 18
  - OpenSSH 客户端 (`ssh`)
  - 到远程主机的 SSH 免密登录已配置（避免密码输入阻塞）
- **远程服务器**：
  - Linux（Ubuntu/Debian/CentOS/Rocky 等）
  - Python 3（使用系统标准库，无需任何额外 pip 安装；若无则自动降级使用纯 Shell 探针）
  - `nvidia-smi`（用于 NVIDIA GPU 状态采集）

---

## 开源协议

MIT © [newbietan](https://github.com/newbietan)
