import test from "node:test";
import assert from "node:assert/strict";
import { parseSshTarget, getControlPath, extractSshTargetFromCommand } from "../dist/ssh.js";
import { parseProbeOutput } from "../dist/probe.js";
import { renderWidgetLines, renderCompactWidgetLines, renderFooterStatus, formatMb, renderProgressBar } from "../dist/ui.js";
import { ResourceCollector } from "../dist/collector.js";
import { createRemoteHardwareTool } from "../dist/tool.js";

test("extractSshTargetFromCommand - auto-detects targets correctly", () => {
  // Basic ssh
  assert.equal(extractSshTargetFromCommand("ssh root@10.0.0.1 'python train.py'"), "root@10.0.0.1");

  // With port
  assert.equal(extractSshTargetFromCommand("ssh -p 2222 user@gpu-node 'nvidia-smi'"), "user@gpu-node:2222");

  // With various flags (-i, -o, etc.)
  assert.equal(
    extractSshTargetFromCommand("ssh -i ~/.ssh/id_rsa -o StrictHostKeyChecking=no admin@server.corp:8022 ls"),
    "admin@server.corp:8022"
  );

  // In compound shell command
  assert.equal(
    extractSshTargetFromCommand("cd /workspace && ssh worker-1 'bash run.sh'"),
    "worker-1"
  );

  // SCP command
  assert.equal(extractSshTargetFromCommand("scp -P 22022 weights.pt user@storage-node:/data/"), "user@storage-node:22022");

  // Excluded domains (github, gitlab, huggingface, etc.)
  assert.equal(extractSshTargetFromCommand("git clone git@github.com:my-org/my-repo.git"), null);
  assert.equal(extractSshTargetFromCommand("ssh -T git@github.com"), null);

  // Non-SSH commands
  assert.equal(extractSshTargetFromCommand("ls -la && echo 'hello'"), null);
  assert.equal(extractSshTargetFromCommand(""), null);
});

test("renderCompactWidgetLines - renders ultra-compact single line", () => {
  const metrics = {
    timestamp: 1728000000,
    cpu: { percent: 45.0, cores: 32 },
    memory: { totalMb: 65536, usedMb: 32768, availMb: 32768, percent: 50.0 },
    gpus: [
      {
        index: 0,
        name: "NVIDIA A100-SXM4-80GB",
        utilGpu: 92.0,
        utilMem: 80.0,
        memoryTotalMb: 81920,
        memoryUsedMb: 65536,
        memoryFreeMb: 16384,
        memoryPercent: 80.0,
        temperatureC: 67,
        powerDrawW: 320,
      },
    ],
    processes: [{ pid: 48219, name: "python", usedMemoryMb: 64000 }],
  };

  const target = { user: "trainer", host: "gpu-01", raw: "trainer@gpu-01" };
  const lines = renderCompactWidgetLines(metrics, "connected", target);

  // Exactly 1 line
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.ok(!line.includes("🖥️"));
  assert.ok(!line.includes("PID"));
  assert.ok(line.includes("trainer@gpu-01"));
  assert.ok(line.includes("CPU 45% (32C)"));
  assert.ok(line.includes("RAM 32.0 GB/64.0 GB"));
  assert.ok(line.includes("GPU [A100-SXM4-80GB] 92%"));
  assert.ok(line.includes("VRAM 64.0 GB/80.0 GB (80%)"));
  assert.ok(line.includes("67°C"));

  // Connecting state
  const connectingLines = renderCompactWidgetLines(null, "connecting", target);
  assert.equal(connectingLines.length, 1);
  assert.ok(connectingLines[0].includes("正在连接"));

  // Error state
  const errorLines = renderCompactWidgetLines(null, "error", target);
  assert.equal(errorLines.length, 1);
  assert.ok(errorLines[0].includes("连接失败"));
});

test("parseSshTarget - parses various formats", () => {
  const t1 = parseSshTarget("root@192.168.1.100");
  assert.equal(t1.user, "root");
  assert.equal(t1.host, "192.168.1.100");
  assert.equal(t1.port, undefined);

  const t2 = parseSshTarget("user@gpu-cluster.internal:2222");
  assert.equal(t2.user, "user");
  assert.equal(t2.host, "gpu-cluster.internal");
  assert.equal(t2.port, 2222);

  const t3 = parseSshTarget("10.0.0.5");
  assert.equal(t3.user, undefined);
  assert.equal(t3.host, "10.0.0.5");
  assert.equal(t3.port, undefined);

  const path1 = getControlPath(t1);
  assert.match(path1, /pi-mon-root-192.168.1.100-22\.sock$/);
});

test("parseProbeOutput - parses valid JSON and rejects invalid", () => {
  const validJson = JSON.stringify({
    timestamp: 1728000000,
    cpu: { percent: 45.2, cores: 16, loadAvg: [2.1, 1.8, 1.2] },
    memory: { totalMb: 65536, usedMb: 32000, availMb: 33536, percent: 48.8 },
    gpus: [
      {
        index: 0,
        name: "NVIDIA A100-SXM4-80GB",
        utilGpu: 95.0,
        utilMem: 60.0,
        memoryTotalMb: 81920,
        memoryUsedMb: 65000,
        memoryFreeMb: 16920,
        memoryPercent: 79.3,
        temperatureC: 68,
        powerDrawW: 350,
        powerLimitW: 400,
      },
    ],
    processes: [{ pid: 12345, name: "python", usedMemoryMb: 64000 }],
  });

  // Test with SSH banners / MOTD preceding the JSON
  const outputWithBanner = `Welcome to Ubuntu 22.04 LTS!\nLast login: Fri Oct 4\n${validJson}\nConnection closed.`;
  const metrics = parseProbeOutput(outputWithBanner);
  assert.ok(metrics);
  assert.equal(metrics.cpu.percent, 45.2);
  assert.equal(metrics.gpus.length, 1);
  assert.equal(metrics.gpus[0].name, "NVIDIA A100-SXM4-80GB");
  assert.equal(metrics.processes.length, 1);
  assert.equal(metrics.processes[0].pid, 12345);

  // Invalid JSON should return null
  assert.equal(parseProbeOutput("Some random error message"), null);
});

