# Register the Video Downloader companion as a native-messaging host on
# Windows (current user). Usage:
#   powershell -ExecutionPolicy Bypass -File companion\install.ps1 <extension-id>
#   powershell -ExecutionPolicy Bypass -File companion\install.ps1 -Uninstall
param(
  [Parameter(Position = 0)][string]$ExtensionId,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

$Name = 'com.inventingfire.videodownloader'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Keys = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Chromium\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
)

if ($Uninstall) {
  foreach ($k in $Keys) { Remove-Item -Path "$k\$Name" -ErrorAction SilentlyContinue }
  Remove-Item -Path (Join-Path $Dir "$Name.json") -ErrorAction SilentlyContinue
  Write-Output "Removed $Name."
  exit 0
}

if ($ExtensionId -notmatch '^[a-p]{32}$') {
  Write-Error 'Usage: install.ps1 <extension-id>  (32 letters a-p, from chrome://extensions)'
}

$Python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $Python) { $Python = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $Python) { Write-Error 'Python 3 is required' }
if (-not (Get-Command yt-dlp -ErrorAction SilentlyContinue)) {
  Write-Warning "yt-dlp not found - install it (e.g. 'winget install yt-dlp')"
}

$Wrapper = Join-Path $Dir 'run_host.bat'
Set-Content -Path $Wrapper -Encoding ASCII -Value "@echo off`r`n`"$Python`" -u `"$Dir\videodownloader_host.py`" %*"

$ManifestPath = Join-Path $Dir "$Name.json"
@{
  name = $Name
  description = 'Video Downloader companion (yt-dlp) for YouTube downloads'
  path = $Wrapper
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json | Set-Content -Path $ManifestPath -Encoding UTF8

foreach ($k in $Keys) {
  New-Item -Path "$k\$Name" -Force | Out-Null
  Set-ItemProperty -Path "$k\$Name" -Name '(default)' -Value $ManifestPath
}
Write-Output 'Done. In the extension''s Settings, enable the companion and click Test connection.'
