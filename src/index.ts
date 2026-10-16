import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ResourceCollector } from "./collector.js";
import { createRemoteHardwareTool } from "./tool.js";
import { formatMb, renderCompactWidgetLines, renderFooterStatus, renderWidgetLines } from "./ui.js";
import { extractSshTargetFromCommand, extractSshTargetFromCode } from "./ssh.js";
import type { DisplayMode } from "./types.js";

export default function sshServerMonitorExtension(pi: ExtensionAPI): void {
  // Register CLI flags
  pi.registerFlag("ssh-monitor", {
    description: "Remote SSH target for resource monitoring (user@host or user@host:port)",
    type: "string",
  });

  const collector = new ResourceCollector();
  // Default to ultra-compact single line above editor
  let displayMode: DisplayMode = "compact";
  let activeContext: ExtensionContext | null = null;

  function refreshUI(): void {
    if (!activeContext || !activeContext.hasUI) return;

    const target = collector.getTarget();
    const state = collector.getState();

    // If idle or stopped or no target, keep UI clean and invisible
    if (!target || state === "idle" || state === "stopped") {
      activeContext.ui.setWidget("ssh-monitor", undefined);
      activeContext.ui.setStatus("ssh-monitor", undefined);
      return;
    }

    const metrics = collector.getMetrics();
    const intervalSec = collector.getIntervalSec();
    const lastError = collector.getLastError();
    const theme = activeContext.ui.theme;

    // Above editor widget: single compact line by default
    if (displayMode === "compact") {
      const compactLines = renderCompactWidgetLines(metrics, state, target, theme, 200, lastError);
      activeContext.ui.setWidget("ssh-monitor", compactLines, { placement: "aboveEditor" });
    } else if (displayMode === "widget") {
      const widgetLines = renderWidgetLines(metrics, state, target, intervalSec, theme);
      activeContext.ui.setWidget("ssh-monitor", widgetLines, { placement: "aboveEditor" });
    } else if (displayMode === "both") {
      const compactLines = renderCompactWidgetLines(metrics, state, target, theme, 200, lastError);
      activeContext.ui.setWidget("ssh-monitor", compactLines, { placement: "aboveEditor" });
    } else {
      activeContext.ui.setWidget("ssh-monitor", undefined);
    }

    // Footer status bar
    if (displayMode === "footer" || displayMode === "both") {
      const statusText = renderFooterStatus(metrics, state, target, theme);
      activeContext.ui.setStatus("ssh-monitor", statusText);
    } else {
      activeContext.ui.setStatus("ssh-monitor", undefined);
    }
  }

  function detectAndActivateSsh(detectedTarget: string | null, ctx?: ExtensionContext): void {
    if (!detectedTarget) return;

    const currentTarget = collector.getTarget();
    const currentState = collector.getState();

    // Auto-activate if target is new or collector is not active
    if (!currentTarget || currentTarget.raw !== detectedTarget || currentState === "idle" || currentState === "stopped") {
      collector.setTarget(detectedTarget);
      collector.start();
      if (ctx?.hasUI) {
        ctx.ui.notify(`🖥️ 检测到 SSH 远程操作，已自动启用硬件监控: ${detectedTarget}`, "info");
      }
      refreshUI();
    }
  }

  // Subscribe collector updates to TUI
  collector.onMetrics(() => {
    refreshUI();
  });

  collector.onStatusChange((_state, _error) => {
    refreshUI();
  });

  // Register Agent tool for LLM to query hardware info during training
  pi.registerTool(createRemoteHardwareTool(collector));

  // Seamless auto-detection: watch Agent tool calls (bash, powershell, custom tools)
  pi.on("tool_call", (event, ctx) => {
    activeContext = ctx;
    const input = event.input as Record<string, unknown>;
    let detected: string | null = null;
    if (typeof input?.command === "string") {
      detected = extractSshTargetFromCommand(input.command);
    } else if (typeof input?.cmd === "string") {
      detected = extractSshTargetFromCommand(input.cmd);
    } else if (typeof input?.code === "string" && typeof input.language === "string") {
      detected = extractSshTargetFromCode(input.code, input.language);
    }
    detectAndActivateSsh(detected, ctx);
  });

  // Also watch interactive user bash commands (e.g. !ssh user@host)
  pi.on("user_bash", (event, ctx) => {
    activeContext = ctx;
    if (event.command) {
      detectAndActivateSsh(extractSshTargetFromCommand(event.command), ctx);
    }
  });

  // Hook session start - only connect if explicitly requested via CLI flag or env
  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;

    // Detect target: --ssh-monitor -> --ssh -> PI_SSH_TARGET env
    let target = pi.getFlag("ssh-monitor") as string | undefined;

    if (!target) {
      const piSshFlag = pi.getFlag("ssh") as string | undefined;
      if (piSshFlag) {
        // The SSH remote-execution extension accepts user@host:/path.
        // Keep bracketed IPv6 addresses intact when removing the remote path.
        target = /^((?:[^@\s:]+@)?(?:\[[^\]]+\]|[^:\s]+))(?::.*)?$/.exec(piSshFlag)?.[1] ?? piSshFlag;
      }
    }

    if (!target && process.env.PI_SSH_TARGET) {
      target = process.env.PI_SSH_TARGET;
    }

    // Do not infer a target from project scripts or unrelated settings.
    const interval = Number(process.env.PI_SSH_INTERVAL);
    if (Number.isFinite(interval) && interval >= 1 && interval * 1000 <= 2_147_483_647) {
      collector.setInterval(interval);
    }

    // Only start if explicitly specified at startup; otherwise wait for seamless auto-detection
    if (target) {
      try {
        collector.setTarget(target);
        collector.start();
        if (ctx.hasUI) ctx.ui.notify(`SSH Monitor connecting to ${target}...`, "info");
        refreshUI();
      } catch (err: unknown) {
        if (ctx.hasUI) ctx.ui.notify(`Invalid SSH monitor target: ${String(err)}`, "error");
      }
    }
  });

  // Hook session shutdown
  pi.on("session_shutdown", async (_event, ctx) => {
    await collector.stop();
    if (ctx.hasUI) {
      ctx.ui.setWidget("ssh-monitor", undefined);
      ctx.ui.setStatus("ssh-monitor", undefined);
    }
    activeContext = null;
  });

  // Register slash command /ssh-mon
  pi.registerCommand("ssh-mon", {
    description: "Manage SSH remote resource monitor (/ssh-mon connect|disconnect|interval|mode|info)",
    handler: async (args, ctx) => {
      activeContext = ctx;
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0]?.toLowerCase() || "help";

      switch (action) {
        case "connect": {
          const target = parts[1];
          if (!target) {
            ctx.ui.notify("Usage: /ssh-mon connect <user@host[:port]>", "error");
            return;
          }
          collector.setTarget(target);
          collector.start();
          ctx.ui.notify(`Connecting to ${target}...`, "info");
          refreshUI();
          break;
        }

        case "disconnect":
        case "stop": {
          await collector.stop();
          if (ctx.hasUI) {
            ctx.ui.setWidget("ssh-monitor", undefined);
            ctx.ui.setStatus("ssh-monitor", undefined);
          }
          ctx.ui.notify("SSH Monitor disconnected and stopped", "info");
          break;
        }

        case "interval": {
          const val = Number(parts[1]);
          if (!Number.isFinite(val) || val < 1 || val * 1000 > 2_147_483_647) {
            ctx.ui.notify("Usage: /ssh-mon interval <seconds (>=1)>", "error");
            return;
          }
          collector.setInterval(val);
          ctx.ui.notify(`Refresh interval set to ${val}s`, "info");
          refreshUI();
          break;
        }

        case "mode": {
          const mode = parts[1]?.toLowerCase() as DisplayMode | undefined;
          if (mode !== "compact" && mode !== "widget" && mode !== "footer" && mode !== "both" && mode !== "none") {
            ctx.ui.notify("Usage: /ssh-mon mode <compact | widget | footer | both | none>", "error");
            return;
          }
          displayMode = mode;
          ctx.ui.notify(`Display mode set to '${mode}'`, "info");
          refreshUI();
          break;
        }

        case "info": {
          const metrics = collector.getMetrics();
          const target = collector.getTarget();
          if (!metrics || !target) {
            ctx.ui.notify("No metrics available. Make sure SSH monitor is connected.", "warning");
            return;
          }
          const infoLines = [
            `🖥️ Host: ${target.raw}`,
            `• CPU: ${metrics.cpu.percent.toFixed(1)}% (${metrics.cpu.cores} cores)`,
            `• RAM: ${formatMb(metrics.memory.usedMb)} / ${formatMb(metrics.memory.totalMb)} (${metrics.memory.percent.toFixed(1)}%)`,
          ];
          if (metrics.gpus.length > 0) {
            infoLines.push(`• GPUs (${metrics.gpus.length}):`);
            metrics.gpus.forEach((g) => {
              infoLines.push(
                `  - [GPU ${g.index}] ${g.name}: ${g.utilGpu}% compute, VRAM: ${formatMb(g.memoryUsedMb)}/${formatMb(g.memoryTotalMb)} (${g.memoryPercent}%)`
              );
            });
          }
          ctx.ui.notify(infoLines.join("\n"), "info");
          break;
        }

        case "help":
        default: {
          const helpText = [
            "SSH Server Hardware Resource Monitor (无感知自动监控):",
            "  • 自动模式: 当 AI Agent 或你在控制台执行 ssh 命令时，自动激活单行微型监控",
            "  • 手动命令:",
            "    /ssh-mon connect <target>  - 手动连接指定目标",
            "    /ssh-mon disconnect        - 停止监控并释放 SSH 连接",
            "    /ssh-mon mode <mode>       - 显示模式: compact(单行) | widget(大卡片) | footer | both | none",
            "    /ssh-mon interval <sec>    - 调整刷新频率 (默认: 2s)",
            "    /ssh-mon info              - 显示硬件信息快照",
            "    /gpu                       - 快速查看 GPU 算力、显存与训练进程",
          ].join("\n");
          ctx.ui.notify(helpText, "info");
          break;
        }
      }
    },
  });

  // Register shortcut command /gpu
  pi.registerCommand("gpu", {
    description: "Quick view of remote GPU status, VRAM usage, and active training processes",
    handler: async (_args, ctx) => {
      const metrics = collector.getMetrics();
      const target = collector.getTarget();

      if (!metrics) {
        ctx.ui.notify("No GPU data available. Use `/ssh-mon connect <user@host>` to connect.", "warning");
        return;
      }

      if (!metrics.gpus || metrics.gpus.length === 0) {
        ctx.ui.notify(`Server ${target?.raw || ""}: No NVIDIA GPU detected (CPU training mode).`, "info");
        return;
      }

      const lines: string[] = [`GPU Status for ${target?.raw || "Remote Host"}:`];
      metrics.gpus.forEach((g) => {
        const temp = g.temperatureC ? ` | ${g.temperatureC}°C` : "";
        const power = g.powerDrawW ? ` | ${Math.round(g.powerDrawW)}W` : "";
        lines.push(
          `• [GPU ${g.index}] ${g.name}: ${g.utilGpu.toFixed(0)}% compute | VRAM: ${formatMb(g.memoryUsedMb)} / ${formatMb(g.memoryTotalMb)} (${g.memoryPercent.toFixed(1)}%)${temp}${power}`
        );
      });

      if (metrics.processes && metrics.processes.length > 0) {
        lines.push("• Active GPU Processes (Training):");
        metrics.processes.forEach((p) => {
          lines.push(`  - PID ${p.pid} (${p.name}): ${formatMb(p.usedMemoryMb)} VRAM`);
        });
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
