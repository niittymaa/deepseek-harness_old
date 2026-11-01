<#
.SYNOPSIS
    DeepSeek Harness update and startup script.

.DESCRIPTION
    Checks for remote repository updates, pulls latest changes if available,
    installs dependencies and builds artifacts when needed, and starts the application.
    By default, starts as a desktop application. Desktop cleanup stops only process trees
    whose Electron entry argument identifies this checkout; unrelated Electron apps are preserved.

.PARAMETER Target
    Application target to start: 'desktop' (default) or 'web'.

.PARAMETER Port
    Port number for web server mode (default: 3080).

.PARAMETER Dev
    If specified, launches in dev/watch mode instead of standard start mode.

.PARAMETER SkipUpdate
    If specified, skips remote update check and launches immediately.

.PARAMETER Force
    Automatically terminates existing instance occupying the port without prompting.
#>

[CmdletBinding()]
param(
    [ValidateSet('desktop', 'web')]
    [string]$Target = 'desktop',

    [int]$Port = 3080,

    [switch]$Dev,

    [switch]$SkipUpdate,

    [switch]$Rebuild,

    [switch]$Force
)

Set-Location -Path $PSScriptRoot
. (Join-Path $PSScriptRoot "scripts/launcher-processes.ps1")

# Run the pnpm version package.json pins (packageManager). A globally
# installed older pnpm reinstalls node_modules from scratch in its own layout
# and rewrites pnpm-lock.yaml in its own format. A function takes precedence
# over the executable on PATH for every `pnpm` call below.
if (Get-Command corepack -ErrorAction SilentlyContinue) {
    function pnpm { & corepack pnpm @args }
} else {
    Write-Host "[!] corepack was not found; using the pnpm on PATH, which must match packageManager in package.json." -ForegroundColor Yellow
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "       DeepSeek Harness Launcher          " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# Configure desktop app environment
$env:DSH_DESKTOP_QUIT_ON_CLOSE = '1'
$env:ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
$env:ELECTRON_ENABLE_LOGGING = '0'
$env:DSH_DESKTOP_OPEN_DEVTOOLS = '0'

# 1. Update check
if ($SkipUpdate) {
    Write-Host "`n[1/3] Skipping update check (-SkipUpdate specified)." -ForegroundColor Yellow
} else {
    Write-Host "`n[1/3] Checking for updates from remote repository..." -ForegroundColor Cyan

    $currentBranch = (git rev-parse --abbrev-ref HEAD 2>$null)
    if (-not $currentBranch) {
        $currentBranch = "master"
    } else {
        $currentBranch = $currentBranch.Trim()
    }

    Write-Host "Current branch: $currentBranch"

    # Fetch updates from remote without letting PowerShell treat stderr as terminating error
    git fetch origin $currentBranch
    if ($LASTEXITCODE -eq 0) {
        $localCommit = (git rev-parse HEAD 2>$null)
        $remoteCommit = (git rev-parse "origin/$currentBranch" 2>$null)

        if ($localCommit -and $remoteCommit) {
            $localCommit = $localCommit.Trim()
            $remoteCommit = $remoteCommit.Trim()

            if ($localCommit -ne $remoteCommit) {
                $behindCount = (git rev-list --count "$localCommit..origin/$currentBranch" 2>$null)
                if ($behindCount) { $behindCount = $behindCount.Trim() }

                if ($behindCount -and [int]$behindCount -gt 0) {
                    Write-Host "Found $behindCount new commit(s) on remote origin/$currentBranch." -ForegroundColor Yellow

                    $stashed = $false
                    $dirtyStatus = (git status --porcelain 2>$null)
                    if ($dirtyStatus) {
                        Write-Host "Stashing local changes before pull..." -ForegroundColor Yellow
                        git stash push -m "launcher-auto-stash" 2>&1 | Out-Null
                        $stashed = $true
                    }

                    Write-Host "Pulling latest updates..." -ForegroundColor Green
                    git pull --ff-only origin $currentBranch

                    if ($stashed) {
                        Write-Host "Restoring local changes..." -ForegroundColor Yellow
                        git stash pop 2>&1 | Out-Null
                    }

                    Write-Host "Updating dependencies..." -ForegroundColor Cyan
                    pnpm install
                    if ($LASTEXITCODE -ne 0) {
                        Write-Host "`n[!] pnpm install failed with exit code $LASTEXITCODE." -ForegroundColor Red
                        exit $LASTEXITCODE
                    }
                    Write-Host "Updates pulled successfully." -ForegroundColor Green
                } else {
                    Write-Host "Repository is already up to date with origin/$currentBranch." -ForegroundColor Green
                }
            } else {
                Write-Host "Repository is already up to date." -ForegroundColor Green
            }
        }
    } else {
        Write-Host "Warning: Could not fetch updates from origin. Continuing with launch..." -ForegroundColor Yellow
    }
}

# 2. Verify dependencies and build status
Write-Host "`n[2/3] Verifying environment and build status..." -ForegroundColor Cyan

$stampFile = "apps/desktop/.desktop-build/build.stamp"
$currentCommit = (git rev-parse HEAD 2>$null)
if ($currentCommit) { $currentCommit = $currentCommit.Trim() }

# Check if dependencies need installation
$needsInstall = (-not (Test-Path "node_modules"))
if (-not $needsInstall -and (Test-Path "pnpm-lock.yaml") -and (Test-Path $stampFile)) {
    try {
        $lockTime = (Get-Item "pnpm-lock.yaml").LastWriteTimeUtc
        $stamp = Get-Content $stampFile -Raw | ConvertFrom-Json
        if ($lockTime -gt [DateTime]$stamp.builtAt) {
            $needsInstall = $true
            Write-Host "pnpm-lock.yaml has changed since last build." -ForegroundColor Yellow
        }
    } catch {}
}

if ($needsInstall) {
    Write-Host "Running pnpm install..." -ForegroundColor Yellow
    pnpm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n[!] pnpm install failed with exit code $LASTEXITCODE." -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

# Verify required build artifacts exist for the selected target and common dependencies
$artifactsMissing = $false
if (-not (Test-Path "packages/boot/app-boot/lib/index.js") -or -not (Test-Path "packages/util/atomic-write/lib/index.js") -or -not (Test-Path "packages/client/ui-settings-models/lib/client.js")) {
    $artifactsMissing = $true
} elseif ($Target -eq 'desktop' -and (-not (Test-Path "apps/desktop/lib/main.js") -or -not (Test-Path "apps/desktop-host/lib/index.js"))) {
    $artifactsMissing = $true
} elseif ($Target -eq 'web' -and (-not (Test-Path "apps/web/dist/index.html"))) {
    $artifactsMissing = $true
}

# Detect changes: git commit change, uncommitted modified source files, missing stamp or missing artifacts
$needsBuild = $false
$buildReason = ""

if ($Rebuild) {
    $needsBuild = $true
    $buildReason = "-Rebuild switch specified"
} elseif ($artifactsMissing) {
    $needsBuild = $true
    $buildReason = "required build artifacts are missing"
} elseif (-not (Test-Path $stampFile)) {
    $needsBuild = $true
    $buildReason = "no previous build stamp found"
} else {
    try {
        $rawStamp = Get-Content $stampFile -Raw
        $stampCommit = $null
        $stampTime = [DateTime]::MinValue

        if ($rawStamp -match '^\s*\{') {
            $stamp = $rawStamp | ConvertFrom-Json
            $stampCommit = $stamp.commit
            if ($stamp.builtAt) {
                $stampTime = [DateTime]$stamp.builtAt
            }
        } elseif ($rawStamp -match '^[0-9a-fA-F]{7,40}\s*$') {
            $stampCommit = $rawStamp.Trim()
            $stampTime = (Get-Item $stampFile).LastWriteTimeUtc
        } else {
            throw "unrecognized build stamp format"
        }

        if ($currentCommit -and ($currentCommit -ne $stampCommit)) {
            $shortPrev = if ($stampCommit.Length -ge 7) { $stampCommit.Substring(0, 7) } else { $stampCommit }
            $shortCurr = if ($currentCommit.Length -ge 7) { $currentCommit.Substring(0, 7) } else { $currentCommit }
            $needsBuild = $true
            $buildReason = "Git commit changed ($shortPrev -> $shortCurr)"
        } else {
            # Check for uncommitted modified/added source files
            $dirtyStatus = (git status --porcelain packages/ apps/ vendor/ scripts/ package.json pnpm-lock.yaml 2>$null)
            if ($dirtyStatus) {
                $lines = $dirtyStatus -split "`r?`n" | Where-Object { $_.Trim() -ne '' }
                foreach ($line in $lines) {
                    $relPath = $line.Substring(3).Trim()
                    if ($relPath -match "->\s*(.+)$") {
                        $relPath = $matches[1].Trim()
                    }
                    if (Test-Path $relPath) {
                        $item = Get-Item $relPath -ErrorAction SilentlyContinue
                        if ($item -and $item.LastWriteTimeUtc -gt $stampTime.ToUniversalTime()) {
                            $needsBuild = $true
                            $buildReason = "source file modified: $relPath ($($item.LastWriteTime.ToString('HH:mm:ss')))"
                            break
                        }
                    }
                }
            }
        }
    } catch {
        $needsBuild = $true
        $buildReason = "unable to parse build stamp, forcing rebuild: $_"
    }
}

if ($needsBuild) {
    Write-Host "Changes detected: $buildReason" -ForegroundColor Yellow
    Write-Host "Building workspace artifacts (pnpm run build:artifacts)..." -ForegroundColor Cyan
    pnpm run build:artifacts
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n[!] Build failed with exit code $LASTEXITCODE." -ForegroundColor Red
        exit $LASTEXITCODE
    }

    # Record the build stamp
    $stampDir = Split-Path -Parent $stampFile
    if (-not (Test-Path $stampDir)) {
        New-Item -ItemType Directory -Path $stampDir -Force | Out-Null
    }
    @{
        commit = $currentCommit
        builtAt = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json | Set-Content -Path $stampFile -Force

    Write-Host "Build completed and build stamp updated successfully." -ForegroundColor Green
} else {
    Write-Host "Build artifacts are up-to-date (no changes detected)." -ForegroundColor Green
}

# 3. Clean up stale background processes
if ($Target -eq 'desktop') {
    Write-Host "Cleaning up previous desktop processes from this checkout..." -ForegroundColor Cyan
    Stop-HarnessDesktopProcesses -RepositoryRoot $PSScriptRoot
} elseif ($Target -eq 'web') {
    # Check port conflicts for web mode
    $portConn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($portConn) {
        $procId = $portConn.OwningProcess
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        $procName = if ($proc) { $proc.ProcessName } else { "Unknown" }

        Write-Host "`n[!] Port $Port is currently in use by process '$procName' (PID: $procId)." -ForegroundColor Yellow

        $shouldTerminate = $Force.IsPresent
        if (-not $shouldTerminate) {
            $choice = Read-Host "Do you want to stop the existing process to launch a fresh instance? [Y/n]"
            if ($choice -eq '' -or $choice -match '^[Yy]') {
                $shouldTerminate = $true
            }
        }

        if ($shouldTerminate) {
            Write-Host "Stopping process $procId..." -ForegroundColor Cyan
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
            Write-Host "Port $Port is now free." -ForegroundColor Green
        } else {
            Write-Host "Existing instance remains active. You can access it in your browser at: http://localhost:$Port" -ForegroundColor Green
            exit 0
        }
    }
}

# 4. Launch application
Write-Host "`n[3/3] Starting DeepSeek Harness ($Target mode)..." -ForegroundColor Green
Write-Host "------------------------------------------" -ForegroundColor Gray

$exitCode = 0
try {
    if ($Target -eq 'desktop') {
        Write-Host "Initializing desktop application (opening Electron window in ~3s)..." -ForegroundColor Cyan
        Write-Host "(Note: '[WARN] Unsupported platform' lines from pnpm are normal on Windows and can be ignored)`n" -ForegroundColor DarkGray
        if ($Dev) {
            pnpm run dev:desktop
        } else {
            pnpm run start:desktop
        }
        $exitCode = $LASTEXITCODE
    } elseif ($Target -eq 'web') {
        if ($Dev) {
            Write-Host "Running: pnpm run dev:web -- --port $Port" -ForegroundColor Cyan
            pnpm run dev:web -- --port $Port
        } else {
            Write-Host "Running: pnpm run start:web -- --port $Port" -ForegroundColor Cyan
            pnpm run start:web -- --port $Port
        }
        $exitCode = $LASTEXITCODE
    }
} finally {
    # Ensure all background processes are cleaned up when the app exits
    if ($Target -eq 'desktop') {
        Write-Host "`nShutting down desktop environment..." -ForegroundColor Cyan
        Stop-HarnessDesktopProcesses -RepositoryRoot $PSScriptRoot
    }
}

exit $exitCode
