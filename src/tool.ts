import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResourceCollector } from "./collector.js";
import { formatMb } from "./ui.js";
import { executeRemoteCommand } from "./ssh.js";
import { getProbeCommand, parseProbeOutput } from "./probe.js";
import { parseSshTarget } from "./ssh.js";

export const RemoteHardwareParams = Type.Object({
  target: Type.Optional(
    Type.String({
      description:
        "Optional SSH target (user@host or user@host:port). Defaults to the current active SSH monitor target.",
    })
  ),
  forceRefresh: Type.Optional(
    Type.Boolean({
      description: "Force an immediate SSH probe query rather than returning the cached real-time metrics.",
    })
  ),
});

export type RemoteHardwareParamsType = Static<typeof RemoteHardwareParams>;

export function createRemoteHardwareTool(collector: ResourceCollector): ToolDefinition<typeof RemoteHardwareParams> {
  return {
    name: "get_remote_hardware_info",
    label: "Remote Hardware Monitor",
    description:
      "Query real-time hardware resource metrics (CPU, RAM, GPU model, GPU utilization %, VRAM usage, and active GPU training processes) of the remote SSH server. Use this when monitoring model training, checking GPU memory headroom before increasing batch size, or diagnosing performance bottlenecks.",
    promptSnippet: "Check CPU, RAM, GPU model, VRAM usage and active training processes on the remote SSH server.",
    parameters: RemoteHardwareParams,
    async execute(_toolCallId, params, signal) {
      let metrics = collector.getMetrics();
      const currentTarget = collector.getTarget();
      const targetStr = params.target || (currentTarget ? currentTarget.raw : undefined);

      if (!targetStr) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "No SSH target is configured or provided. Please specify a target (e.g. `user@host`) or connect via `/ssh-mon connect <target>` first.",
            },
          ],
          details: undefined,
        };
      }

      // If user specified a different target, or requested forceRefresh, or no cached metrics exist yet
      if (params.target || params.forceRefresh || !metrics) {
        try {
          const target = parseSshTarget(targetStr);
          const raw = await executeRemoteCommand(target, getProbeCommand(), 7000, signal);
          const parsed = parseProbeOutput(raw);
          if (!parsed) {
            throw new Error("Unable to parse probe output from remote host");
          }
          metrics = parsed;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Failed to retrieve remote hardware metrics from ${targetStr}: ${msg}`,
              },
            ],
            details: { error: msg, target: targetStr },
          };
        }
      }

      const lines: string[] = [];
      lines.push(`### Remote Hardware Status: \`${targetStr}\``);
      lines.push(
        `- **CPU**: ${metrics.cpu.percent.toFixed(1)}% (${metrics.cpu.cores} Cores${
          metrics.cpu.loadAvg ? `, Load: ${metrics.cpu.loadAvg.join(", ")}` : ""
        })`
      );
      lines.push(
        `- **RAM (System Memory)**: ${formatMb(metrics.memory.usedMb)} / ${formatMb(
          metrics.memory.totalMb
        )} (${metrics.memory.percent.toFixed(1)}% used, ${formatMb(metrics.memory.availMb)} available)`
      );

      if (!metrics.gpus || metrics.gpus.length === 0) {
        lines.push("- **GPU**: No NVIDIA GPU detected on this host.");
      } else {
        lines.push(`- **GPUs Detected**: ${metrics.gpus.length}`);
        metrics.gpus.forEach((gpu) => {
          const vramStr = `${formatMb(gpu.memoryUsedMb)} / ${formatMb(gpu.memoryTotalMb)} (${gpu.memoryPercent.toFixed(
            1
          )}% used, ${formatMb(gpu.memoryFreeMb)} free)`;
          const extra: string[] = [];
          if (gpu.temperatureC !== null && gpu.temperatureC !== undefined) {
            extra.push(`${gpu.temperatureC}°C`);
          }
          if (gpu.powerDrawW !== null && gpu.powerDrawW !== undefined) {
            extra.push(
              gpu.powerLimitW ? `${Math.round(gpu.powerDrawW)}W / ${Math.round(gpu.powerLimitW)}W` : `${Math.round(gpu.powerDrawW)}W`
            );
          }
          const extraStr = extra.length > 0 ? ` [${extra.join(" | ")}]` : "";

          lines.push(`  - **GPU ${gpu.index} (${gpu.name})**${extraStr}:`);
          lines.push(`    - Compute Utilization: ${gpu.utilGpu.toFixed(1)}%`);
          lines.push(`    - VRAM (GPU Memory): ${vramStr}`);
        });
      }

      if (metrics.processes && metrics.processes.length > 0) {
        lines.push("\n#### Active GPU Compute Processes (Training / Inference):");
        metrics.processes.forEach((proc) => {
          lines.push(`- PID \`${proc.pid}\` (\`${proc.name}\`): ${formatMb(proc.usedMemoryMb)} VRAM allocated`);
        });
      }

      return {
        content: [
          {
            type: "text",
            text: lines.join("\n"),
          },
        ],
        details: metrics,
      };
    },
  };
}
