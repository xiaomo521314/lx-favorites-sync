'use strict';

// LX Music → Folia 收藏同步模组（主进程部分）
//
// 职责：
// - 只读查询 LX Music 的数据库（"我喜欢"列表、下载记录、下载目录）
// - 把模组自己的数据写进 Folia 官方给每个模组的专属目录：
//     <userData>/mods-data/lx-favorites-sync/
//   设置与同步状态这类小数据走 api.storage.data（mod-data.json，上限 1 MB），
//   日志与备份这类大文件放在上面的专属目录里。
// - 不再向 userData 根目录散写文件；旧版本（<=1.6.3）遗留文件会做一次性迁移。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE_NAME = 'lx.data.db';
const LOG_FILE_NAME = 'lx-favorites-sync.log';
const BACKUP_DIR_NAME = 'backups';
const MAX_BACKUPS = 30;
const MAX_LOG_BYTES = 1024 * 1024;
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SCANNED_FILES = 5000;
const MAX_SCAN_DEPTH = 6;
// 扫描最多访问的目录数：下载目录可能包含每个已下载文件所在的文件夹，
// 甚至下载到桌面 / 用户目录，限制目录数避免同步时长时间卡界面。
const MAX_SCAN_DIRECTORIES = 250;
// 参与扫描、写进同步状态的下载根目录数上限。
const MAX_DOWNLOAD_ROOTS = 12;
const STORAGE_KEY_SETTINGS = 'settings';
const STORAGE_KEY_STATUS = 'status';
const SETTINGS_DEFAULT = Object.freeze({ mode: 'merge' });
const SYNC_MODES = new Set(['mirror', 'merge']);
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.m4a', '.wav', '.ogg', '.opus', '.aac', '.alac',
  '.ape', '.wv', '.tta', '.wma', '.aif', '.aiff', '.caf'
]);

// 旧版本直接写在 userData 根目录的名称；升级后搬迁/清理。
const LEGACY_BACKUP_DIR_NAME = 'lx-favorites-sync-backups';
const LEGACY_LOG_FILE_NAMES = ['lx-favorites-sync.log', 'lx-favorites-sync.log.old'];
const LEGACY_SETTINGS_FILE_NAME = 'lx-favorites-sync-settings.json';
const LEGACY_STATUS_FILE_NAMES = ['lx-favorites-sync-status.json', 'lx-favorites-sync-status.txt'];

let modDataDirectory = null;

const safeJson = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const getUserDataDirectory = () => {
  try {
    const electron = require('electron');
    const appPath = electron && electron.app && typeof electron.app.getPath === 'function'
      ? electron.app.getPath('userData')
      : null;
    if (appPath) {
      return appPath;
    }
  } catch {
    // The mod main normally runs in Electron. The fallback keeps the helper
    // testable with plain Node.
  }

  const base = process.env.APPDATA || process.env.USERPROFILE || process.cwd();
  return path.join(base, 'Folia');
};

const getModDataDirectory = () => modDataDirectory
  || path.join(getUserDataDirectory(), 'mods-data', 'lx-favorites-sync');

const getLogPath = () => path.join(getModDataDirectory(), LOG_FILE_NAME);

const getBackupDirectory = () => path.join(getModDataDirectory(), BACKUP_DIR_NAME);

const removeFileQuietly = (filePath) => {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Already gone or not removable; nothing else to do.
  }
};

// 日志轮转：当前文件超过 1 MB 时换一份 .old（最多保留一份），
// .old 超过 7 天自动删除。都只在写日志时顺手检查，不依赖任何后台任务。
const rotateLogIfNeeded = (logPath) => {
  const rotatedPath = `${logPath}.old`;
  try {
    const stat = fs.statSync(logPath);
    if (stat.size >= MAX_LOG_BYTES) {
      removeFileQuietly(rotatedPath);
      fs.renameSync(logPath, rotatedPath);
    }
  } catch {
    // Current log does not exist yet; nothing to rotate.
  }
  try {
    const rotatedStat = fs.statSync(rotatedPath);
    if (Date.now() - rotatedStat.mtimeMs > LOG_RETENTION_MS) {
      removeFileQuietly(rotatedPath);
    }
  } catch {
    // No rotated log.
  }
};

