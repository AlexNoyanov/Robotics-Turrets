# Point the Quest Browser at this PC without a store install.
# Developer mode has to be on, and the headset has to allow USB debugging.
$adb = Join-Path $env:LOCALAPPDATA "turret-tools\platform-tools\adb.exe"
if (-not (Test-Path $adb)) {
    Write-Error "adb is not in $adb yet. Ask to install platform-tools, then run this again."
    exit 1
}
& $adb start-server
& $adb devices -l
$listed = & $adb devices | Select-String "device$"
if (-not $listed) {
    Write-Error "No Quest is authorized. Plug it in and accept the USB debugging prompt in the headset."
    exit 1
}
& $adb reverse tcp:8092 tcp:8092
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "In the Quest Browser, open http://127.0.0.1:8092/vr"
