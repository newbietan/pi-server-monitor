import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ResourceCollector } from "./collector.js";
import { createRemoteHardwareTool } from "./tool.js";
import { formatMb, renderFooterStatus, renderWidgetLines } from "./ui.js";
import type { DisplayMode } from "./types.js";

export default function sshServerMonitorExtension(pi: ExtensionAPI): void {
  // Register CLI flags
  pi.registerFlag("ssh-monitor", {
    description: "Remote SSH target for resource monitoring (user@host or user@host:port)",
    type: "string",
  });

  const collector = new ResourceCollector();
  let displayMode: DisplayMode = "widget";
  let activeContext: ExtensionContext | null = null;

  function refreshUI(): void {
    if (!activeContext || !activeContext.hasUI) return;

    const metrics = collector.getMetrics();
    const state = collector.getState();
    const target = collector.getTarget();
    const intervalSec = collector.getIntervalSec();
    const theme = activeContext.ui.theme;

    // Above editor widget
    if (displayMode === "widget" || displayMode === "both") {
      const widgetLines = renderWidgetLines(metrics, state, target, intervalSec, theme);
      activeContext.ui.setWidget("ssh-monitor", widgetLines, { placement: "aboveEditor" });
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

  // Subscribe collector updates to TUI
  collector.onMetrics(() => {
    refreshUI();
  });

  collector.onStatusChange((_state, _error) => {
    refreshUI();
  });

  // Register Agent tool for LLM to query hardware info during training
  pi.registerTool(createRemoteHardwareTool(collector));

  // Hook session start
  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;

    // Detect target: --ssh-monitor -> --ssh -> PI_SSH_TARGET env
    let target = pi.getFlag("ssh-monitor") as string | undefined;

    if (!target) {
      const piSshFlag = pi.getFlag("ssh") as string | undefined;
      if (piSshFlag) {
        // Handle user@host:/path syntax from pi --ssh flag
        if (piSshFlag.includes(":")) {
          const colonIdx = piSshFlag.indexOf(":");
          target = piSshFlag.slice(0, colonIdx);
        } else {
          target = piSshFlag;
        }
      }
    }

    if (!target && process.env.PI_SSH_TARGET) {
      target = process.env.PI_SSH_TARGET;
    }

    if (target) {
      collector.setTarget(target);
      collector.start();
      ctx.ui.notify(`SSH Monitor connected to ${target}`, "info");
      refreshUI();
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
          const val = Number.parseInt(parts[1], 10);
          if (isNaN(val) || val < 1) {
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
          if (mode !== "widget" && mode !== "footer" && mode !== "both" && mode !== "none") {
            ctx.ui.notify("Usage: /ssh-mon mode <widget | footer | both | none>", "error");
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
            "SSH Server Hardware Resource Monitor Commands:",
            "  /ssh-mon connect <target>  - Connect to user@host[:port] and start monitoring",
            "  /ssh-mon disconnect        - Stop monitoring and release SSH sockets",
            "  /ssh-mon interval <sec>    - Set polling interval (default: 2s)",
            "  /ssh-mon mode <mode>       - Set display mode: widget | footer | both | none",
            "  /ssh-mon info              - Show current resource snapshot",
            "  /gpu                       - Quick view of GPU VRAM & active training processes",
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
