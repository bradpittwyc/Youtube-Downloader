# Capture a single window by title, independent of z-order (ASCII-only).
# Uses PrintWindow(PW_RENDERFULLCONTENT) which works for Chromium/Electron windows,
# falling back to a screen-region copy if PrintWindow returns a blank bitmap.
param(
  [string]$TitleMatch = "YouTube",
  [string]$ProcessName = "",
  [string]$Out = "E:\Deepseek Harness\youtubedownloader\.poc\window.png"
)

Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static void UnlockForeground() {
    keybd_event(0x12, 0, 0, UIntPtr.Zero);          // ALT down
    keybd_event(0x12, 0, 2, UIntPtr.Zero);          // ALT up
  }
}
'@
if (-not ("WinCap" -as [type])) { Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue }

$procs = Get-Process | Where-Object { $_.MainWindowTitle -like "*$TitleMatch*" }
if ($ProcessName) { $procs = $procs | Where-Object { $_.ProcessName -eq $ProcessName } }
$proc = $procs | Select-Object -First 1
if (-not $proc) { Write-Output "No window matching '$TitleMatch' (process='$ProcessName')"; exit 1 }

$h = $proc.MainWindowHandle
Write-Output ("window: {0}  handle={1}" -f $proc.MainWindowTitle, $h)

if ([WinCap]::IsIconic($h)) { [void][WinCap]::ShowWindow($h, 9) }
[void][WinCap]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0001 -bor 0x0040)
[WinCap]::UnlockForeground()
[void][WinCap]::BringWindowToTop($h)
[void][WinCap]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 800

$r = New-Object WinCap+RECT
[void][WinCap]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$hh = $r.Bottom - $r.Top
Write-Output ("rect: ({0},{1}) size: {2}x{3}" -f $r.Left, $r.Top, $w, $hh)

function Get-DistinctSample([System.Drawing.Bitmap]$bmp) {
  $set = @{}
  for ($x = 4; $x -lt $bmp.Width; $x += 23) {
    for ($y = 4; $y -lt $bmp.Height; $y += 23) {
      $set[$bmp.GetPixel($x, $y).ToArgb()] = 1
    }
  }
  return $set.Count
}

# --- attempt 1: PrintWindow ---
$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [WinCap]::PrintWindow($h, $hdc, 2)   # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
$g.Dispose()
$distinct = Get-DistinctSample $bmp
$usable = $ok -and ($distinct -gt 12)
Write-Output ("PrintWindow ok={0} distinctColors={1} usable={2}" -f $ok, $distinct, $usable)

if (-not $usable) {
  Write-Output "PrintWindow blank -> falling back to screen copy"
  $bmp.Dispose()
  $bmp = New-Object System.Drawing.Bitmap($w, $hh)
  $g2 = [System.Drawing.Graphics]::FromImage($bmp)
  $g2.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $g2.Dispose()
}

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved: $Out"
