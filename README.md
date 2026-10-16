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

- **自动模式（推荐）**：从 Agent 工具的 `command` / `cmd` 或用户的 `!` 命令中识别 `ssh`、`scp`、`sftp` 及使用 SSH 传输的 `rsync`。支持 SSH 配置别名、显式端口，以及带 `language` 的 Shell 代码和 Python 字面量 `subprocess` 参数列表。
- **指定参数启动**：
  ```bash
  pi --ssh-monitor root@192.168.1.100
  ```
- **与注册了 `--ssh` 参数的远程执行扩展联动**：
  ```bash
  pi --ssh user@my-server:/workspace
  ```

---

### 自动识别的边界

插件不会根据脚本名称、`--host` 参数或项目配置中的普通 `target` 字段猜测主机，也不会读取或执行同步脚本。对于只暴露包装脚本的命令，请显式指定目标：

```bash
PI_SSH_TARGET=user@my-server pi
# 或在 Pi 中执行：/ssh-mon connect user@my-server
```

引号中的说明文字、注释、heredoc、动态 Python 参数列表和 rsync daemon 传输不触发自动识别。复杂的认证、跳板机和代理设置请放在 `~/.ssh/config` 中；监控连接不会复制命令中的任意 SSH 选项。

### 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PI_SSH_TARGET` | 显式指定监控目标；优先级低于 `--ssh-monitor` 和 `--ssh` | 无 |
| `PI_SSH_INTERVAL` | 正常轮询间隔，单位秒，至少 1 秒 | `2` |
| `PI_SSH_TIMEOUT` | 每次探测的总超时，单位毫秒，正数 | `20000` |
| `PI_SSH_CONNECT_TIMEOUT` | SSH 连接超时，单位秒，正数 | `15` |

非法数值会回退到默认值。连接失败时重试间隔至少为 5 秒，成功后恢复正常频率；切换主机时会清空旧数据并忽略旧请求结果。紧凑模式会区分超时、认证、端口拒绝和主机名解析错误，不把缓存数据显示为实时状态。

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

显式指定其他 `target` 时仅执行一次查询，不会启动或切换持续监控。刷新当前目标时会更新其缓存；持续监控请使用自动识别或 `/ssh-mon connect`。

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
