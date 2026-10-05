# 为 CanvasLoom 生成图标 + 桌面快捷方式
$ErrorActionPreference = 'Stop'
# 脚本自定位：放在仓库根即可用，不依赖固定的安装路径
$root = Split-Path -Parent $PSCommandPath

# ---- 1. 生成图标（蓝底圆角 + 白色三角，与应用 logo 一致）----
$icoPath = Join-Path $root 'canvasloom.ico'
try {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap 64, 64
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 14; $w = 64; $h = 64
  $path.AddArc(0, 0, 2*$r, 2*$r, 180, 90)
  $path.AddArc($w - 2*$r, 0, 2*$r, 2*$r, 270, 90)
  $path.AddArc($w - 2*$r, $h - 2*$r, 2*$r, 2*$r, 0, 90)
  $path.AddArc(0, $h - 2*$r, 2*$r, 2*$r, 90, 90)
  $path.CloseFigure()
  $blue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 37, 99, 235))
  $g.FillPath($blue, $path)
  $pts = @(
    (New-Object System.Drawing.PointF(19, 45)),
    (New-Object System.Drawing.PointF(32, 19)),
    (New-Object System.Drawing.PointF(45, 45))
  )
  $g.FillPolygon([System.Drawing.Brushes]::White, $pts)
  $g.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $fs = [System.IO.File]::Create($icoPath)
  $icon.Save($fs)
  $fs.Dispose()
  $icon.Dispose()
  $bmp.Dispose()
  Write-Output "icon: $icoPath"
} catch {
  Write-Output "icon-fallback: $($_.Exception.Message)"
  $icoPath = "$env:SystemRoot\System32\imageres.dll,109"
}

# ---- 2. 创建桌面快捷方式（指向 VBS 静默启动器，全程无黑窗口）----
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop '界面工坊 CanvasLoom.lnk'
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$lnk.Arguments = '"' + (Join-Path $root '启动编辑器.vbs') + '"'
$lnk.WorkingDirectory = $root
$lnk.IconLocation = "$icoPath,0"
$lnk.Description = 'CanvasLoom 界面工坊：本地可视化 UI 布局编辑器（127.0.0.1:8520）'
$lnk.WindowStyle = 7   # 最小化启动，不挡桌面
$lnk.Save()
Write-Output "lnk: $lnkPath"
