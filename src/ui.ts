import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GpuMetrics, HardwareMetrics, MonitorConnectionState, SshTarget } from "./types.js";

interface ThemeLike {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

export function formatMb(mb: number): string {
  if (mb >= 1024 * 1024) {
    return `${(mb / (1024 * 1024)).toFixed(1)} TB`;
  }
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}

/**
 * Render a progress bar e.g. [██████░░░░░░] 52.3%
 */
export function renderProgressBar(
  percent: number,
  barWidth = 10,
  theme?: ThemeLike
): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filledCount = Math.round((clamped / 100) * barWidth);
  const emptyCount = Math.max(0, barWidth - filledCount);

  const filledStr = "█".repeat(filledCount);
  const emptyStr = "░".repeat(emptyCount);
  const bar = filledStr + emptyStr;

  let coloredBar = bar;
  if (theme) {
    if (clamped >= 85) {
      coloredBar = theme.fg("error", bar);
    } else if (clamped >= 60) {
      coloredBar = theme.fg("warning", bar);
    } else {
      coloredBar = theme.fg("success", bar);
    }
  }

  const pctStr = `${clamped.toFixed(1)}%`.padStart(6, " ");
  return `[${coloredBar}] ${pctStr}`;
}

/**
 * Render full multi-line widget content for placement above/below editor
 */
