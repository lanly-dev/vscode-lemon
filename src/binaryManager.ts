import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as https from 'https'
import * as path from 'path'
import * as vscode from 'vscode'

import { Logger } from './logger'
import type { GitHubRelease } from './interfaces'

const execAsync = promisify(exec)

const GITHUB_API = 'https://api.github.com/repos/lemonade-sdk/lemonade/releases/latest'
const GITHUB_RELEASES_API = 'https://api.github.com/repos/lemonade-sdk/lemonade/releases'

//  Manages downloading, extracting, and locating the Lemonade Server embeddable binary.
export class BinaryManager {
  constructor(private context: vscode.ExtensionContext) { }

  /** Directory where the binary is stored (in the extension's own directory). */
  get binaryDir(): string {
    return path.join(this.context.extensionPath, 'bin', 'lemonade-server')
  }

  /** Path to the lemond executable. */
  get binaryPath(): string {
    const isWindows = process.platform === 'win32'
    return path.join(this.binaryDir, isWindows ? 'lemond.exe' : 'lemond')
  }

  /** Path to the lemonade CLI executable. */
  get cliPath(): string {
    const isWindows = process.platform === 'win32'
    return path.join(this.binaryDir, isWindows ? 'lemonade.exe' : 'lemonade')
  }

  /** Check if the binary exists. */
  isBinaryInstalled(): boolean {
    if (fs.existsSync(this.binaryPath)) return true
    // Check if the binary exists in a subdirectory (from a previous extraction)
    const isWindows = process.platform === 'win32'
    const lemondName = isWindows ? 'lemond.exe' : 'lemond'
    return !this.findFile(this.binaryDir, lemondName)
  }

  /** Get the installed version, or null if not installed. */
  getInstalledVersion(): string | null {
    const versionFile = path.join(this.binaryDir, '.version')
    if (fs.existsSync(versionFile)) return fs.readFileSync(versionFile, 'utf8').trim()
    return null
  }

  /** Detect the platform-specific asset name. */
  private getAssetName(version: string): string {
    const platform = process.platform
    const arch = process.arch

    const prefix = `lemonade-embeddable-${version}`
    if (platform === 'win32' && arch === 'x64') return `${prefix}-windows-x64.zip`

    if (platform === 'linux') {
      if (arch === 'x64') return `${prefix}-ubuntu-x64.tar.gz`
      else return `${prefix}-ubuntu-arm64.tar.gz`
    }

    if (platform === 'darwin' && arch === 'arm64') return `${prefix}-macos-arm64.tar.gz`

    throw new Error(`Unsupported platform: ${platform}-${arch}`)
  }

  /** Fetch the latest release info from GitHub. */
  async getLatestRelease(): Promise<GitHubRelease> {
    return this.fetchJson(GITHUB_API)
  }

  /** Fetch a specific release by version tag. */
  async getRelease(version: string): Promise<GitHubRelease> {
    if (version === 'latest') return this.getLatestRelease()

    const url = `${GITHUB_RELEASES_API}/tags/v${version}`
    return this.fetchJson(url)
  }

