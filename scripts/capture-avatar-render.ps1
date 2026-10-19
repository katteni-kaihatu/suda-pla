$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$chromePath = Join-Path $env:ProgramFiles 'Google/Chrome/Application/chrome.exe'
$outputDirectory = Join-Path $projectRoot 'output/avatar-render'
$outputPath = Join-Path $outputDirectory 'avatar-render.png'
$captureUrl = 'http://127.0.0.1:5173/avatar-image-test.html?capture=1'

if (-not (Test-Path -LiteralPath $chromePath)) {
  throw "Chrome executable not found: $chromePath"
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$tempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('kokopla-avatar-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDirectory | Out-Null
$domPath = Join-Path $tempDirectory 'capture.html'
$errorPath = Join-Path $tempDirectory 'chrome-error.txt'

try {
  $arguments = @(
    '--headless=new',
    '--disable-gpu-sandbox',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-first-run',
    '--no-default-browser-check',
    "--user-data-dir=$tempDirectory/profile",
    '--virtual-time-budget=5000',
    '--dump-dom',
    $captureUrl
  )
  Start-Process -FilePath $chromePath -ArgumentList $arguments -WindowStyle Hidden -Wait -RedirectStandardOutput $domPath -RedirectStandardError $errorPath | Out-Null
  $dom = Get-Content -LiteralPath $domPath -Raw
  $match = [regex]::Match($dom, '<pre id="image-payload">([A-Za-z0-9+/=]+)</pre>')
  if (-not $match.Success) {
    $details = if (Test-Path -LiteralPath $errorPath) { Get-Content -LiteralPath $errorPath -Raw } else { '' }
    throw "Could not capture rendered image. Check that the dev server is running. $details"
  }

  $pngBytes = [Convert]::FromBase64String($match.Groups[1].Value)
  if ($pngBytes.Length -lt 24 -or $pngBytes[0] -ne 137 -or $pngBytes[1] -ne 80 -or $pngBytes[2] -ne 78 -or $pngBytes[3] -ne 71) {
    throw 'Captured data is not a PNG.'
  }
  $width = [System.Net.IPAddress]::NetworkToHostOrder([BitConverter]::ToInt32($pngBytes, 16))
  $height = [System.Net.IPAddress]::NetworkToHostOrder([BitConverter]::ToInt32($pngBytes, 20))
  if ($width -ne 320 -or $height -ne 480) {
    throw "Unexpected PNG dimensions: ${width}x${height}"
  }

  [System.IO.File]::WriteAllBytes($outputPath, $pngBytes)
  Write-Output "Saved: $outputPath (${width}x${height}, $($pngBytes.Length) bytes)"
}
finally {
  Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
