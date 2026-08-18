"""Probe the environment to understand OpenClaw relay and Chrome CDP setup."""
import subprocess
import socket
import json
import os
import glob

# 1. Find all Chrome processes with command lines
print("=== All Chrome processes (unique command lines) ===")
try:
    result = subprocess.run(
        ['powershell', '-Command', 
         "Get-CimInstance Win32_Process -Filter \"Name like '%chrome%'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Depth 2"],
        capture_output=True, text=True, timeout=15
    )
    data = json.loads(result.stdout)
    if isinstance(data, dict):
        data = [data]
    seen = set()
    for item in data:
        cmd = item.get('CommandLine', '')
        pid = item.get('ProcessId', '')
        if '--type=' not in cmd:  # Only main chrome processes
            print(f"PID {pid}: {cmd[:500]}")
            print('---')
except Exception as e:
    print(f"Error: {e}")

# 2. Find OpenClaw processes
print("\n=== OpenClaw processes ===")
try:
    result = subprocess.run(
        ['powershell', '-Command', 
         "Get-Process | Where-Object { $_.ProcessName -match 'openclaw|relay' } | Select-Object Id, ProcessName, Path | Format-List"],
        capture_output=True, text=True, timeout=10
    )
    print(result.stdout)
except Exception as e:
    print(f"Error: {e}")

# 3. Check OpenClaw log files
print("\n=== OpenClaw log files ===")
log_dirs = [
    os.path.expanduser('~/.openclaw/logs'),
    os.path.expanduser('~/.openclaw/state'),
    os.path.expanduser('~/.openclaw'),
]
for d in log_dirs:
    if os.path.exists(d):
        for f in os.listdir(d):
            full = os.path.join(d, f)
            print(f"  {full} ({os.path.getsize(full)} bytes)")

# 4. Check Chrome user data dir
print("\n=== Chrome user data dirs ===")
result = subprocess.run(
    ['powershell', '-Command',
     "Get-CimInstance Win32_Process -Filter \"Name like '%chrome%'\" | Where-Object { $_.CommandLine -match 'user-data-dir' } | Select-Object -First 3 CommandLine | Format-List"],
    capture_output=True, text=True, timeout=10
)
print(result.stdout[:2000])