export function renderWidgetLines(
  metrics: HardwareMetrics | null,
  state: MonitorConnectionState,
  target: SshTarget | null,
  intervalSec: number,
  theme?: ThemeLike,
  maxWidth = 88
): string[] {
  const targetLabel = target ? (target.user ? `${target.user}@${target.host}` : target.host) : "No Target";
  const stateBadge =
    state === "connected"
      ? theme ? theme.fg("success", "● Connected") : "● Connected"
      : state === "connecting"
      ? theme ? theme.fg("warning", "◌ Connecting...") : "◌ Connecting..."
      : state === "error"
      ? theme ? theme.fg("error", "✕ Disconnected") : "✕ Disconnected"
      : "○ Idle";

  const lines: string[] = [];

  // Top header border
  const title = ` SSH Monitor [${targetLabel}] (${stateBadge}) `;
  const titleLen = visibleWidth(` SSH Monitor [${targetLabel}] (● Connected) `);
  const topBorderFill = Math.max(2, maxWidth - titleLen - 4);
  const headerLine = `┌─${title}${"─".repeat(topBorderFill)}┐`;
  lines.push(headerLine);

  if (state === "connecting" && !metrics) {
    lines.push(padLine(`  Connecting to ${targetLabel}... Establishing SSH multiplexed channel...`, maxWidth));
    lines.push(renderBottomBorder(intervalSec, maxWidth));
    return lines;
  }

  if (state === "error" && !metrics) {
    const errText = theme ? theme.fg("error", "  Failed to connect or fetch remote metrics. Check SSH connection/key.") : "  Failed to connect. Check SSH keys.";
    lines.push(padLine(errText, maxWidth));
    lines.push(renderBottomBorder(intervalSec, maxWidth));
    return lines;
  }

  if (!metrics) {
    lines.push(padLine("  No metrics available yet. Polling remote host...", maxWidth));
    lines.push(renderBottomBorder(intervalSec, maxWidth));
    return lines;
  }

  // CPU & RAM Line
  const cpuBar = renderProgressBar(metrics.cpu.percent, 8, theme);
  const memBar = renderProgressBar(metrics.memory.percent, 8, theme);
  const cpuInfo = `CPU: ${cpuBar} (${metrics.cpu.cores}C)`;
  const memInfo = `RAM: ${memBar} (${formatMb(metrics.memory.usedMb)}/${formatMb(metrics.memory.totalMb)})`;
  lines.push(padLine(`  ${cpuInfo}  │  ${memInfo}`, maxWidth));

  // GPU Section
  if (!metrics.gpus || metrics.gpus.length === 0) {
    const gpuLabel = theme ? theme.fg("dim", "GPU: No NVIDIA GPU detected (CPU mode)") : "GPU: No NVIDIA GPU detected (CPU mode)";
    lines.push(padLine(`  ${gpuLabel}`, maxWidth));
  } else if (metrics.gpus.length === 1) {
    // Single GPU (Typical for individual training node)
    const gpu = metrics.gpus[0];
    const gpuName = theme ? theme.bold(gpu.name) : gpu.name;
    lines.push(padLine(`  GPU 0: ${gpuName}`, maxWidth));

    const gpuUtilBar = renderProgressBar(gpu.utilGpu, 8, theme);
    const vramBar = renderProgressBar(gpu.memoryPercent, 8, theme);
    const computeStr = `Compute: ${gpuUtilBar}`;
    const vramStr = `VRAM: ${vramBar} (${formatMb(gpu.memoryUsedMb)}/${formatMb(gpu.memoryTotalMb)})`;
    lines.push(padLine(`    ${computeStr}  │  ${vramStr}`, maxWidth));

    // Secondary line: Temp, Power, and active training process
    const extraParts: string[] = [];
    if (gpu.temperatureC !== null && gpu.temperatureC !== undefined) {
      const tempColor = gpu.temperatureC > 82 ? "error" : gpu.temperatureC > 72 ? "warning" : "success";
      extraParts.push(theme ? theme.fg(tempColor, `${gpu.temperatureC}°C`) : `${gpu.temperatureC}°C`);
    }
    if (gpu.powerDrawW !== null && gpu.powerDrawW !== undefined) {
      const powerStr = gpu.powerLimitW ? `${Math.round(gpu.powerDrawW)}W/${Math.round(gpu.powerLimitW)}W` : `${Math.round(gpu.powerDrawW)}W`;
      extraParts.push(powerStr);
    }

    // Check active compute processes (e.g. python train.py)
    if (metrics.processes && metrics.processes.length > 0) {
      const p = metrics.processes[0];
      const procDesc = `PID ${p.pid} (${p.name}): ${formatMb(p.usedMemoryMb)}`;
      extraParts.push(theme ? theme.fg("accent", procDesc) : procDesc);
    }

    if (extraParts.length > 0) {
      lines.push(padLine(`    Status: ${extraParts.join(" │ ")}`, maxWidth));
    }
  } else {
    // Multi-GPU (e.g. 2x, 4x, 8x GPU Training Cluster)
    const maxGpusToShow = Math.min(metrics.gpus.length, 4);
    for (let i = 0; i < maxGpusToShow; i++) {
      const gpu = metrics.gpus[i];
      const line = renderMultiGpuRow(gpu, theme);
      lines.push(padLine(`  ${line}`, maxWidth));
    }
    if (metrics.gpus.length > maxGpusToShow) {
      const remaining = metrics.gpus.length - maxGpusToShow;
      const moreMsg = theme ? theme.fg("dim", `  ... and ${remaining} more GPU(s). Use /ssh-mon info for all.`) : `  ... and ${remaining} more GPU(s).`;
      lines.push(padLine(moreMsg, maxWidth));
    }
  }

  // Bottom Border with refresh interval
  lines.push(renderBottomBorder(intervalSec, maxWidth));

  return lines;
}

function renderMultiGpuRow(gpu: GpuMetrics, theme?: ThemeLike): string {
  const shortName = gpu.name.replace(/NVIDIA /g, "").replace(/GeForce /g, "").slice(0, 14);
  const utilStr = `${Math.round(gpu.utilGpu)}%`.padStart(4, " ");
  const vramBar = renderProgressBar(gpu.memoryPercent, 6, theme);
  const memStr = `${formatMb(gpu.memoryUsedMb)}/${formatMb(gpu.memoryTotalMb)}`;
  const tempStr = gpu.temperatureC !== null && gpu.temperatureC !== undefined ? `${gpu.temperatureC}°C` : "";
  const powerStr = gpu.powerDrawW !== null && gpu.powerDrawW !== undefined ? `${Math.round(gpu.powerDrawW)}W` : "";

  const gpuLabel = `GPU ${gpu.index} [${shortName}]:`;
  const parts = [`${gpuLabel} ${utilStr}`, `VRAM: ${vramBar} (${memStr})`];
  if (tempStr) parts.push(tempStr);
  if (powerStr) parts.push(powerStr);

  return parts.join(" │ ");
}

