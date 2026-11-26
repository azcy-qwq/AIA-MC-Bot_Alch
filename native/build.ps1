$ErrorActionPreference = "Stop"
$compiler = (Get-Command g++ -ErrorAction SilentlyContinue).Source
if (-not $compiler) { $compiler = "C:\Users\20416\Documents\mingw64\bin\g++.exe" }
if (-not (Test-Path -LiteralPath $compiler)) { throw "A C++17 g++ compiler is required" }
$out = Join-Path $PSScriptRoot "mc-agent-v2.exe"
$sources = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot "agent") -Filter *.cpp | Select-Object -ExpandProperty FullName
& $compiler -std=c++17 -O2 -DNDEBUG -finput-charset=UTF-8 -fexec-charset=UTF-8 -static-libgcc -static-libstdc++ @sources -o $out
if ($LASTEXITCODE -ne 0) { throw "Native build failed; legacy fallback is disabled" }
Write-Host "Built $out"
