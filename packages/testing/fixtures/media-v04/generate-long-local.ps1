[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'pexels-local-manifest.json') -Raw | ConvertFrom-Json
$asset = @($manifest.assets | Where-Object id -eq 'pexels-3148931-fractional-landscape')[0]
if (-not $asset) { throw 'Pexels rice source is missing from the local manifest' }
$source = Join-Path $root (Join-Path $manifest.cacheDirectory $asset.cacheFile)
if (-not (Test-Path -LiteralPath $source)) { throw "Download the licensed source first: $($asset.sourcePage)" }
if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $asset.sha256) { throw 'Pexels source SHA-256 mismatch' }

$directory = Join-Path $root '.artifacts/n00-04-long'
$output = Join-Path $directory 'pexels-rice-repeated-20m-320x180.mp4'
$expectedHash = '51848876321c37b7797007f3983c5e2850a6ce437982cb753e91d6ea85accf12'
if (Test-Path -LiteralPath $output) {
  if ((Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash -ne $expectedHash) { throw "Existing output differs from the verified fixture; will not overwrite: $output" }
  Write-Output "skip existing, SHA-256 verified: $output"
  return
}
if (-not $PSCmdlet.ShouldProcess($output, 'Generate a repeated 20-minute local stress sample')) { return }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw 'ffmpeg is required' }
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$ffmpegArgs = @(
  '-hide_banner','-nostdin','-nostats','-loglevel','error','-n','-stream_loop','14','-i',$source,
  '-map','0:v:0','-map','0:a:0','-vf','scale=320:180:flags=bicubic','-r','30000/1001','-fps_mode','cfr',
  '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-b:v','360k','-maxrate','400k','-bufsize','800k',
  '-c:a','aac','-b:a','64k','-ar','48000','-af','aresample=async=1:first_pts=0',
  '-t','1200','-movflags','+faststart'
)
& ffmpeg @ffmpegArgs $output
if ($LASTEXITCODE -ne 0) { throw 'ffmpeg failed; inspect the local partial output before retrying' }
if ((Get-Item -LiteralPath $output).Length -gt 100MB) { throw 'Generated sample exceeds 100 MiB' }
if ((Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Generated SHA-256 differs from the verified fixture; inspect the local output' }
Write-Output "generated and SHA-256 verified: $output"
