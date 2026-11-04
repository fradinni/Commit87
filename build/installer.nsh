; GitGrove NSIS customisation.
; Adds an optional "add GitGrove to PATH" entry and documents the git requirement.

!macro customInstall
  DetailPrint "GitGrove requires Git for Windows (https://git-scm.com/download/win)."
!macroend

!macro customUnInstall
  DetailPrint "GitGrove removed. Repositories and configuration are left in %APPDATA%\GitGrove."
!macroend