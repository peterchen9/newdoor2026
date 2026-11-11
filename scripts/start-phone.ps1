param([string]$LanIP)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath '.env')) { throw 'Create .env from .env.example and configure tokens first.' }
if (-not $LanIP) {
    $candidates = @(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | ForEach-Object { $_.IPv4Address.IPAddress } | Where-Object { $_ -and $_ -notlike '169.254.*' })
    if ($candidates.Count -ne 1) { throw 'Specify the computer LAN IPv4 address: ./scripts/start-phone.ps1 -LanIP 192.168.1.10' }
    $LanIP = $candidates[0]
}
$parsedIP = $null
if (-not [Net.IPAddress]::TryParse($LanIP, [ref]$parsedIP) -or $parsedIP.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Use an IPv4 address.' }
$bytes = $parsedIP.GetAddressBytes()
if (-not ($bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or ($bytes[0] -eq 192 -and $bytes[1] -eq 168))) { throw 'Use a private LAN IP address.' }
if ($LanIP -notin @(Get-NetIPAddress -AddressFamily IPv4 | Select-Object -ExpandProperty IPAddress)) { throw 'The IP must belong to this computer.' }
"LAN_IP=$LanIP" | Set-Content -LiteralPath '.env.phone' -Encoding utf8
$composeArgs = @('compose', '--env-file', '.env', '--env-file', '.env.phone', '-f', 'compose.yaml', '-f', 'compose.phone.yaml')
& docker @composeArgs up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Docker startup failed.' }
New-Item -ItemType Directory -Path 'phone-setup' -Force | Out-Null
$proxyID = & docker @composeArgs ps -q https
if ($LASTEXITCODE -ne 0 -or -not $proxyID) { throw 'HTTPS container was not found.' }
$copied = $false
for ($attempt = 0; $attempt -lt 15; $attempt++) {
    & docker cp "${proxyID}:/data/caddy/pki/authorities/local/root.crt" './phone-setup/newdoor-root.crt' 2>$null
    if ($LASTEXITCODE -eq 0) { $copied = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $copied) { throw 'Could not export CA certificate; inspect HTTPS container logs.' }
$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $PWD 'phone-setup/newdoor-root.crt'))
$fingerprint = $certificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256)
@("Phone: https://${LanIP}:3443/door", 'Computer: http://localhost:3900/host', "CA SHA256: $fingerprint", 'Read docs/phone-setup.md to install and trust the CA on your phone.') | Set-Content -LiteralPath 'phone-setup/connection.txt' -Encoding utf8
Get-Content -LiteralPath 'phone-setup/connection.txt'
Write-Host 'No certificate trust store or Windows firewall settings were changed.'
