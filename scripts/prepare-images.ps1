<#
Prepare images for cert: resizes raster images to small(75), large(220), xlarge(512) PNGs with white background
and copies an SVG icon if present.
Usage: .\scripts\prepare-images.ps1 -SourceDir 'C:\path\to\downloaded\images'
Run from repository (script determines repo root).
#>
param(
  [Parameter(Mandatory=$true)]
  [string]$SourceDir,
  [string]$TargetImagesDir = "drivers\\bed-side\\assets\\images",
  [string]$TargetIconPath = "drivers\\bed-side\\assets\\icon.svg"
)

if (-not (Test-Path $SourceDir)) { Write-Error "SourceDir '$SourceDir' does not exist."; exit 1 }

$scriptRoot = $PSScriptRoot
$repoRoot = Resolve-Path (Join-Path $scriptRoot '..')
$repoRoot = $repoRoot.Path
$targetImagesFull = Join-Path $repoRoot $TargetImagesDir
if (-not (Test-Path $targetImagesFull)) { New-Item -ItemType Directory -Path $targetImagesFull -Force | Out-Null }

$sizes = @{ small = 75; large = 500; xlarge = 1024 }

Add-Type -AssemblyName System.Drawing

function FindFirstRaster([string]$dir){
  return Get-ChildItem -Path $dir -Include *.png,*.jpg,*.jpeg,*.bmp -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
}

foreach ($name in $sizes.Keys){
  $dim = $sizes[$name]
  $file = Get-ChildItem -Path $SourceDir -Filter "*$name*.*" -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Extension -notmatch 'svg' } | Select-Object -First 1
  if (-not $file) { $file = FindFirstRaster $SourceDir }
  if (-not $file) { Write-Warning "No source raster image found for size '$name'. Skipping."; continue }

  try{
    # Load image into memory stream to avoid file lock on overwrite
    $fs = [System.IO.File]::Open($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $img = [System.Drawing.Image]::FromStream($fs)
  } catch {
    Write-Warning "Failed to load $($file.FullName): $($_.Exception.Message)"; if ($fs) { $fs.Dispose() } ; continue
  }

  $newBmp = New-Object System.Drawing.Bitmap $dim, $dim
  $g = [System.Drawing.Graphics]::FromImage($newBmp)
  $g.Clear([System.Drawing.Color]::White)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  $scale = [math]::Min($dim / $img.Width, $dim / $img.Height)
  $w = [int]([math]::Round($img.Width * $scale))
  $h = [int]([math]::Round($img.Height * $scale))
  $x = [int]([math]::Round(($dim - $w)/2))
  $y = [int]([math]::Round(($dim - $h)/2))
  $g.DrawImage($img, $x, $y, $w, $h)

  $outPath = Join-Path $targetImagesFull ("$name.png")
  $tmp = [System.IO.Path]::GetTempFileName()
  $newBmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $img.Dispose(); $newBmp.Dispose(); $fs.Dispose()
  Move-Item -Force $tmp $outPath
  Write-Output "Wrote $outPath"
}

# Copy SVG icon if available
$svg = Get-ChildItem -Path $SourceDir -Include *.svg -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($svg){
  $targetIconFull = Join-Path $repoRoot $TargetIconPath
  Copy-Item -Path $svg.FullName -Destination $targetIconFull -Force
  Write-Output "Copied SVG icon to $targetIconFull"
} else {
  Write-Warning "No SVG icon found in source dir. If you have driver/icon.svg as SVG, place it under SourceDir and re-run."
}

Write-Output "Done. To commit: git add $TargetImagesDir $TargetIconPath; git commit -m 'chore(images): add device images' && git push origin master"