test("formatMb and renderProgressBar", () => {
  assert.equal(formatMb(500), "500 MB");
  assert.equal(formatMb(16384), "16.0 GB");
  assert.equal(formatMb(1048576), "1.0 TB");

  const bar = renderProgressBar(50, 10);
  assert.match(bar, /\[█████░░░░░\]/);
  assert.match(bar, /50\.0%/);
});

test("renderWidgetLines - single GPU training node", () => {
  const metrics = {
    timestamp: 1728000000,
    cpu: { percent: 35.5, cores: 32 },
    memory: { totalMb: 65536, usedMb: 32768, availMb: 32768, percent: 50.0 },
    gpus: [
      {
        index: 0,
        name: "NVIDIA A100-SXM4-80GB",
        utilGpu: 98.0,
        utilMem: 75.0,
        memoryTotalMb: 81920,
        memoryUsedMb: 68000,
        memoryFreeMb: 13920,
        memoryPercent: 83.0,
        temperatureC: 69,
        powerDrawW: 360,
        powerLimitW: 400,
      },
    ],
    processes: [{ pid: 8844, name: "python", usedMemoryMb: 67500 }],
  };

  const target = { user: "trainer", host: "gpu-node-01", raw: "trainer@gpu-node-01" };
  const lines = renderWidgetLines(metrics, "connected", target, 2);

  assert.ok(lines.length >= 5);
  assert.ok(lines[0].includes("SSH Monitor"));
  assert.ok(lines[0].includes("trainer@gpu-node-01"));
  assert.ok(lines.some((l) => l.includes("CPU:") && l.includes("RAM:")));
  assert.ok(lines.some((l) => l.includes("GPU 0: NVIDIA A100-SXM4-80GB")));
  assert.ok(lines.some((l) => l.includes("Compute:") && l.includes("VRAM:")));
  assert.ok(lines.some((l) => l.includes("PID 8844")));
  assert.ok(lines[lines.length - 1].includes("2s refresh"));
});

test("renderWidgetLines - multi-GPU cluster", () => {
  const metrics = {
    timestamp: 1728000000,
    cpu: { percent: 80.0, cores: 64 },
    memory: { totalMb: 262144, usedMb: 131072, availMb: 131072, percent: 50.0 },
    gpus: [
      {
        index: 0,
        name: "NVIDIA RTX 4090",
        utilGpu: 99.0,
        utilMem: 80.0,
        memoryTotalMb: 24576,
        memoryUsedMb: 22000,
        memoryFreeMb: 2576,
        memoryPercent: 89.5,
        temperatureC: 65,
        powerDrawW: 410,
      },
      {
        index: 1,
        name: "NVIDIA RTX 4090",
        utilGpu: 98.0,
        utilMem: 79.0,
        memoryTotalMb: 24576,
        memoryUsedMb: 21800,
        memoryFreeMb: 2776,
        memoryPercent: 88.7,
        temperatureC: 66,
        powerDrawW: 405,
      },
    ],
    processes: [],
  };

  const target = { user: "root", host: "10.0.0.2", raw: "root@10.0.0.2" };
  const lines = renderWidgetLines(metrics, "connected", target, 3);

  assert.ok(lines.some((l) => l.includes("GPU 0 [RTX 4090]:")));
  assert.ok(lines.some((l) => l.includes("GPU 1 [RTX 4090]:")));
});

test("renderFooterStatus - generates compact status", () => {
  const metrics = {
    timestamp: 1728000000,
    cpu: { percent: 42.0, cores: 8 },
    memory: { totalMb: 32768, usedMb: 16384, availMb: 16384, percent: 50.0 },
    gpus: [
      {
        index: 0,
        name: "RTX 4090",
        utilGpu: 95.0,
        utilMem: 80.0,
        memoryTotalMb: 24576,
        memoryUsedMb: 22000,
        memoryFreeMb: 2576,
        memoryPercent: 89.5,
      },
    ],
    processes: [],
  };

  const target = { user: "ai", host: "192.168.1.50", raw: "ai@192.168.1.50" };
  const status = renderFooterStatus(metrics, "connected", target);

  assert.match(status, /CPU: 42%/);
  assert.match(status, /RAM: 16\.0 GB\/32\.0 GB/);
  assert.match(status, /GPU: 95%/);
  assert.match(status, /VRAM: 21\.5 GB\/24\.0 GB/);
});

test("ResourceCollector and Tool integration", async () => {
  const collector = new ResourceCollector("train@node1:22", 3);
  assert.equal(collector.getTarget()?.host, "node1");
  assert.equal(collector.getTarget()?.port, 22);
  assert.equal(collector.getIntervalSec(), 3);

  collector.setInterval(5);
  assert.equal(collector.getIntervalSec(), 5);

  const tool = createRemoteHardwareTool(collector);
  assert.equal(tool.name, "get_remote_hardware_info");
  assert.ok(tool.description.includes("hardware resource metrics"));

  // Execute tool without cached metrics and invalid host to verify error handling
  const result = await tool.execute(
    "call-1",
    { target: "invalid.nonexistent.domain.xyz:9999", forceRefresh: true },
    undefined,
    undefined,
    {}
  );
  assert.ok(result.isError);
  assert.match(result.content[0].text, /Failed to retrieve remote hardware metrics/);
});