  /** Fetch JSON from a URL with proper headers. */
  private fetchJson(url: string): Promise<GitHubRelease> {
    return new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'vscode-lemon-extension',
          Accept: 'application/vnd.github+json'
        }
      }
      https.get(url, options, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location
          if (location) return this.fetchJson(location).then(resolve).catch(reject)
          return reject(new Error('Redirect without location header'))
        }
        if (res.statusCode !== 200) {
          let body = ''
          res.on('data', (chunk) => { body += chunk })
          res.on('end', () => {
            reject(new Error(`GitHub API returned ${res.statusCode}: ${body}`))
          })
          return
        }
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as GitHubRelease)
          } catch (err) {
            reject(new Error(`Failed to parse GitHub API response: ${err}`))
          }
        })
      }).on('error', reject)
    })
  }

  /** Download a file with progress reporting. */
  private downloadFile(url: string, dest: string, progress?: (percent: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest)
      https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location
          if (location) {
            file.close()
            fs.unlinkSync(dest)
            return this.downloadFile(location, dest, progress).then(resolve).catch(reject)
          }
          return reject(new Error('Redirect without location header'))
        }
        if (res.statusCode !== 200) {
          file.close()
          fs.unlinkSync(dest)
          return reject(new Error(`Download failed with status ${res.statusCode}`))
        }

        const totalBytes = parseInt(
          res.headers['content-range']?.split('/')[1]
          ?? res.headers['content-length']
          ?? '0',
          10
        )
        let receivedBytes = 0

        res.on('data', (chunk) => {
          receivedBytes += chunk.length
          if (totalBytes > 0 && progress) progress(Math.round((receivedBytes / totalBytes) * 100))
        })

        res.pipe(file)
        file.on('finish', () => {
          file.close()
          resolve()
        })
        file.on('error', (err) => {
          fs.unlinkSync(dest)
          reject(err)
        })
      }).on('error', (err) => {
        file.close()
        if (fs.existsSync(dest))
          fs.unlinkSync(dest)
        reject(err)
      })
    })
  }

  /** Extract a zip file (Windows). */
  private async extractZip(zipPath: string, destDir: string): Promise<void> {
    const isWindows = process.platform === 'win32'
    if (isWindows) {
      // Use PowerShell's Expand-Archive on Windows
      await execAsync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`)
    } else {
      // Use unzip on Unix
      await execAsync(`unzip -o '${zipPath}' -d '${destDir}'`)
    }
  }

  /** Extract a tar.gz file (Linux/macOS). */
  private async extractTarGz(tarPath: string, destDir: string): Promise<void> {
    await execAsync(`tar -xzf '${tarPath}' -C '${destDir}'`)
  }

  /** Download and install the Lemonade Server binary. */
  async downloadBinary(): Promise<string> {
    const config = vscode.workspace.getConfiguration('lemon')
    const versionConfig = config.get<string>('binaryVersion', 'latest')

    Logger.info(`Fetching release info (version: ${versionConfig})...`)

    const release = await this.getRelease(versionConfig)
    const version = release.tag_name.replace(/^v/, '')
    Logger.info(`Latest release: ${release.tag_name}`)

    const assetName = this.getAssetName(version)
    const asset = release.assets.find((a) => a.name === assetName)

    if (!asset) {
      const msg = `Could not find asset '${assetName}' in release ${release.tag_name}`
      throw new Error(msg)
    }

    // Ensure the binary directory exists
    fs.mkdirSync(this.binaryDir, { recursive: true })

    // Download the archive
    const archivePath = path.join(this.binaryDir, assetName)
    Logger.info(`Downloading ${assetName} (${(asset.size / 1024 / 1024).toFixed(1)} MB)...`)

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading Lemonade Server v${version}`,
        cancellable: false
      },
      async (progress) => {
        let lastReported = 0
        await this.downloadFile(asset.browser_download_url, archivePath, (percent) => {
          const increment = percent - lastReported
          if (increment > 0) {
            progress.report({ increment, message: `${percent}% downloaded` })
            lastReported = percent
          }
        })
      }
    )

    Logger.info('Download complete. Extracting...')

    // Extract the archive
    if (assetName.endsWith('.zip')) await this.extractZip(archivePath, this.binaryDir)
    else await this.extractTarGz(archivePath, this.binaryDir)

    // Clean up the archive
    fs.unlinkSync(archivePath)

    // The archive may extract into a subdirectory. Find the binary.
    this.locateBinaryFiles()

    // Make the binary executable on Unix
    if (process.platform !== 'win32') {
      fs.chmodSync(this.binaryPath, 0o755)
      if (fs.existsSync(this.cliPath)) fs.chmodSync(this.cliPath, 0o755)
    }

    // Save the version
    const versionFile = path.join(this.binaryDir, '.version')
    fs.writeFileSync(versionFile, version, 'utf8')

    Logger.info(`Lemonade Server v${version} installed successfully`)
    return version
  }

  /**
   * Find the lemond/lemonade executables after extraction.
   * The archive may extract into a subdirectory whose contents we need to
   * merge into the binary directory root (resources/, config.json, etc. must
   * sit next to the lemond executable for it to start correctly).
   */
  private locateBinaryFiles(): void {
    const isWindows = process.platform === 'win32'
    const lemondName = isWindows ? 'lemond.exe' : 'lemond'
    const lemonadeName = isWindows ? 'lemonade.exe' : 'lemonade'

    // If the binary is already in the right place, nothing to do
    if (fs.existsSync(this.binaryPath)) return

    // Find a subdirectory that contains the lemond executable
    const found = this.findFile(this.binaryDir, lemondName)
    if (!found) {
      Logger.error(`Could not locate ${lemondName} after extraction`)
      return
    }

    // The executable's parent directory contains the full deployment layout
    const sourceDir = path.dirname(found)
    if (sourceDir !== this.binaryDir) {
      Logger.info(`Merging extracted contents from ${sourceDir} into ${this.binaryDir}`)
      this.mergeDirectory(sourceDir, this.binaryDir)
    }

    const foundCli = this.findFile(this.binaryDir, lemonadeName)
    if (foundCli) Logger.info(`Found lemonade CLI at ${foundCli}`)
  }

  /** Recursively merge sourceDir into targetDir. */
  private mergeDirectory(sourceDir: string, targetDir: string): void {
    fs.mkdirSync(targetDir, { recursive: true })
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(sourceDir, entry.name)
      const dstPath = path.join(targetDir, entry.name)
      if (entry.isDirectory()) this.mergeDirectory(srcPath, dstPath)
      else {
        // Do not overwrite an existing file unless it's the binary
        if (fs.existsSync(dstPath) && entry.name !== 'lemond.exe' && entry.name !== 'lemond') continue
        fs.mkdirSync(path.dirname(dstPath), { recursive: true })
        fs.copyFileSync(srcPath, dstPath)
      }
    }
  }

  /** Recursively search for a file by name. */
  private findFile(dir: string, fileName: string): string | null {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isFile() && entry.name === fileName) return fullPath
        if (entry.isDirectory()) {
          const found = this.findFile(fullPath, fileName)
          if (found) return found
        }
      }
    } catch {
      // Ignore errors reading directories
    }
    return null
  }

  /** Ensure the binary is installed, downloading if necessary. */
  async ensureBinary(): Promise<boolean> {
    // If the binary exists in a subdirectory, move it to the right place
    if (this.isBinaryInstalled() && !fs.existsSync(this.binaryPath)) {
      Logger.info('Binary found in subdirectory, relocating...')
      this.locateBinaryFiles()
    }

    if (this.isBinaryInstalled()) {
      Logger.info('Lemonade Server binary already installed')
      return true
    }

    const action = await vscode.window.showInformationMessage(
      'Lemonade Server binary is not installed. Would you like to download it now?',
      'Download',
      'Cancel'
    )

    if (action === 'Download') {
      try {
        await this.downloadBinary()
        return true
      } catch (err) {
        Logger.error('Failed to download binary', err)
        vscode.window.showErrorMessage(`Failed to download Lemonade Server: ${err}`)
        return false
      }
    }
    return false
  }

  /** Check for updates and optionally install them. */
  async checkForUpdates(): Promise<void> {
    if (!this.isBinaryInstalled()) {
      Logger.info('Binary not installed, skipping update check')
      return
    }

    try {
      const release = await this.getLatestRelease()
      const latestVersion = release.tag_name.replace(/^v/, '')
      const installedVersion = this.getInstalledVersion()

      if (installedVersion !== latestVersion) {
        Logger.info(`Update available: ${installedVersion} -> ${latestVersion}`)
        const action = await vscode.window.showInformationMessage(
          `Lemonade Server update available: v${latestVersion} (installed: v${installedVersion}). Update now?`,
          'Update',
          'Later'
        )
        if (action === 'Update') await this.downloadBinary()
      } else Logger.info(`Lemonade Server is up to date (v${installedVersion})`)
    } catch (err) {
      Logger.error('Failed to check for updates', err)
    }
  }
}
