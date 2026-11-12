$ErrorActionPreference = 'Stop'
$probe = $PSScriptRoot
$toolchain = Join-Path $probe 'toolchain'
$results = Join-Path $probe 'results'
New-Item -ItemType Directory -Force -Path $results | Out-Null
$env:EXPO_TOKEN = ''
$env:EAS_ACCESS_TOKEN = ''
$env:EXPO_NO_TELEMETRY = '1'
$env:NO_UPDATE_NOTIFIER = '1'
& npm.cmd install --prefix $toolchain --ignore-scripts --legacy-peer-deps --no-audit --no-fund --package-lock=true 2>&1 | Tee-Object -FilePath (Join-Path $results 'toolchain-install.log')
if ($LASTEXITCODE -ne 0) { throw "Pinned audit tool installation failed with $LASTEXITCODE" }
Copy-Item (Join-Path $toolchain 'package.json') (Join-Path $results 'toolchain-package.json')
Copy-Item (Join-Path $toolchain 'package-lock.json') (Join-Path $results 'toolchain-package-lock.json')
& npm.cmd ls --prefix $toolchain --depth=0 --json 2>&1 | Out-File (Join-Path $results 'toolchain-versions.json')
if ($LASTEXITCODE -ne 0) { throw "Pinned audit tool inventory failed with $LASTEXITCODE" }
Get-FileHash -Algorithm SHA256 (Join-Path $toolchain 'package-lock.json') | Format-List | Out-File (Join-Path $results 'toolchain-lock-sha256.txt')
foreach ($package in @('expo', 'eas-cli')) {
  $manifest = Join-Path $toolchain "node_modules\$package\package.json"
  Copy-Item $manifest (Join-Path $results "$package-installed-package.json")
}
foreach ($shim in @('expo', 'eas')) {
  Copy-Item (Join-Path $toolchain "node_modules\.bin\$shim.cmd") (Join-Path $results "$shim-installed.cmd")
}
