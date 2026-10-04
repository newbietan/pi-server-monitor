declare const Buffer: {
  from(data: string, encoding?: string): {
    toString(encoding: string): string;
  };
};

import type { HardwareMetrics } from "./types.js";

/**
 * Embedded python script that collects CPU, Memory, GPU and compute process metrics.
 * Runs on standard library only: sys, os, subprocess, json, time.
 */
const PYTHON_PROBE_SCRIPT = `
import sys, os, subprocess, json, time

def get_cpu():
    if sys.platform == 'darwin':
        try:
            load = os.getloadavg()
            cores = os.cpu_count() or 1
            pct = round(min(100.0, (load[0] / cores) * 100.0), 1)
            return {"percent": pct, "cores": cores, "loadAvg": [round(x, 2) for x in load]}
        except Exception:
            return {"percent": 0.0, "cores": 1}
    try:
        def read_stat():
            with open('/proc/stat', 'r') as f:
                fields = [float(x) for x in f.readline().split()[1:8]]
                idle = fields[3] + fields[4]
                total = sum(fields)
                return idle, total
        i1, t1 = read_stat()
        time.sleep(0.08)
        i2, t2 = read_stat()
        dt = t2 - t1
        di = i2 - i1
        pct = round(100.0 * (1.0 - di / dt), 1) if dt > 0 else 0.0
        return {"percent": max(0.0, min(100.0, pct)), "cores": os.cpu_count() or 1}
    except Exception:
        try:
            load = os.getloadavg()
            cores = os.cpu_count() or 1
            pct = round(min(100.0, (load[0] / cores) * 100.0), 1)
            return {"percent": pct, "cores": cores, "loadAvg": [round(x, 2) for x in load]}
        except Exception:
            return {"percent": 0.0, "cores": 1}

def get_mem():
    if sys.platform == 'darwin':
        try:
            out = subprocess.check_output(['sysctl', '-n', 'hw.memsize']).decode().strip()
            total_mb = round(int(out) / (1024 * 1024))
            return {"totalMb": total_mb, "usedMb": round(total_mb * 0.5), "availMb": round(total_mb * 0.5), "percent": 50.0}
        except Exception:
            pass
    try:
        mem = {}
        with open('/proc/meminfo', 'r') as f:
            for line in f:
                parts = line.split(':')
                if len(parts) == 2:
                    k = parts[0].strip()
                    v = parts[1].strip().split()[0]
                    mem[k] = int(v)
        total_mb = round(mem.get('MemTotal', 0) / 1024)
        avail_mb = round(mem.get('MemAvailable', mem.get('MemFree', 0)) / 1024)
        used_mb = max(0, total_mb - avail_mb)
        pct = round((used_mb / total_mb) * 100, 1) if total_mb > 0 else 0.0
        return {"totalMb": total_mb, "usedMb": used_mb, "availMb": avail_mb, "percent": pct}
    except Exception:
        return {"totalMb": 0, "usedMb": 0, "availMb": 0, "percent": 0.0}

def get_gpus():
    try:
        res = subprocess.run([
            'nvidia-smi',
            '--query-gpu=index,name,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free,temperature.gpu,power.draw,power.limit',
            '--format=csv,noheader,nounits'
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=2)
        if res.returncode != 0:
            return []
        gpus = []
        for line in res.stdout.strip().split('\\n'):
            line = line.strip()
            if not line: continue
            parts = [p.strip() for p in line.split(',')]
            if len(parts) >= 7:
                def safe_float(v, default=0.0):
                    try: return float(v)
                    except: return default
                idx = int(parts[0])
                name = parts[1]
                util_gpu = safe_float(parts[2])
                util_mem = safe_float(parts[3])
                mem_total = safe_float(parts[4])
                mem_used = safe_float(parts[5])
                mem_free = safe_float(parts[6])
                temp_c = safe_float(parts[7], None) if len(parts) > 7 and parts[7] != '[N/A]' else None
                p_draw = safe_float(parts[8], None) if len(parts) > 8 and parts[8] != '[N/A]' else None
                p_lim = safe_float(parts[9], None) if len(parts) > 9 and parts[9] != '[N/A]' else None
                mem_pct = round((mem_used / mem_total) * 100, 1) if mem_total > 0 else 0.0
                gpus.append({
                    "index": idx,
                    "name": name,
                    "utilGpu": util_gpu,
                    "utilMem": util_mem,
                    "memoryTotalMb": round(mem_total),
                    "memoryUsedMb": round(mem_used),
                    "memoryFreeMb": round(mem_free),
                    "memoryPercent": mem_pct,
                    "temperatureC": temp_c,
                    "powerDrawW": p_draw,
                    "powerLimitW": p_lim
                })
        return gpus
    except Exception:
        return []

def get_compute_processes():
    try:
        res = subprocess.run([
            'nvidia-smi',
            '--query-compute-apps=gpu_uuid,pid,process_name,used_memory',
            '--format=csv,noheader,nounits'
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=2)
        if res.returncode != 0:
            return []
        procs = []
        for line in res.stdout.strip().split('\\n'):
            line = line.strip()
            if not line: continue
            parts = [p.strip() for p in line.split(',')]
            if len(parts) >= 4:
                def safe_float(v, default=0.0):
                    try: return float(v)
                    except: return default
                procs.append({
                    "pid": int(parts[1]),
                    "name": parts[2],
                    "usedMemoryMb": safe_float(parts[3])
                })
        return procs
    except Exception:
        return []

output = {
    "timestamp": int(time.time()),
    "cpu": get_cpu(),
    "memory": get_mem(),
    "gpus": get_gpus(),
    "processes": get_compute_processes()
}
print(json.dumps(output))
`;

