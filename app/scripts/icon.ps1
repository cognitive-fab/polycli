# Draws the polycli icon at each Windows icon size (shapes only, no fonts, so it looks
# the same on every machine) into resources/icon/polycli.ico, plus icon.png at 1024 px.
#   npm run icon
param([string]$Out = (Join-Path $PSScriptRoot '..\resources\icon'))
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $Out | Out-Null

function Rounded([System.Drawing.Drawing2D.GraphicsPath]$p, [float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
}
function Color([string]$hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }

# An icon bitmap entry: header, BGRA rows bottom-up, then an all-zero AND mask (the
# alpha channel does the masking).
function Dib([System.Drawing.Bitmap]$bmp) {
  $n = $bmp.Width
  $ms = New-Object IO.MemoryStream
  $w = New-Object IO.BinaryWriter $ms
  $mask = [Math]::Ceiling($n / 32) * 4 * $n
  $w.Write([UInt32]40); $w.Write([Int32]$n); $w.Write([Int32](2 * $n)); $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]0); $w.Write([UInt32]($n * $n * 4 + $mask)); $w.Write([Int32]0); $w.Write([Int32]0); $w.Write([UInt32]0); $w.Write([UInt32]0)
  for ($y = $n - 1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $n; $x++) { $c = $bmp.GetPixel($x, $y); $w.Write([byte]$c.B); $w.Write([byte]$c.G); $w.Write([byte]$c.R); $w.Write([byte]$c.A) }
  }
  $w.Write((New-Object byte[] $mask))
  $w.Flush()
  , $ms.ToArray()
}

$entries = @()
foreach ($size in 16, 20, 24, 32, 40, 48, 64, 128, 256, 1024) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $small = $size -le 32
  # Draw on a 1024 grid; small sizes use less margin and drop the workstream bars.
  $s = $size / 1024.0
  $g.ScaleTransform($s, $s)
  $inset = if ($small) { 16 } else { 64 }
  $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
  Rounded $bg $inset $inset (1024 - 2 * $inset) (1024 - 2 * $inset) ($(if ($small) { 180 } else { 200 }))
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.PointF]::new(0, 0)), ([System.Drawing.PointF]::new(0, 1024)), (Color '#232838'), (Color '#12141a')
  $g.FillPath($grad, $bg)
  if (-not $small) { $g.DrawPath((New-Object System.Drawing.Pen (Color '#343a4e'), 14), $bg) }

  if ($small) {
    $chev = @([System.Drawing.PointF]::new(250, 290), [System.Drawing.PointF]::new(480, 512), [System.Drawing.PointF]::new(250, 734))
    $pen = New-Object System.Drawing.Pen (Color '#eef0f6'), 130
    $bar = @(540, 650, 300, 110)
  } else {
    # Three workstreams, as in polycli's left rail.
    $cols = '#7c8cf8', '#5fd38d', '#f2b84b'
    for ($i = 0; $i -lt 3; $i++) {
      $p = New-Object System.Drawing.Drawing2D.GraphicsPath
      Rounded $p 200 (300 + $i * 160) 90 110 40
      $g.FillPath((New-Object System.Drawing.SolidBrush (Color $cols[$i])), $p)
    }
    $chev = @([System.Drawing.PointF]::new(400, 360), [System.Drawing.PointF]::new(560, 512), [System.Drawing.PointF]::new(400, 664))
    $pen = New-Object System.Drawing.Pen (Color '#eef0f6'), 84
    $bar = @(600, 610, 230, 74)
  }
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $g.DrawLines($pen, $chev)
  $u = New-Object System.Drawing.Drawing2D.GraphicsPath
  Rounded $u $bar[0] $bar[1] $bar[2] $bar[3] ($bar[3] / 2)
  $g.FillPath((New-Object System.Drawing.SolidBrush (Color '#7c8cf8')), $u)

  $g.Dispose()
  if ($size -eq 1024) { $bmp.Save((Join-Path $Out 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
  elseif ($size -eq 256) { $ms = New-Object IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $entries += , @($size, $ms.ToArray()) }
  else { $entries += , @($size, (Dib $bmp)) }
  $bmp.Dispose()
}

# polycli.ico: 32-bit bitmaps up to 128 px and a PNG at 256 px, the layout every Windows
# tool reads (some read a PNG only at 256 px).
$ico = New-Object IO.MemoryStream
$w = New-Object IO.BinaryWriter $ico
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
  $px = if ($e[0] -ge 256) { 0 } else { $e[0] }
  $w.Write([byte]$px); $w.Write([byte]$px); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$e[1].Length); $w.Write([UInt32]$offset)
  $offset += $e[1].Length
}
foreach ($e in $entries) { $w.Write([byte[]]$e[1]) }
$w.Flush()
[IO.File]::WriteAllBytes((Join-Path $Out 'polycli.ico'), $ico.ToArray())
"resources/icon/polycli.ico: $(($entries | ForEach-Object { $_[0] }) -join ', ') px, and icon.png (1024 px)"
