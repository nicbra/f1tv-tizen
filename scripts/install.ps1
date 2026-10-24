# Install or update F1 TV from Windows.
#
#   irm https://raw.githubusercontent.com/nicbra/f1tv-tizen/HEAD/scripts/install.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Tv 192.168.1.50] [-Force] [-Check] [-Wgt F1TV.wgt]
#
#   -Tv     skip the network search (TV: Settings > General > Network > Network Status)
#   -Force  reinstall even if the TV already has this version
#   -Check  only check the TV and download, don't install
#   -Wgt    install this package instead of the latest GitHub release
#
# Enable Developer Mode with this computer as Host PC IP (see README).
param(
  [string]$Tv = '',
  [switch]$Force,
  [switch]$Check,
  [string]$Wgt = ''
)

$Repo = if ($env:F1TV_REPO) { $env:F1TV_REPO } else { 'nicbra/f1tv-tizen' }
$AppId = 'F1TVtizen1.F1TV'
$SdbVersion = '4.2.36'
$SdbSha256 = '829c504db12ce3e9a598a457762a030d606836cec916c45438623618fc94333c'
$SdbUrl = "https://download.tizen.org/sdk/tizenstudio/official/binary/sdb_${SdbVersion}_windows-64.zip"
$Cache = Join-Path $env:LOCALAPPDATA 'f1tv-tizen'

$DevModeHelp = @"
On the TV: open Apps, press 1 2 3 4 5 on the remote (or the on-screen keypad), switch
Developer mode On, enter this computer's IP address as Host PC IP, then restart the TV
(hold the power button until it turns off and on again).
"@

# Errors end the script with a message but never close the window (it often runs via iex).
function Fail([string]$Message) { throw [System.Exception]::new($Message) }
function Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }

function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

function Get-Sdb {
  $dir = Join-Path $Cache "sdb-$SdbVersion"
  $exe = Join-Path $dir 'sdb.exe'
  if (Test-Path -LiteralPath $exe) { return $exe }
  Step "Downloading Samsung's sdb tool $SdbVersion"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $zip = Join-Path $dir 'sdb.zip'
  Invoke-WebRequest -UseBasicParsing -Uri $SdbUrl -OutFile $zip -TimeoutSec 600
  if ((Get-Sha256 $zip) -ne $SdbSha256) { Remove-Item -LiteralPath $zip; Fail "The sdb download doesn't match its checksum." }
  $tmp = Join-Path $dir 'unzip'
  Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
  Copy-Item -LiteralPath (Join-Path $tmp 'data\tools\sdb.exe') -Destination $exe
  Remove-Item -LiteralPath $tmp -Recurse -Force
  Remove-Item -LiteralPath $zip
  return $exe
}

# Samsung TVs describe themselves (name, model, developer mode) at http://<tv>:8001/api/v2/.
function Get-TvInfo([string]$Address) {
  try { return (Invoke-RestMethod -UseBasicParsing -Uri "http://${Address}:8001/api/v2/" -TimeoutSec 3).device } catch { return $null }
}

function Get-TvLabel([string]$Address) {
  $d = Get-TvInfo $Address
  if ($d) { return "$($d.name) ($($d.modelName)) at $Address" } else { return $Address }
}