const appendLog = (level, message, details) => {
  const line = `${new Date().toISOString()} [${String(level).toUpperCase()}] ${message}${details === undefined ? '' : ` ${safeJson(details)}`}\n`;
  try {
    const logPath = getLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    rotateLogIfNeeded(logPath);
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (error) {
    console.error(`[LX-Folia] Could not write log: ${error.message}`);
  }

  const log = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  log(`[LX-Folia] ${message}`, details === undefined ? '' : details);
};

const candidateLxDataDirectories = () => {
  const candidates = [];
  if (process.env.LX_MUSIC_DATA_DIR) {
    candidates.push(process.env.LX_MUSIC_DATA_DIR);
  }
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'lx-music-desktop', 'LxDatas'));
    candidates.push(path.join(process.env.APPDATA, 'lx-music-desktop'));
  }
  if (process.env.USERPROFILE) {
    candidates.push(path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'lx-music-desktop', 'LxDatas'));
  }

  // macOS / Linux：LX Music 的默认数据目录（未实测，作为理论支持）。
  try {
    const home = os.homedir();
    if (process.platform === 'darwin') {
      candidates.push(path.join(home, 'Library', 'Application Support', 'lx-music-desktop', 'LxDatas'));
      candidates.push(path.join(home, 'Library', 'Application Support', 'lx-music-desktop'));
    } else if (process.platform !== 'win32') {
      const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
      candidates.push(path.join(configHome, 'lx-music-desktop', 'LxDatas'));
      candidates.push(path.join(configHome, 'lx-music-desktop'));
    }
  } catch {
    // os.homedir() failing is unusual; skip the extra candidates.
  }

  return [...new Set(candidates)];
};

const findLxDatabase = () => {
  for (const directory of candidateLxDataDirectories()) {
    if (!directory) {
      continue;
    }
    const direct = path.join(directory, DB_FILE_NAME);
    if (fs.existsSync(direct)) {
      return direct;
    }
    try {
      const nested = fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(directory, entry.name, DB_FILE_NAME))
        .find((file) => fs.existsSync(file));
      if (nested) {
        return nested;
      }
    } catch {
      // Continue with the next candidate.
    }
  }
  return null;
};

const parseAlbumName = (metaText) => {
  if (!metaText || typeof metaText !== 'string') {
    return '';
  }
  try {
    const meta = JSON.parse(metaText);
    return typeof meta.albumName === 'string' ? meta.albumName : '';
  } catch {
    return '';
  }
};

const parseMusicInfoId = (metaText) => {
  if (!metaText || typeof metaText !== 'string') {
    return '';
  }
  try {
    const meta = JSON.parse(metaText);
    return typeof meta?.id === 'string' ? meta.id : '';
  } catch {
    return '';
  }
};

const normalizePath = (value) => path.normalize(String(value || '')).replace(/[\\/]+$/, '');

const readLxConfig = (databasePath) => {
  const configPath = path.join(path.dirname(databasePath), 'config_v2.json');
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const setting = config && typeof config.setting === 'object' ? config.setting : {};
    return {
      path: configPath,
      savePath: typeof setting['download.savePath'] === 'string' ? setting['download.savePath'] : '',
      groupByListName: setting['download.isSavePathGroupByListName'] === true
    };
  } catch {
    return {};
  }
};

// 扫描下载根目录里的音频文件名（只读、限深限量），用于给"缺失歌曲"提供
// "文件可能已存在、只是没被 Folia 扫描"的宽松提示。
const scanAudioFileNames = (roots) => {
  const names = [];
  const seenNames = new Set();
  const queue = roots.map((root) => ({ directory: root, depth: 0 }));
  let cursor = 0;
  let visitedDirectories = 0;
  while (
    cursor < queue.length
    && names.length < MAX_SCANNED_FILES
    && visitedDirectories < MAX_SCAN_DIRECTORIES
  ) {
    const { directory, depth } = queue[cursor];
    cursor += 1;
    visitedDirectories += 1;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (names.length >= MAX_SCANNED_FILES) {
        break;
      }
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH) {
          queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || !AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      if (seenNames.has(entry.name)) {
        continue;
      }
      seenNames.add(entry.name);
      names.push(entry.name);
    }
  }
  return names;
};

