; Commit87 NSIS customisation.
; Adds an optional "add Commit87 to PATH" entry and documents the git requirement.

!macro customInstall
  DetailPrint "Commit87 requires Git for Windows (https://git-scm.com/download/win)."
!macroend

!macro customUnInstall
  DetailPrint "Commit87 removed. Repositories and configuration are left in %APPDATA%\Commit87."
!macroend