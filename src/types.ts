export interface CpuMetrics {
  percent: number;
  cores: number;
  loadAvg?: number[];
}

export interface MemoryMetrics {
  totalMb: number;
  usedMb: number;
  availMb: number;
  percent: number;
}

export interface GpuMetrics {
  index: number;
  name: string;
  utilGpu: number; // 0-100%
  utilMem: number; // 0-100%
  memoryTotalMb: number;
  memoryUsedMb: number;
  memoryFreeMb: number;
  memoryPercent: number; // 0-100%
  temperatureC?: number | null;
  powerDrawW?: number | null;
  powerLimitW?: number | null;
}

export interface GpuComputeProcess {
  pid: number;
  name: string;
  usedMemoryMb: number;
}

export interface HardwareMetrics {
  timestamp: number;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  gpus: GpuMetrics[];
  processes: GpuComputeProcess[];
}

export type MonitorConnectionState = "idle" | "connecting" | "connected" | "error" | "stopped";

export type DisplayMode = "compact" | "widget" | "footer" | "both" | "none";

export interface MonitorConfig {
  target: string;
  intervalSec: number;
  displayMode: DisplayMode;
  enabled: boolean;
}

export interface SshTarget {
  user?: string;
  host: string;
  port?: number;
  raw: string;
}
