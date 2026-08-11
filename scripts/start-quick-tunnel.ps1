param(
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflared) {
  throw "cloudflared was not found in PATH. Install Cloudflare Tunnel first."
}

$targetUrl = "http://localhost:$Port"

Write-Host "Starting Quick Tunnel for $targetUrl"
Write-Host "Share the https://...trycloudflare.com URL shown below."
Write-Host ""

& cloudflared tunnel --url $targetUrl