const queryLxData = (database, databasePath) => {
  const itemRows = database.prepare(`
    select m.id, m.name, m.singer, m.source, m.interval, m.meta, o."order"
    from my_list_music_info m
    left join my_list_music_info_order o
      on o.listId = m.listId and o.musicInfoId = m.id
    where m.listId = 'love'
    order by coalesce(o."order", 999999999), m.id
  `).all();

  let downloadRows = [];
  try {
    downloadRows = database.prepare(`
      select filePath, musicInfo
      from download_list
      where isComplate = 1 and filePath is not null and filePath != ''
    `).all();
  } catch {
    // Older LX builds may not have this table; favorites still sync normally.
  }

  const config = readLxConfig(databasePath);
  const roots = [];
  const addRoot = (value) => {
    const normalized = normalizePath(value);
    if (
      normalized
      && roots.length < MAX_DOWNLOAD_ROOTS
      && !roots.some((root) => root.toLowerCase() === normalized.toLowerCase())
    ) {
      roots.push(normalized);
    }
  };

  if (config.savePath) {
    addRoot(config.savePath);
  }

  const downloadIndex = {};
  downloadRows.forEach((row) => {
    const filePath = String(row.filePath || '');
    if (!filePath) {
      return;
    }
    addRoot(path.dirname(filePath));
    const musicId = parseMusicInfoId(String(row.musicInfo || ''));
    if (!musicId) {
      return;
    }
    let exists = false;
    try {
      exists = fs.existsSync(filePath);
    } catch {
      exists = false;
    }
    downloadIndex[musicId] = { exists };
  });

  return {
    items: itemRows.map((row) => ({
      id: String(row.id ?? ''),
      name: String(row.name ?? ''),
      singer: String(row.singer ?? ''),
      source: String(row.source ?? ''),
      interval: String(row.interval ?? ''),
      albumName: parseAlbumName(row.meta)
    })).filter((row) => row.name),
    downloadIndex,
    scannedFiles: scanAudioFileNames(roots),
    downloadRoots: roots,
    lxConfigPath: config.path || '',
    lxSavePath: config.savePath || ''
  };
};

const copyDatabaseWithWal = (databasePath) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-favorites-sync-'));
  const copiedPath = path.join(tempDirectory, DB_FILE_NAME);
  const copiedFiles = [];
  const copyIfPresent = (source, target) => {
    if (!fs.existsSync(source)) {
      return false;
    }
    fs.copyFileSync(source, target);
    copiedFiles.push(target);
    return true;
  };

  try {
    copyIfPresent(databasePath, copiedPath);
    copyIfPresent(`${databasePath}-wal`, `${copiedPath}-wal`);
    copyIfPresent(`${databasePath}-shm`, `${copiedPath}-shm`);
    const database = new DatabaseSync(copiedPath);
    return {
      database,
      cleanup: () => {
        try {
          database.close();
        } catch {
          // Already closed.
        }
        copiedFiles.forEach((file) => {
          try {
            fs.unlinkSync(file);
          } catch {
            // Best-effort cleanup.
          }
        });
        try {
          fs.rmdirSync(tempDirectory);
        } catch {
          // Best-effort cleanup.
        }
      }
    };
  } catch (error) {
    copiedFiles.forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        // Best-effort cleanup.
      }
    });
    try {
      fs.rmdirSync(tempDirectory);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }
};

const readLxFavorites = () => {
  const databasePath = findLxDatabase();
  if (!databasePath) {
    throw new Error('没有找到 LX Music 数据库，请确认 LX Music 已使用过，或设置 LX_MUSIC_DATA_DIR');
  }

  // 1) 以普通只读方式直接打开原库：SQLite 会按 WAL 语义读到最新的已提交数据
  //    （不再使用 immutable=1，它会忽略未检查点的 WAL，可能读到旧列表）。
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      try {
        database.exec('PRAGMA busy_timeout = 3000');
      } catch {
        // Fine; just proceed without the extra patience.
      }
      return { databasePath, ...queryLxData(database, databasePath) };
    } finally {
      database.close();
    }
  } catch (error) {
    appendLog('warn', '直读 LX 数据库失败，改用快照副本读取', { error: error.message });
  }

  // 2) 直读失败时（例如残留 WAL 需要恢复、目录不可写或文件被独占），
  //    退回到复制 db/-wal/-shm 快照后在临时目录里读取。
  const copy = copyDatabaseWithWal(databasePath);
  try {
    return { databasePath, ...queryLxData(copy.database, databasePath) };
  } finally {
    copy.cleanup();
  }
};

