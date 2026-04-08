; AwarenessClaw NSIS custom hooks.
; Keep this file tracked so electron-builder can include it reliably.
; Desktop shortcut creation is configured via package.json.

!macro customInit
  ; Clean up empty residual install directory left by a previous uninstall.
  ; Without this, NSIS oneClick=false may stall on a hidden "directory exists"
  ; confirmation dialog — blocking both manual and /S silent installs.
  IfFileExists "$INSTDIR\*.*" 0 +3
    RMDir "$INSTDIR"
    ; RMDir only removes empty dirs; non-empty dirs are left intact (safe).
!macroend

!macro customInstall
!macroend

!macro customUnInstall
!macroend
