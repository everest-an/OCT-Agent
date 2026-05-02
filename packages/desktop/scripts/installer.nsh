; AwarenessClaw NSIS custom hooks.
; Keep this file tracked so electron-builder can include it reliably.
; Desktop shortcut creation is configured via package.json.

!macro customInit
  ; Keep init as a no-op.
  ; Accessing $INSTDIR too early in init can terminate the installer on some hosts.
!macroend

!macro customInstall
!macroend

!macro customUnInstall
  ; Data-retention hard rule:
  ; - Never delete user profile data during uninstall.
  ; - Keep chat/memory/model config/API keys/skills in home dirs such as:
  ;   ~/.openclaw, ~/.awareness, ~/.awarenessclaw, ~/.awareness-claw and legacy Lobster data.
  ; NSIS default behavior only removes app install files under $INSTDIR.

  ; Stop the desktop app first so tray-hidden instances do not keep gateway/daemon alive.
  ; Try both process names: new brand (OCT.exe) and legacy brand (AwarenessClaw.exe).
  ExecWait `"$SYSDIR\taskkill.exe" /F /T /IM OCT.exe`
  ExecWait `"$SYSDIR\taskkill.exe" /F /T /IM AwarenessClaw.exe`

  ; Ask OpenClaw and the local daemon to stop gracefully before file removal.
  ExecWait `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = 'SilentlyContinue'; if (Get-Command openclaw -ErrorAction SilentlyContinue) { & openclaw gateway stop 2>$$null | Out-Null }; try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:37800/shutdown' -Method POST -TimeoutSec 3 | Out-Null } catch {}"`

  ; Final sweep for leftover runtime processes that can keep .openclaw locked.
  ExecWait `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { ($$_.Name -eq 'node.exe' -or $$_.Name -eq 'npx.exe') -and ($$_.CommandLine -match '@awareness-sdk/local' -or $$_.CommandLine -match 'openclaw\\.mjs') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
!macroend
