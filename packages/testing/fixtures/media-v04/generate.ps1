param([string]$OutputDirectory = $PSScriptRoot)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw 'ffmpeg is required' }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

function New-Sample([string]$Name, [string[]]$Arguments) {
  $destination = Join-Path $OutputDirectory $Name
  if (Test-Path -LiteralPath $destination) {
    Write-Output "skip existing: $Name"
    return
  }
  & ffmpeg -nostdin -hide_banner -loglevel error -n @Arguments $destination
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed: $Name" }
  Write-Output "generated: $Name"
}

New-Sample 'clip-a-24000-1001.mp4' @(
  '-f','lavfi','-i','testsrc2=size=320x180:rate=24000/1001:duration=4',
  '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4',
  '-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','ultrafast','-crf','34',
  '-pix_fmt','yuv420p','-threads','1','-c:a','aac','-b:a','48k','-ar','48000','-ac','1',
  '-shortest','-movflags','+faststart','-map_metadata','-1'
)
New-Sample 'clip-b-30000-1001.mp4' @(
  '-f','lavfi','-i','smptebars=size=320x180:rate=30000/1001:duration=4',
  '-map','0:v:0','-c:v','libx264','-preset','ultrafast','-crf','34',
  '-pix_fmt','yuv420p','-threads','1','-an','-movflags','+faststart','-map_metadata','-1'
)
New-Sample 'clip-c-60000-1001.mp4' @(
  '-f','lavfi','-i','testsrc=size=320x180:rate=60000/1001:duration=4',
  '-map','0:v:0','-c:v','libx264','-preset','ultrafast','-crf','34',
  '-pix_fmt','yuv420p','-threads','1','-an','-movflags','+faststart','-map_metadata','-1'
)
New-Sample 'clip-d-synthetic-vfr.mp4' @(
  '-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=4',
  '-vf','setpts=(N+floor(N/5))/(30*TB)','-fps_mode','vfr',
  '-c:v','libx264','-preset','ultrafast','-crf','34','-pix_fmt','yuv420p',
  '-threads','1','-an','-movflags','+faststart','-map_metadata','-1'
)
New-Sample 'independent-48k-stereo.wav' @(
  '-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=4',
  '-f','lavfi','-i','sine=frequency=1320:sample_rate=48000:duration=4',
  '-filter_complex','[0:a][1:a]amerge=inputs=2[a]','-map','[a]',
  '-c:a','pcm_s16le','-ar','48000','-ac','2','-map_metadata','-1'
)