# This computer's private IPv4 addresses, the one used for the internet first.
function Get-LocalAddresses {
  $main = @()
  try { $main = @(Find-NetRoute -RemoteIPAddress '1.1.1.1' -ErrorAction Stop | Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress }) } catch { }
  $all = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' } | ForEach-Object { $_.IPAddress })
  return @($main + $all | Where-Object { $_ -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' } | Select-Object -Unique)
}

# Scan local /24 networks; stop at the first one with a TV.
function Find-Tvs {
  Add-Type -AssemblyName System.Net.Http
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds(2)
  try {
    foreach ($ip in Get-LocalAddresses) {
      $net = $ip.Substring(0, $ip.LastIndexOf('.'))
      $tasks = @{}
      foreach ($i in 1..254) { $tasks["$net.$i"] = $client.GetStringAsync("http://${net}.${i}:8001/api/v2/") }
      try { [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($tasks.Values)) } catch { }
      $found = @($tasks.Keys | Where-Object { $tasks[$_].Status -eq 'RanToCompletion' -and $tasks[$_].Result -match 'SmartTV' } | Sort-Object)
      if ($found.Count) { return $found }
    }
  } finally { $client.Dispose() }
  return @()
}

function Select-Tv {
  if ($script:Tv) { return }
  Step 'Looking for Samsung TVs on your network'
  $found = @(Find-Tvs)
  if ($found.Count -eq 1) {
    $script:Tv = $found[0]
    Write-Host "Found $(Get-TvLabel $script:Tv)"
  } elseif ($found.Count -gt 1) {
    for ($i = 0; $i -lt $found.Count; $i++) { Write-Host "  $($i + 1)) $(Get-TvLabel $found[$i])" }
    $pick = Read-Host "Which TV? [1-$($found.Count)]"
    $n = 0
    if (-not [int]::TryParse($pick, [ref]$n) -or $n -lt 1 -or $n -gt $found.Count) { Fail 'No TV chosen.' }
    $script:Tv = $found[$n - 1]
  } else {
    Write-Host 'No TV answered. Make sure it is on and on the same network as this computer.'
    $script:Tv = (Read-Host "Type the TV's IP address (TV: Settings > General > Network > Network Status)").Trim()
  }
  if (-not $script:Tv) { Fail 'No TV address given.' }
}

# The address this computer uses to reach the TV (what Developer Mode must allow).
function Get-MyAddressFor([string]$Address) {
  try { return @(Find-NetRoute -RemoteIPAddress $Address -ErrorAction Stop | Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress })[0] } catch { return $null }
}

function Test-Tv {
  $me = Get-MyAddressFor $script:Tv
  $d = Get-TvInfo $script:Tv
  if (-not $d) { Write-Host "The TV at $($script:Tv) didn't describe itself; trying to connect anyway."; return }
  if ("$($d.developerMode)" -ne '1') {
    Fail "Developer Mode is off on the TV.`n$DevModeHelp`nThis computer's address is $me."
  }
  if ($me -and $d.developerIP -and $d.developerIP -ne $me) {
    Fail "The TV's Developer Mode allows $($d.developerIP), but this computer is $me.`n$DevModeHelp"
  }
}

function Get-WgtVersion([string]$Path) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Path).Path)
  try {
    $entry = $zip.GetEntry('config.xml')
    $reader = New-Object System.IO.StreamReader($entry.Open())
    try { $xml = [xml]$reader.ReadToEnd() } finally { $reader.Dispose() }
    return $xml.widget.version
  } finally { $zip.Dispose() }
}

function Get-Wgt {
  if ($script:Wgt) {
    if (-not (Test-Path -LiteralPath $script:Wgt)) { Fail "$($script:Wgt) doesn't exist." }
    $script:Version = Get-WgtVersion $script:Wgt
    return
  }
  Step "Looking up the latest release of $Repo"
  try {
    $release = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ Accept = 'application/vnd.github+json' } -TimeoutSec 60
  } catch { Fail "Couldn't get the latest release from GitHub ($Repo)." }
  $script:Version = "$($release.tag_name)" -replace '^v', ''
  $asset = @($release.assets | Where-Object { $_.name -eq 'F1TV.wgt' })[0]
  $sum = @($release.assets | Where-Object { $_.name -eq 'F1TV.wgt.sha256' })[0]
  if (-not $asset -or -not $sum) { Fail "The latest release ($($script:Version)) has no F1TV.wgt and F1TV.wgt.sha256." }
  New-Item -ItemType Directory -Force -Path $Cache | Out-Null
  $script:Wgt = Join-Path $Cache "F1TV-$($script:Version).wgt"
  if (Test-Path -LiteralPath $script:Wgt) { return }
  Write-Host "Downloading F1 TV $($script:Version)"
  $part = "$($script:Wgt).part"
  $sumFile = "$($script:Wgt).sha256"
  Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $part -TimeoutSec 600
  # Saved to a file: GitHub serves assets as binary, which Invoke-WebRequest would return as bytes.
  Invoke-WebRequest -UseBasicParsing -Uri $sum.browser_download_url -OutFile $sumFile -TimeoutSec 60
  $want = (Get-Content -LiteralPath $sumFile -Raw).Trim().Split(' ')[0].ToLowerInvariant()
  Remove-Item -LiteralPath $sumFile
  if ((Get-Sha256 $part) -ne $want) { Remove-Item -LiteralPath $part; Fail "The app download doesn't match its checksum." }
  Move-Item -LiteralPath $part -Destination $script:Wgt -Force
}

# Capture both streams: sdb also writes errors to stdout. Save its exit code in $script:SdbExit.
# PowerShell treats stderr as errors, so temporarily allow them.
function Invoke-Sdb {
  $ErrorActionPreference = 'Continue'
  $out = & $script:Sdb @args 2>&1 | ForEach-Object { "$_" } | Out-String
  $script:SdbExit = $LASTEXITCODE
  return $out -replace "`r", ''
}

