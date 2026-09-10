import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');

export class GitUpdater {
  constructor(options = {}) {
    this.checkIntervalMs = options.checkIntervalMs || 60000; // 1 min default
    this.branch = options.branch || 'main';
    this.remote = options.remote || 'origin';
    this.isChecking = false;
    this.lastCheckedAt = null;
    this.currentCommit = null;
    this.latestRemoteCommit = null;
    this.timer = null;
    this._init();
  }

  async _init() {
    try {
      const { stdout } = await execAsync('git rev-parse HEAD', { cwd: ROOT_DIR });
      this.currentCommit = stdout.trim();
    } catch {
      this.currentCommit = null;
    }
  }

  startAutoPolling(intervalMs = null) {
    if (intervalMs) this.checkIntervalMs = intervalMs;
    if (this.timer) clearInterval(this.timer);

    console.log(`[GitUpdater] 🔄 Auto-updater polling started (every ${Math.round(this.checkIntervalMs / 1000)}s) on ${ROOT_DIR}`);
    this.timer = setInterval(() => {
      this.checkForUpdates().catch((err) => {
        console.warn('[GitUpdater] Polling error:', err.message);
      });
    }, this.checkIntervalMs);
  }

  stopAutoPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async getStatus() {
    return {
      currentCommit: this.currentCommit ? this.currentCommit.slice(0, 7) : 'none',
      latestRemoteCommit: this.latestRemoteCommit ? this.latestRemoteCommit.slice(0, 7) : null,
      lastCheckedAt: this.lastCheckedAt,
      isChecking: this.isChecking,
      hasUpdate: Boolean(this.currentCommit && this.latestRemoteCommit && this.currentCommit !== this.latestRemoteCommit),
    };
  }

  async checkForUpdates() {
    if (this.isChecking) return { checking: true };
    this.isChecking = true;

    try {
      // 1. Check if git repo exists
      if (!fs.existsSync(path.join(ROOT_DIR, '.git'))) {
        return { ok: false, error: 'Not a git repository' };
      }

      // 2. Fetch remote silently
      try {
        await execAsync(`git fetch ${this.remote} ${this.branch}`, { cwd: ROOT_DIR, timeout: 15000 });
      } catch (fetchErr) {
        // If no remote configured yet, return gracefully
        return { ok: false, error: `Git fetch failed: ${fetchErr.message}` };
      }

      const { stdout: localHead } = await execAsync('git rev-parse HEAD', { cwd: ROOT_DIR });
      const { stdout: remoteHead } = await execAsync(`git rev-parse ${this.remote}/${this.branch}`, { cwd: ROOT_DIR });

      this.currentCommit = localHead.trim();
      this.latestRemoteCommit = remoteHead.trim();
      this.lastCheckedAt = new Date().toISOString();

      if (this.currentCommit === this.latestRemoteCommit) {
        return {
          ok: true,
          hasUpdate: false,
          currentCommit: this.currentCommit.slice(0, 7),
          message: 'Up to date',
        };
      }

      // We have new commits!
      console.log(`[GitUpdater] 🚀 New commits detected: ${this.currentCommit.slice(0, 7)} -> ${this.latestRemoteCommit.slice(0, 7)}`);

      // Inspect commits between local and remote
      const { stdout: commitLogs } = await execAsync(
        `git log ${this.currentCommit}..${this.latestRemoteCommit} --pretty=format:"%h - %s (%an)"`,
        { cwd: ROOT_DIR }
      );

      const commits = commitLogs.split('\n').filter(Boolean);
      const requiresFullRestart = commits.some(
        (c) => c.includes('REQUIRED FULL RESTART') || c.includes('FULL RESTART')
      );

      // Inspect which files were changed
      const { stdout: changedFilesRaw } = await execAsync(
        `git diff --name-only ${this.currentCommit} ${this.latestRemoteCommit}`,
        { cwd: ROOT_DIR }
      );
      const changedFiles = changedFilesRaw.split('\n').filter(Boolean);

      // Perform safe pull (ignoring data/ and preserved untracked DB files)
      // Use --quiet to suppress progress output that contains \r (carriage returns)
      // which cause PTY line-overwrite artifacts in tmux
      await execAsync(`git merge ${this.remote}/${this.branch} --ff-only --quiet`, { cwd: ROOT_DIR });
      this.currentCommit = this.latestRemoteCommit;

      console.log(`[GitUpdater] ✅ Pulled ${changedFiles.length} file(s) successfully!`);

      const result = {
        ok: true,
        hasUpdate: true,
        pulled: true,
        newCommit: this.currentCommit.slice(0, 7),
        commits,
        changedFiles,
        requiresFullRestart,
      };

      if (requiresFullRestart) {
        console.warn('[GitUpdater] ⚠️ Commit has "REQUIRED FULL RESTART" flag. Scheduling process restart in 3s...');
        // Give the HTTP server time to close its socket before the process exits,
        // so the next launch doesn't hit EADDRINUSE.
        setTimeout(() => {
          process.exit(0);
        }, 3000);
      } else {
        console.log('[GitUpdater] ⚡ Safe hot-refresh mode: Server process keeps running!');
      }

      return result;
    } catch (err) {
      console.error('[GitUpdater] Update check failed:', err.message);
      return { ok: false, error: err.message };
    } finally {
      this.isChecking = false;
    }
  }
}

export const gitUpdater = new GitUpdater();
