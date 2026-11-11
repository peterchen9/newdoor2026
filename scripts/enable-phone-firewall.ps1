param([Parameter(Mandatory)][string]$LanIP)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run in an Administrator PowerShell.' }
$address = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $LanIP -ErrorAction Stop
$profile = Get-NetConnectionProfile -InterfaceIndex $address.InterfaceIndex
if ($profile.NetworkCategory -ne 'Private') { throw 'This helper only supports an already trusted Private network. No network category was changed.' }
$ruleName = 'NewDoor2026-Phone-HTTPS'
if (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) { throw 'Rule already exists. Inspect it before making another change.' }
New-NetFirewallRule -Name $ruleName -DisplayName 'NewDoor2026 phone HTTPS (private LAN only)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3443 -LocalAddress $LanIP -RemoteAddress LocalSubnet -Profile Private | Out-Null
Write-Host "Allowed TCP 3443 on $LanIP from the private local subnet."
Write-Host "To remove: Remove-NetFirewallRule -Name '$ruleName'"
