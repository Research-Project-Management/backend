#!/usr/bin/env node
import { execSync } from 'child_process';
import os from 'os';

const ports = [3000, 2915];

function cleanPorts() {
  const isWin = os.platform() === 'win32';
  for (const port of ports) {
    try {
      if (isWin) {
        execSync(
          `powershell -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
          { stdio: 'ignore' }
        );
      } else {
        execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
      }
    } catch (_) {}
  }
  console.log(`[Clean Ports] Ports ${ports.join(', ')} checked and freed.`);
}

cleanPorts();
