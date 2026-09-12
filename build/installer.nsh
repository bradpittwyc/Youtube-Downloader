; electron-builder 的自定义 NSIS 钩子。
; 这个文件会被自动包含（默认路径就是 build/installer.nsh）。

; electron-builder 写入卸载注册表项时【没有写 InstallLocation】，
; 导致「控制面板 → 程序和功能」里那一列是空的，看着不像正经软件。
; customInstall 正好在 registryAddInstallInfo 之后执行，这里补上。
!macro customInstall
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
!macroend