const PYTHON_B64 = Buffer.from(PYTHON_PROBE_SCRIPT).toString("base64");

/**
 * Shell fallback script for environments without Python3
 */
const SHELL_FALLBACK_SCRIPT = [
  "TOTAL_KB=$(grep -m1 MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')",
  "AVAIL_KB=$(grep -m1 -E 'MemAvailable|MemFree' /proc/meminfo 2>/dev/null | awk '{print $2}')",
  '[ -z "$TOTAL_KB" ] && TOTAL_KB=1',
  '[ -z "$AVAIL_KB" ] && AVAIL_KB=0',
  "TOTAL_MB=$((TOTAL_KB / 1024))",
  "AVAIL_MB=$((AVAIL_KB / 1024))",
  "USED_MB=$((TOTAL_MB - AVAIL_MB))",
  "MEM_PCT=$(( (USED_MB * 100) / (TOTAL_MB > 0 ? TOTAL_MB : 1) ))",
  "CORES=$(nproc 2>/dev/null || echo 1)",
  "CPU_PCT=$(top -bn1 2>/dev/null | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}')",
  '[ -z "$CPU_PCT" ] && CPU_PCT=0',
  'echo "{\\"timestamp\\":$(date +%s),\\"cpu\\":{\\"percent\\":${CPU_PCT:-0},\\"cores\\":${CORES:-1}},\\"memory\\":{\\"totalMb\\":${TOTAL_MB:-0},\\"usedMb\\":${USED_MB:-0},\\"availMb\\":${AVAIL_MB:-0},\\"percent\\":${MEM_PCT:-0}},\\"gpus\\":[],\\"processes\\":[]}"',
].join("; ");

/**
 * Generate composite command that tries python3 first, then shell fallback
 */
export function getProbeCommand(): string {
  return `if command -v python3 >/dev/null 2>&1; then python3 -c "import base64; exec(base64.b64decode('${PYTHON_B64}').decode('utf-8'))"; else ${SHELL_FALLBACK_SCRIPT.trim()}; fi`;
}

/**
 * Parse output from probe command
 */
export function parseProbeOutput(raw: string): HardwareMetrics | null {
  try {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // Find first '{' and last '}' in case MOTD or ssh banners precede the JSON
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return null;
    }

    const jsonStr = trimmed.slice(firstBrace, lastBrace + 1);
    const parsed = JSON.parse(jsonStr) as HardwareMetrics;

    // Validate minimum required fields
    if (
      typeof parsed.timestamp === "number" &&
      parsed.cpu &&
      typeof parsed.cpu.percent === "number" &&
      parsed.memory &&
      typeof parsed.memory.totalMb === "number"
    ) {
      if (!Array.isArray(parsed.gpus)) parsed.gpus = [];
      if (!Array.isArray(parsed.processes)) parsed.processes = [];
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
