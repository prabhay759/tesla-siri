# ==============================================================
#  Tesla Server — Windows Task Scheduler autostart installer
#
#  Run ONCE as Administrator:  .\install-autostart.ps1
#  To remove:                  .\install-autostart.ps1 -Remove
# ==============================================================

param([switch]$Remove)

$TaskName   = "TeslaSiriServer"
$ProjectDir = $PSScriptRoot
$ScriptPath = "$ProjectDir\start-tesla-silent.ps1"

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "[OK] Task '$TaskName' removed." -ForegroundColor Green
    exit 0
}

# ── Create a silent launcher (no console window) ─────────────
$silentScript = @"
Set-Location "$ProjectDir"
# Wait for network to be available
Start-Sleep -Seconds 15
# Start siri server in background (hidden window)
Start-Process -FilePath "cmd.exe" ``
    -ArgumentList "/c cd /d `"$ProjectDir`" && npm run dev:siri >> `"$ProjectDir\server.log`" 2>&1" ``
    -WindowStyle Hidden
"@

Set-Content -Path $ScriptPath -Value $silentScript -Encoding UTF8
Write-Host "  Created: $ScriptPath" -ForegroundColor Cyan

# ── Register scheduled task ───────────────────────────────────
$action  = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File `"$ScriptPath`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName  $TaskName `
    -Action    $action `
    -Trigger   $trigger `
    -Settings  $settings `
    -Principal $principal `
    -Force | Out-Null

Write-Host ""
Write-Host "======================================================" -ForegroundColor Green
Write-Host "  Tesla server will now auto-start at every login."    -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Task name : $TaskName"         -ForegroundColor Cyan
Write-Host "  Log file  : $ProjectDir\server.log" -ForegroundColor Cyan
Write-Host ""
Write-Host "  To remove : .\install-autostart.ps1 -Remove"        -ForegroundColor DarkGray
Write-Host "  To test   : Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor DarkGray
