# SoundRazer Desktop Bootstrap Installer Script
# Downloads and installs Python, uv, dependencies, and FFmpeg

param(
    [string]$InstallDir = "$env:LOCALAPPDATA\SoundRazerDesktop",
    [switch]$Silent = $false
)

$ErrorActionPreference = "Stop"

Write-Host "SoundRazer Desktop Installer" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

# Create install directory
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Check if Python 3.11 is installed
$pythonCmd = $null
try {
    $py = py --version 2>&1
    if ($py -match "Python 3\.11") {
        $pythonCmd = "py"
    }
} catch {}

if (-not $pythonCmd) {
    try {
        $python = python --version 2>&1
        if ($python -match "Python 3\.11") {
            $pythonCmd = "python"
        }
    } catch {}
}

# Download embedded Python if needed
if (-not $pythonCmd) {
    Write-Host "Python 3.11 not found. Downloading embedded Python..." -ForegroundColor Yellow
    $pythonUrl = "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip"
    $pythonZip = "$env:TEMP\python-embed.zip"
    $pythonDir = "$InstallDir\python"
    
    Invoke-WebRequest -Uri $pythonUrl -OutFile $pythonZip
    New-Item -ItemType Directory -Force -Path $pythonDir | Out-Null
    Expand-Archive -Path $pythonZip -DestinationPath $pythonDir -Force
    Remove-Item $pythonZip
    
    # Configure embedded Python for pip
    $pthFile = Get-ChildItem "$pythonDir\python*._pth" | Select-Object -First 1
    if ($pthFile) {
        $content = Get-Content $pthFile.FullName
        $content = $content -replace '#import site', 'import site'
        Set-Content $pthFile.FullName $content
    }
    
    # Install pip
    $getPipUrl = "https://bootstrap.pypa.io/get-pip.py"
    $getPip = "$env:TEMP\get-pip.py"
    Invoke-WebRequest -Uri $getPipUrl -OutFile $getPip
    & "$pythonDir\python.exe" $getPip --no-warn-script-location
    Remove-Item $getPip
    
    $pythonCmd = "$pythonDir\python.exe"
    Write-Host "Python 3.11 installed." -ForegroundColor Green
}

# Install uv
Write-Host "Installing uv package manager..." -ForegroundColor Yellow
try {
    $uvCheck = uv --version 2>&1
    Write-Host "uv already installed." -ForegroundColor Green
} catch {
    irm https://astral.sh/uv/install.ps1 | iex
    $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
    Write-Host "uv installed." -ForegroundColor Green
}

# Install FFmpeg
Write-Host "Checking FFmpeg..." -ForegroundColor Yellow
try {
    ffmpeg -version 2>&1 | Out-Null
    Write-Host "FFmpeg already installed." -ForegroundColor Green
} catch {
    Write-Host "Downloading FFmpeg..." -ForegroundColor Yellow
    $ffmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    $ffmpegZip = "$env:TEMP\ffmpeg.zip"
    $ffmpegDir = "$InstallDir\ffmpeg"
    
    Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegZip
    New-Item -ItemType Directory -Force -Path $ffmpegDir | Out-Null
    Expand-Archive -Path $ffmpegZip -DestinationPath $ffmpegDir -Force
    
    # Move ffmpeg.exe to a known location
    $ffmpegExe = Get-ChildItem "$ffmpegDir\**\bin\ffmpeg.exe" | Select-Object -First 1
    $ffprobeExe = Get-ChildItem "$ffmpegDir\**\bin\ffprobe.exe" | Select-Object -First 1
    
    Copy-Item $ffmpegExe.FullName "$InstallDir\ffmpeg.exe"
    Copy-Item $ffprobeExe.FullName "$InstallDir\ffprobe.exe"
    
    Remove-Item $ffmpegZip
    Remove-Item $ffmpegDir -Recurse -Force
    
    # Add to PATH for this session
    $env:PATH = "$InstallDir;$env:PATH"
    
    Write-Host "FFmpeg installed." -ForegroundColor Green
}

# Create virtual environment and install the app
Write-Host "Setting up SoundRazer Desktop..." -ForegroundColor Yellow
$venvDir = "$InstallDir\venv"

if (Test-Path $venvDir) {
    Remove-Item $venvDir -Recurse -Force
}

uv venv --python 3.11 $venvDir

# Copy app files
$AppDir = "$InstallDir\app"
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
Copy-Item -Path "$PSScriptRoot\..\app\*" -Destination $AppDir -Recurse -Force
Copy-Item -Path "$PSScriptRoot\..\pyproject.toml" -Destination $InstallDir -Force

# Install
Set-Location $InstallDir
uv pip install --python "$venvDir\Scripts\python.exe" -e ".[full]"

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host "You can launch SoundRazer Desktop from the Start Menu or Desktop shortcut." -ForegroundColor Cyan
