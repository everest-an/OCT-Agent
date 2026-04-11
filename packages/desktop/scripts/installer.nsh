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
!macroend
