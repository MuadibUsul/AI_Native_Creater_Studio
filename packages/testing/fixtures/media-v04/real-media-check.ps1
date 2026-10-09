param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-Fa-f]{64}$')][string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue) -or
    -not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  throw 'ffprobe and ffmpeg are required.'
}

try {
  $media = Get-Item -LiteralPath $InputPath -ErrorAction Stop
  if ($media.PSIsContainer) { throw 'directory' }
  $sha256 = (Get-FileHash -LiteralPath $media.FullName -Algorithm SHA256).Hash
} catch {
  throw 'Cannot read input media file.'
}
if ($sha256 -ine $ExpectedSha256) { throw 'SHA-256 mismatch.' }

$probeJson = & ffprobe -v error -show_entries 'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels' -of json $media.FullName 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Media probe failed.' }
try { $probe = $probeJson | ConvertFrom-Json -ErrorAction Stop }
catch { throw 'Media probe returned invalid JSON.' }
$video = @($probe.streams | Where-Object { $_.codec_type -eq 'video' })
$audio = @($probe.streams | Where-Object { $_.codec_type -eq 'audio' })
if ($video.Count -eq 0) { throw 'Input has no video stream.' }

& ffmpeg -nostdin -hide_banner -loglevel error -xerror -i $media.FullName -map '0:v' -map '0:a?' -f null - 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Full media decode failed.' }

[ordered]@{
  sha256 = $sha256.ToLowerInvariant()
  bytes = $media.Length
  durationSeconds = $probe.format.duration
  video = @($video | ForEach-Object { [ordered]@{ codec = $_.codec_name; width = $_.width; height = $_.height; averageFrameRate = $_.avg_frame_rate } })
  audio = @($audio | ForEach-Object { [ordered]@{ codec = $_.codec_name; sampleRate = $_.sample_rate; channels = $_.channels } })
  fullDecode = 'passed'
} | ConvertTo-Json -Compress -Depth 5