function Connect-Tv {
  $script:Serial = "$($script:Tv):26101"
  Step 'Connecting to the TV'
  Invoke-Sdb start-server | Out-Null
  Invoke-Sdb connect $script:Serial | Out-Null
  $devices = Invoke-Sdb devices
  if ($devices -notmatch ("(?m)^" + [regex]::Escape($script:Serial) + "\s+device")) {
    Fail "The TV didn't accept the connection.`n$DevModeHelp"
  }
}

function Get-InstalledVersion {
  $mine = $false
  foreach ($line in (Invoke-Sdb -s $script:Serial shell 0 vd_applist) -split "`n") {
    if ($line -match 'app_id\s*=') { $mine = $line.Contains("=$AppId-") }
    elseif ($mine -and $line -match 'app_version\s*=([^-]*)') { return $Matches[1].Trim() }
  }
  return ''
}

function Install-App {
  $dir = ''
  foreach ($line in (Invoke-Sdb -s $script:Serial capability) -split "`n") {
    if ($line -match '^sdk_toolpath:(.+)$') { $dir = $Matches[1].Trim() }
  }
  if (-not $dir) { $dir = '/home/owner/share/tmp/sdk_tools' }
  $remote = "$dir/tmp/F1TV.wgt"
  Step "Installing F1 TV $($script:Version)"
  $push = Invoke-Sdb -s $script:Serial push $script:Wgt $remote
  if ($script:SdbExit -ne 0) { Fail "Copying the app to the TV failed:`n$push" }
  $out = Invoke-Sdb -s $script:Serial shell 0 vd_appinstall $AppId $remote
  if ($out -match 'install completed') { Write-Host 'Installed.'; return }
  if ($out -match '[Cc]ertificate.*chain|118, -12') {
    Fail "This TV only accepts apps signed with a Samsung certificate made for it (newer models do).`nBuild and sign the app yourself instead; see 'Building it yourself' in the README.`n`nThe TV said: $out"
  }
  if ($out -match '[Aa]uthor|[Ss]ignature|118, -11') {
    Write-Host 'The TV has a copy of the app that was signed by someone else (for example a build of your own).'
    $answer = Read-Host 'Remove it and install this version? You will need to sign in again. [y/N]'
    if ($answer -notmatch '^[yY]') { Fail 'Nothing changed.' }
    Invoke-Sdb -s $script:Serial shell 0 vd_appuninstall $AppId | Out-Null
    $out = Invoke-Sdb -s $script:Serial shell 0 vd_appinstall $AppId $remote
    if ($out -match 'install completed') { Write-Host 'Installed.'; return }
  }
  Fail "The TV refused the app:`n$out"
}

function Start-App {
  $out = Invoke-Sdb -s $script:Serial shell 0 execute $AppId
  if ($out -match 'fail|rror|not found') { $out = Invoke-Sdb -s $script:Serial shell 0 was_execute $AppId }
  if ($out -match 'fail|rror|not found') { Write-Host "Open F1 TV from the TV's Apps." } else { Write-Host 'F1 TV is starting on the TV.' }
}

function Install-F1Tv {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with its progress bar
  $ErrorActionPreference = 'Stop'
  $script:Sdb = $null
  $script:Serial = $null
  $script:Version = ''
  $failed = $false
  try {
    Select-Tv
    Test-Tv
    $script:Sdb = Get-Sdb
    Get-Wgt
    Connect-Tv
    $have = Get-InstalledVersion
    Write-Host ("On the TV: " + $(if ($have) { $have } else { 'not installed' }) + ". Available: $($script:Version).")
    if ($Check) { Write-Host 'Check only: nothing installed.'; return }
    if ($have -and $have -eq $script:Version -and -not $Force) {
      Write-Host 'Already up to date (use -Force to reinstall).'
    } else {
      Install-App
    }
    Start-App
  } catch {
    $failed = $true
    Write-Host ''
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
  } finally {
    if ($script:Sdb) {
      if ($script:Serial) { Invoke-Sdb disconnect $script:Serial | Out-Null }
      Invoke-Sdb kill-server | Out-Null
    }
  }
  # Run as a file: report failure in the exit code. Run through iex: never exit, it would close
  # the window.
  if ($failed -and $PSCommandPath) { exit 1 }
}

Install-F1Tv
