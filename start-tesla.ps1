# ==============================================================
#  Tesla MCP + Siri Server - Single launcher
#
#  1. Starts the Siri/MCP server (port 3000)
#  2. Starts ngrok tunnel
#  3. Auto-registers with Tesla EU Fleet API
#  4. Prints Siri Shortcut URL + copies to clipboard
#
#  Usage:  .\start-tesla.ps1
# ==============================================================

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot

function Info ($m) { Write-Host "  $m" -ForegroundColor Cyan }
function OK   ($m) { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Fail ($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Step ($m) { Write-Host "" ; Write-Host $m -ForegroundColor Magenta }

function Read-EnvValue {
    param([string]$Key, [string]$Default = "")
    $f = "$ProjectDir\.env"
    if (-not (Test-Path $f)) { return $Default }
    $escaped = [regex]::Escape($Key)
    $line = Select-String -Path $f -Pattern "^\s*${escaped}\s*=" | Select-Object -First 1
    if (-not $line) { return $Default }
    $v = ($line.Line -replace "^\s*${escaped}\s*=", "").Split("#")[0].Trim().Trim('"').Trim("'")
    if ([string]::IsNullOrWhiteSpace($v)) { return $Default }
    return $v
}

function Get-NgrokUrl {
    $url = $null
    for ($i = 0; $i -lt 8; $i++) {
        Start-Sleep -Seconds 2
        try {
            $resp = Invoke-RestMethod -Uri "http://localhost:4040/api/tunnels" -ErrorAction Stop
            $https = $resp.tunnels | Where-Object { $_.proto -eq "https" } | Select-Object -First 1
            if ($https) {
                $url = $https.public_url
                break
            }
        } catch {
            # not ready yet
        }
    }
    return $url
}

function Run-Registration {
    param([string]$Domain)
    Push-Location $ProjectDir
    $out = node get-tesla-token.mjs $Domain 2>&1 | Out-String
    Pop-Location
    return $out
}

# ---------------------------------------------------------------
Clear-Host
Write-Host "======================================================" -ForegroundColor DarkCyan
Write-Host "   Tesla MCP + Siri Server" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor DarkCyan

# -- 1. Project check
Step "[ 1/6 ] Checking project..."
if (-not (Test-Path "$ProjectDir\package.json")) {
    Fail "package.json not found in $ProjectDir"
    exit 1
}
OK "Project: $ProjectDir"

# -- 2. .env check
Step "[ 2/6 ] Checking .env..."
$EnvFile = "$ProjectDir\.env"
if (-not (Test-Path $EnvFile)) {
    Fail ".env not found. Create one with TESLA_CLIENT_ID, TESLA_CLIENT_SECRET, TESLA_VIN"
    exit 1
}
OK ".env found"

$Port = 3000
$portStr = Read-EnvValue -Key "PORT" -Default "3000"
$parsed = 0
if ([int]::TryParse($portStr, [ref]$parsed)) { $Port = $parsed }

$GeminiKey = Read-EnvValue -Key "GEMINI_API_KEY"
if ($GeminiKey) {
    OK "Gemini AI key found - natural language mode enabled"
} else {
    Warn "GEMINI_API_KEY not set - keyword-only mode (set it for AI)"
}

# -- 3. Dependencies
Step "[ 3/6 ] Checking dependencies..."
if (-not (Test-Path "$ProjectDir\node_modules")) {
    Info "Running npm install..."
    Push-Location $ProjectDir
    npm install
    Pop-Location
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed"; exit 1 }
}
OK "Dependencies ready"

# -- 4. Check ngrok
Step "[ 4/6 ] Checking ngrok..."
if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
    Fail "ngrok not found. Install: winget install ngrok"
    exit 1
}
OK "ngrok found"

# -- 5. Free the port
Step "[ 5/6 ] Freeing port $Port..."
$occ = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($occ) {
    Stop-Process -Id $occ.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    OK "Port $Port freed"
} else {
    OK "Port $Port is free"
}

# -- 6. Launch servers
Step "[ 6/6 ] Starting servers..."

$siriArgs = "/k cd /d `"$ProjectDir`" && npm run dev:siri"
$siriProc = Start-Process cmd -ArgumentList $siriArgs -PassThru
Info "Siri server starting (PID $($siriProc.Id))..."
Start-Sleep -Seconds 4

$staticDomain = Read-EnvValue -Key "TESLA_NGROK_DOMAIN"
if ($staticDomain) {
    $ngrokArgs = "http --domain=$staticDomain --host-header=rewrite http://localhost:$Port"
    $ngrokProc = Start-Process ngrok -ArgumentList $ngrokArgs -PassThru
    Info "ngrok starting with static domain: $staticDomain (PID $($ngrokProc.Id))..."
} else {
    $ngrokArgs = "http --host-header=rewrite http://localhost:$Port"
    $ngrokProc = Start-Process ngrok -ArgumentList $ngrokArgs -PassThru
    Info "ngrok starting with random URL (PID $($ngrokProc.Id))..."
}

# -- Get ngrok URL
Write-Host ""
Info "Waiting for ngrok tunnel..."
$PublicUrl = Get-NgrokUrl
$Domain = $null

if (-not $PublicUrl) {
    Warn "Could not get ngrok URL. Check the ngrok window."
    Write-Host ""
    Write-Host "Press any key to stop servers..." -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    Stop-Process -Id $siriProc.Id -ErrorAction SilentlyContinue
    Stop-Process -Id $ngrokProc.Id -ErrorAction SilentlyContinue
    exit 1
}

$Domain = $PublicUrl -replace "https://", ""
Write-Host ""
Write-Host "======================================================" -ForegroundColor Green
Write-Host "   Servers running!" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Green
Write-Host ""
Write-Host "   Public URL : $PublicUrl" -ForegroundColor Yellow
Write-Host "   Domain     : $Domain" -ForegroundColor Cyan

# -- Auto-register with Tesla EU Fleet API
Write-Host ""
Write-Host "   Registering with Tesla EU Fleet API..." -ForegroundColor Cyan

$registeredDomain = Read-EnvValue -Key "TESLA_NGROK_DOMAIN"
if ($registeredDomain -eq $Domain) {
    OK "Domain already registered - skipping."
} else {
    $regOut = Run-Registration -Domain $Domain

    if ($regOut -match "registered successfully" -or $regOut -match "Already registered") {
        OK "Tesla partner registration complete!"
    } elseif ($regOut -match "has already been taken") {
        Warn "Domain taken by a previous Tesla app. Switching to random URL..."

        # Kill current ngrok and restart without static domain
        Stop-Process -Id $ngrokProc.Id -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        $ngrokProc = Start-Process ngrok -ArgumentList "http --host-header=rewrite http://localhost:$Port" -PassThru
        Info "ngrok restarted (PID $($ngrokProc.Id)), waiting for new URL..."

        $PublicUrl2 = Get-NgrokUrl
        if ($PublicUrl2) {
            $Domain = $PublicUrl2 -replace "https://", ""
            $PublicUrl = $PublicUrl2
            Write-Host "   New URL: $PublicUrl" -ForegroundColor Yellow

            $regOut2 = Run-Registration -Domain $Domain
            if ($regOut2 -match "registered successfully" -or $regOut2 -match "Already registered") {
                OK "Registration complete!"
            } else {
                Warn "Registration output:"
                Write-Host $regOut2 -ForegroundColor DarkGray
            }

            Write-Host ""
            Warn "ACTION REQUIRED - Add to Tesla portal Allowed Origins:"
            Write-Host "   $PublicUrl" -ForegroundColor Yellow
            Write-Host "   Portal: https://developer.tesla.com/de_ch/dashboard/app-details/e043473e-a97b-4cdd-bdf3-3d9f898ae1a1/edit-client" -ForegroundColor White
        } else {
            Warn "Could not get new ngrok URL after restart."
        }
    } else {
        Warn "Registration output:"
        Write-Host $regOut -ForegroundColor DarkGray
    }
}

# -- Print Siri Shortcut URL
$ShortcutUrl = "$PublicUrl/siri?cmd="
Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "   SIRI SHORTCUT URL:" -ForegroundColor Cyan
Write-Host "   $ShortcutUrl" -ForegroundColor White
Write-Host ""
Write-Host "   Add request header:  ngrok-skip-browser-warning: true" -ForegroundColor White
Write-Host ""
Write-Host "   Examples:" -ForegroundColor DarkGray
Write-Host "   $PublicUrl/siri?cmd=lock+my+car" -ForegroundColor DarkGray
Write-Host "   $PublicUrl/siri?cmd=what+is+my+battery+level" -ForegroundColor DarkGray
Write-Host "   $PublicUrl/siri?cmd=start+the+climate" -ForegroundColor DarkGray
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

try {
    $ShortcutUrl | Set-Clipboard
    OK "Shortcut URL copied to clipboard!"
} catch {
    Warn "Could not copy to clipboard"
}

Write-Host ""
Write-Host "Press any key to stop both servers..." -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

Info "Shutting down..."
Stop-Process -Id $siriProc.Id -ErrorAction SilentlyContinue
Stop-Process -Id $ngrokProc.Id -ErrorAction SilentlyContinue
OK "Done. Goodbye!"
Start-Sleep -Seconds 1
