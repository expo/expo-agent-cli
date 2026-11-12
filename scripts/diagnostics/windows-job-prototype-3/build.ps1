$ErrorActionPreference = 'Stop'
$probe = $PSScriptRoot
$results = Join-Path $probe 'results'
New-Item -ItemType Directory -Force -Path $results | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or !$installation) { throw 'MSVC x64 installation not found' }
$vcvars = Join-Path $installation 'VC\Auxiliary\Build\vcvars64.bat'
$build = Join-Path $probe 'compile.cmd'
@"
@echo off
call "$vcvars"
if errorlevel 1 exit /b %errorlevel%
cl.exe /nologo /W4 /EHsc /std:c++17 /O2 /MT /DUNICODE /D_UNICODE /Fe:"$probe\job-helper.exe" /Fo:"$probe\job-helper.obj" "$probe\job-helper.cpp" /link /INCREMENTAL:NO
exit /b %errorlevel%
"@ | Set-Content -Encoding Ascii $build
& $env:ComSpec /d /c $build 2>&1 | Tee-Object -FilePath (Join-Path $results 'build.log')
if ($LASTEXITCODE -ne 0) { throw "Native compile failed with $LASTEXITCODE" }
Get-ComputerInfo -Property WindowsProductName, WindowsVersion, OsName, OsVersion, OsBuildNumber, OsArchitecture | ConvertTo-Json | Set-Content (Join-Path $results 'windows.json')
Get-FileHash -Algorithm SHA256 (Join-Path $probe 'job-helper.exe') | Format-List | Out-File (Join-Path $results 'helper-sha256.txt')
Get-ChildItem $probe -File | Where-Object Extension -In '.cpp', '.h', '.mjs', '.ps1', '.yml', '.md' | Get-FileHash -Algorithm SHA256 | ConvertTo-Json | Set-Content (Join-Path $results 'source-hashes.json')