const pruneBackups = (backupDirectory) => {
  try {
    const files = fs.readdirSync(backupDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(backupDirectory, entry.name))
      .sort()
      .reverse();
    files.slice(MAX_BACKUPS).forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        // Best-effort cleanup.
      }
    });
  } catch {
    // Best-effort cleanup.
  }
};

const saveBackup = (payload) => {
  const baseDirectory = getBackupDirectory();
  fs.mkdirSync(baseDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(baseDirectory, `${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  pruneBackups(baseDirectory);
  return { file: path.basename(file) };
};

// 兼容新旧备份结构：新格式 before.songIds；旧格式 before 是收藏歌单对象，
// 更老的格式可能在 beforePlaylists 里。
const pickBeforeSongIds = (backup) => {
  if (Array.isArray(backup?.before?.songIds)) {
    return backup.before.songIds;
  }
  if (Array.isArray(backup?.before)) {
    return backup.before;
  }
  const favorite = Array.isArray(backup?.beforePlaylists)
    ? backup.beforePlaylists.find((playlist) => playlist && playlist.isFavorite)
    : null;
  return Array.isArray(favorite?.songIds) ? favorite.songIds : [];
};

const readBackupList = () => {
  const baseDirectory = getBackupDirectory();
  let entries = [];
  try {
    entries = fs.readdirSync(baseDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  } catch {
    return [];
  }

  const list = [];
  for (const entry of entries) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(baseDirectory, entry.name), 'utf8'));
      const legacySummary = parsed && typeof parsed.summary === 'object' ? parsed.summary : null;
      const counts = parsed && typeof parsed.counts === 'object' && parsed.counts
        ? {
            added: Number(parsed.counts.added) || 0,
            removed: Number(parsed.counts.removed) || 0,
            previous: Number(parsed.counts.previous) || 0,
            next: Number(parsed.counts.next) || 0
          }
        : legacySummary
          ? {
              added: Number(legacySummary.addedCount) || 0,
              removed: Number(legacySummary.removedCount) || 0,
              previous: Number(legacySummary.previousCount) || 0,
              next: Number(legacySummary.nextCount) || 0
            }
          : null;
      list.push({
        file: entry.name,
        at: String(parsed?.at || ''),
        reason: String(parsed?.reason || ''),
        mode: String(parsed?.mode || legacySummary?.mode || ''),
        counts,
        changes: parsed?.changes && typeof parsed.changes === 'object' ? parsed.changes : null,
        before: { songIds: pickBeforeSongIds(parsed) }
      });
    } catch {
      // Skip broken backup files rather than failing the whole list.
    }
  }

  return list.sort((left, right) => (
    left.at === right.at ? (left.file < right.file ? 1 : -1) : (left.at < right.at ? 1 : -1)
  ));
};

module.exports = (api) => {
  modDataDirectory = path.join(getUserDataDirectory(), 'mods-data', api.manifest.id);
  const storage = api.storage.data;
  const legacyRoot = getUserDataDirectory();

  // 一次性搬迁旧版本散落在 userData 根目录的文件：
  // 备份目录整体挪进 mods-data，旧日志直接清理（日志已改存新位置）。
  try {
    const legacyBackupDir = path.join(legacyRoot, LEGACY_BACKUP_DIR_NAME);
    const newBackupDir = getBackupDirectory();
    if (fs.existsSync(legacyBackupDir) && !fs.existsSync(newBackupDir)) {
      fs.mkdirSync(getModDataDirectory(), { recursive: true });
      fs.renameSync(legacyBackupDir, newBackupDir);
    }
  } catch {
    // 搬迁失败时保留旧目录，不影响同步功能。
  }
  LEGACY_LOG_FILE_NAMES.forEach((name) => removeFileQuietly(path.join(legacyRoot, name)));

  const readJsonQuietly = (filePath) => {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  };

  // 设置与状态存进官方 storage（mod-data.json）；旧文件在首次读取时迁移一次。
  const readSettings = async () => {
    let stored = null;
    try {
      stored = await storage.get(STORAGE_KEY_SETTINGS);
    } catch {
      stored = null;
    }
    if (!stored) {
      const legacy = readJsonQuietly(path.join(legacyRoot, LEGACY_SETTINGS_FILE_NAME));
      if (legacy && typeof legacy === 'object') {
        stored = legacy;
        try {
          await storage.set(STORAGE_KEY_SETTINGS, legacy);
        } catch {
          // Migration is best-effort; the value still takes effect this session.
        }
        removeFileQuietly(path.join(legacyRoot, LEGACY_SETTINGS_FILE_NAME));
      }
    }
    return {
      ...SETTINGS_DEFAULT,
      mode: SYNC_MODES.has(stored?.mode) ? stored.mode : SETTINGS_DEFAULT.mode
    };
  };

  const writeSettings = async (patch) => {
    const current = await readSettings();
    const nextMode = SYNC_MODES.has(patch?.mode) ? patch.mode : current.mode;
    try {
      await storage.set(STORAGE_KEY_SETTINGS, { mode: nextMode });
    } catch {
      // Storage failure must not break the settings panel toggle.
    }
    return { mode: nextMode };
  };

  const readStatus = async () => {
    let stored = null;
    try {
      stored = await storage.get(STORAGE_KEY_STATUS);
    } catch {
      stored = null;
    }
    if (!stored) {
      const legacy = readJsonQuietly(path.join(legacyRoot, 'lx-favorites-sync-status.json'));
      if (legacy && typeof legacy === 'object') {
        stored = legacy;
        try {
          await storage.set(STORAGE_KEY_STATUS, legacy);
        } catch {
          // Best-effort migration.
        }
        LEGACY_STATUS_FILE_NAMES.forEach((name) => removeFileQuietly(path.join(legacyRoot, name)));
      }
    }
    return stored && typeof stored === 'object' ? stored : { ok: null };
  };

  const writeStatus = async (payload) => {
    const status = {
      at: payload?.at || new Date().toISOString(),
      ok: payload?.ok !== false,
      mode: payload?.mode === 'merge' ? 'merge' : 'mirror',
      reason: String(payload?.reason || ''),
      sourceCount: Number(payload?.sourceCount) || 0,
      localSongCount: Number(payload?.localSongCount) || 0,
      matchedCount: Number(payload?.matchedCount) || 0,
      unmatchedCount: Number(payload?.unmatchedCount) || 0,
      previousCount: Number(payload?.previousCount) || 0,
      nextCount: Number(payload?.nextCount) || 0,
      addedCount: Number(payload?.addedCount) || 0,
      removedCount: Number(payload?.removedCount) || 0,
      changed: payload?.changed === true,
      downloadedMissingCount: Number(payload?.downloadedMissingCount) || 0,
      scanMaybeMissingCount: Number(payload?.scanMaybeMissingCount) || 0,
      unmatched: Array.isArray(payload?.unmatched) ? payload.unmatched.slice(0, 100) : [],
      sharedCount: Number(payload?.sharedCount) || 0,
      shared: Array.isArray(payload?.shared) ? payload.shared.slice(0, 100) : [],
      downloadRoots: Array.isArray(payload?.downloadRoots)
        ? payload.downloadRoots.slice(0, MAX_DOWNLOAD_ROOTS)
        : [],
      error: payload?.error ? String(payload.error) : ''
    };
    try {
      await storage.set(STORAGE_KEY_STATUS, status);
    } catch {
      // Status is informational; never fail the sync because of it.
    }
    return status;
  };

  api.rpc.handle('lx.read-favorites', async () => readLxFavorites());
  api.rpc.handle('lx.write-backup', async (payload) => saveBackup(payload));
  api.rpc.handle('lx.read-backup-list', async () => readBackupList());
  api.rpc.handle('lx.read-settings', readSettings);
  api.rpc.handle('lx.write-settings', writeSettings);
  api.rpc.handle('lx.read-status', readStatus);
  api.rpc.handle('lx.write-status', writeStatus);
  api.rpc.handle('lx.append-log', async (entry) => {
    appendLog(entry?.level || 'info', entry?.message || '', entry?.details);
    return true;
  });

  appendLog('info', 'Folia LX 收藏同步模组已加载');
};