function padLine(content: string, width: number): string {
  const vLen = visibleWidth(content);
  if (vLen >= width - 2) {
    return `│ ${truncateToWidth(content, width - 4)} │`;
  }
  const rightPad = " ".repeat(Math.max(0, width - vLen - 2));
  return `│${content}${rightPad}│`;
}

function renderBottomBorder(intervalSec: number, maxWidth: number): string {
  const label = ` ⏱️ ${intervalSec}s refresh ─┘`;
  const fillLen = Math.max(2, maxWidth - visibleWidth(label) - 1);
  return `└${"─".repeat(fillLen)}${label}`;
}

/**
 * Render compact single-line widget content for placement above editor
 * Takes up exactly 1 line, minimal and clean.
 */
export function renderCompactWidgetLines(
  metrics: HardwareMetrics | null,
  state: MonitorConnectionState,
  target: SshTarget | null,
  theme?: ThemeLike,
  maxWidth = 200
): string[] {
  const targetLabel = target ? (target.user ? `${target.user}@${target.host}` : target.host) : "Remote";

  if (state === "connecting" && !metrics) {
    const text = `SSH [${targetLabel}]: 正在连接并探测硬件资源...`;
    return [theme ? theme.fg("warning", text) : text];
  }
  if (state === "error" && !metrics) {
    const text = `SSH [${targetLabel}]: 连接失败 (请检查 SSH 秘钥/端口)`;
    return [theme ? theme.fg("error", text) : text];
  }
  if (!metrics) {
    return [];
  }

  const parts: string[] = [];

  // Target tag (no leading icon)
  const hostTag = targetLabel;
  parts.push(theme ? theme.bold(theme.fg("accent", hostTag)) : hostTag);

  // CPU
  const cpuPct = `${Math.round(metrics.cpu.percent)}%`;
  const cpuColored =
    theme && metrics.cpu.percent >= 85
      ? theme.fg("error", cpuPct)
      : theme && metrics.cpu.percent >= 60
      ? theme.fg("warning", cpuPct)
      : cpuPct;
  parts.push(`CPU ${cpuColored} (${metrics.cpu.cores}C)`);

  // RAM
  const ramUsed = formatMb(metrics.memory.usedMb);
  const ramTotal = formatMb(metrics.memory.totalMb);
  const memPct = `${Math.round(metrics.memory.percent)}%`;
  const memColored =
    theme && metrics.memory.percent >= 85
      ? theme.fg("error", memPct)
      : theme && metrics.memory.percent >= 65
      ? theme.fg("warning", memPct)
      : memPct;
  parts.push(`RAM ${ramUsed}/${ramTotal} (${memColored})`);

  // GPU
  if (!metrics.gpus || metrics.gpus.length === 0) {
    const noGpu = theme ? theme.fg("dim", "CPU-only") : "CPU-only";
    parts.push(noGpu);
  } else if (metrics.gpus.length === 1) {
    const g = metrics.gpus[0];
    const shortName = g.name.replace(/NVIDIA /g, "").replace(/GeForce /g, "").trim().slice(0, 16);
    const gpuCompute = `${Math.round(g.utilGpu)}%`;
    const vramStr = `${formatMb(g.memoryUsedMb)}/${formatMb(g.memoryTotalMb)}`;
    const vramPct = `${Math.round(g.memoryPercent)}%`;

    const vramColored =
      theme && g.memoryPercent >= 85
        ? theme.fg("error", vramPct)
        : theme && g.memoryPercent >= 65
        ? theme.fg("warning", vramPct)
        : vramPct;

    let gpuSegment = `GPU [${shortName}] ${gpuCompute} │ VRAM ${vramStr} (${vramColored})`;
    if (g.temperatureC !== null && g.temperatureC !== undefined) {
      const tempColor = g.temperatureC > 82 ? "error" : g.temperatureC > 72 ? "warning" : "success";
      gpuSegment += ` │ ${theme ? theme.fg(tempColor, `${g.temperatureC}°C`) : `${g.temperatureC}°C`}`;
    }
    if (g.powerDrawW !== null && g.powerDrawW !== undefined) {
      gpuSegment += ` ${Math.round(g.powerDrawW)}W`;
    }
    parts.push(gpuSegment);
  } else {
    // Multi GPU
    const avgUtil = Math.round(metrics.gpus.reduce((acc, g) => acc + g.utilGpu, 0) / metrics.gpus.length);
    const totalUsed = metrics.gpus.reduce((acc, g) => acc + g.memoryUsedMb, 0);
    const totalMem = metrics.gpus.reduce((acc, g) => acc + g.memoryTotalMb, 0);
    const totalPct = Math.round((totalUsed / (totalMem || 1)) * 100);
    const maxTemp = Math.max(...metrics.gpus.map((g) => g.temperatureC || 0));

    const totalPctColored =
      theme && totalPct >= 85
        ? theme.fg("error", `${totalPct}%`)
        : theme && totalPct >= 65
        ? theme.fg("warning", `${totalPct}%`)
        : `${totalPct}%`;

    let gpuSegment = `${metrics.gpus.length}xGPU Avg ${avgUtil}% │ VRAM ${formatMb(totalUsed)}/${formatMb(totalMem)} (${totalPctColored})`;
    if (maxTemp > 0) {
      const tempColor = maxTemp > 82 ? "error" : maxTemp > 72 ? "warning" : "success";
      gpuSegment += ` │ Max ${theme ? theme.fg(tempColor, `${maxTemp}°C`) : `${maxTemp}°C`}`;
    }
    parts.push(gpuSegment);
  }

  const rawLine = parts.join("  │  ");
  return [maxWidth > 0 && visibleWidth(rawLine) > maxWidth ? truncateToWidth(rawLine, maxWidth) : rawLine];
}

