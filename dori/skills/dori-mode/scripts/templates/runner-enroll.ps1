# Makes this Windows computer a Dori runner of the Toodo server it was downloaded from. The command Settings > Machines &
# accounts > Add a computer shows sets DORI_SERVER, DORI_LABEL, DORI_CODE (one-time, 10 minutes) and DORI_FINGERPRINT
# (the supervisor key) and pipes this script into Invoke-Expression (runner/paste-enroll.ts). It runs in a script block
# and returns instead of exiting, so the console it was pasted into stays open; the installer runs as a child process.
& {
  $ProgressPreference = 'SilentlyContinue'
  foreach ($V in 'DORI_SERVER', 'DORI_LABEL', 'DORI_CODE', 'DORI_FINGERPRINT') {
    if (-not [Environment]::GetEnvironmentVariable($V)) { Write-Host "Missing ${V}: copy the whole command from the Toodo web app again." -ForegroundColor Red; return }
  }
  $S = $env:DORI_SERVER.TrimEnd('/')
  $L = $env:DORI_LABEL
  $Fp = $env:DORI_FINGERPRINT
  $Sha = [Security.Cryptography.SHA256]::Create()
  $Token = -join ($Sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("@TOKEN_TAG@`n$L`n$($env:DORI_CODE)")) | ForEach-Object { $_.ToString('x2') })
  Remove-Item Env:DORI_CODE
  $Headers = @{ 'X-Dori-Enroll' = $Token }
  $Dir = Join-Path ([IO.Path]::GetTempPath()) ('dori-enroll-' + [Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($Dir)
  $File = Join-Path $Dir 'install.ps1'
  $Answer = { param($E) if ($E.ErrorDetails -and $E.ErrorDetails.Message) { $E.ErrorDetails.Message } else { $E.Exception.Message } }
  try {
    Write-Host "Installing the Dori runner $L from $S ..."
    $Code = $null
    foreach ($Pass in 1, 2) {
      try {
        $Script = (Invoke-WebRequest -UseBasicParsing -Headers $Headers -Uri "$S/runner-enroll/script?label=$L&shell=windows").Content
      } catch { Write-Host ('Could not download the runner: ' + (& $Answer $_)) -ForegroundColor Red; return }
      if (-not $Script.Contains("`$F = '$Fp'")) { Write-Host 'The downloaded installer does not pin the supervisor key from the command; stopping.' -ForegroundColor Red; return }
      [IO.File]::WriteAllText($File, $Script, [Text.Encoding]::ASCII)
      $Request = $null
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $File 2>&1 | ForEach-Object {
        $Line = "$_"
        if ($Line -like 'RUNNER_ENROLL_REQUEST *') { $Request = $Line.Substring('RUNNER_ENROLL_REQUEST '.Length) } else { Write-Host $Line }
      }
      $Code = $LASTEXITCODE
      if ($Code -ne 9 -or $Pass -eq 2) { break }
      try {
        [void](Invoke-WebRequest -UseBasicParsing -Method Post -Headers $Headers -ContentType 'text/plain' -Body $Request -Uri "$S/runner-enroll/exchange?label=$L")
      } catch { Write-Host ('The enrollment was refused: ' + (& $Answer $_)) -ForegroundColor Red; return }
      Write-Host 'The supervisor accepted this computer. Finishing the install ...'
    }
    switch ($Code) {
      0 { Write-Host "Done: $L is a Dori runner. It shows as connected in Settings > Machines & accounts once the server reaches it over the LAN or Tailscale." -ForegroundColor Green }
      3 { Write-Host 'No usable bun: the pinned Windows build could not be downloaded or run; see the lines above.' -ForegroundColor Red }
      4 { Write-Host 'This Windows cannot take a runner: it needs x64 Windows 10 1809 or later.' -ForegroundColor Red }
      5 { Write-Host 'The enrollment was refused: make a new command in the web app and run it within 10 minutes.' -ForegroundColor Red }
      6 { Write-Host 'The Task Scheduler refused the runner task; see the lines above.' -ForegroundColor Red }
      default { Write-Host "The install failed with exit code ${Code}; see the lines above." -ForegroundColor Red }
    }
  } finally {
    Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