/**
 * Render compact footer status text for ctx.ui.setStatus()
 */
export function renderFooterStatus(
  metrics: HardwareMetrics | null,
  state: MonitorConnectionState,
  target: SshTarget | null,
  theme?: ThemeLike
): string {
  if (state === "connecting") {
    return theme ? theme.fg("warning", "⚡ SSH [Connecting...]") : "⚡ SSH [Connecting...]";
  }
  if (state === "error" || !metrics) {
    return theme ? theme.fg("error", "✕ SSH [Disconnected]") : "✕ SSH [Disconnected]";
  }

  const cpuPct = `${Math.round(metrics.cpu.percent)}%`;
  const memPct = `${Math.round(metrics.memory.percent)}%`;
  const ramStr = `${formatMb(metrics.memory.usedMb)}/${formatMb(metrics.memory.totalMb)}`;

  let gpuStr = "No GPU";
  if (metrics.gpus.length === 1) {
    const g = metrics.gpus[0];
    gpuStr = `GPU: ${Math.round(g.utilGpu)}% (VRAM: ${formatMb(g.memoryUsedMb)}/${formatMb(g.memoryTotalMb)})`;
  } else if (metrics.gpus.length > 1) {
    const avgUtil = Math.round(metrics.gpus.reduce((acc, g) => acc + g.utilGpu, 0) / metrics.gpus.length);
    const totalUsed = metrics.gpus.reduce((acc, g) => acc + g.memoryUsedMb, 0);
    const totalMem = metrics.gpus.reduce((acc, g) => acc + g.memoryTotalMb, 0);
    gpuStr = `${metrics.gpus.length}xGPU: ${avgUtil}% (VRAM: ${formatMb(totalUsed)}/${formatMb(totalMem)})`;
  }

  const text = `🖥️ CPU: ${cpuPct} │ RAM: ${ramStr} (${memPct}) │ ${gpuStr}`;
  return theme ? theme.fg("accent", text) : text;
}
