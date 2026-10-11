'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE_NAME = 'lx.data.db';
const LOG_FILE_NAME = 'lx-favorites-sync.log';
const BACKUP_DIR_NAME = 'lx-favorites-sync-backups';
const SETTINGS_FILE_NAME = 'lx-favorites-sync-settings.json';
const STATUS_FILE_NAME = 'lx-favorites-sync-status.json';
const STATUS_TEXT_FILE_NAME = 'lx-favorites-sync-status.txt';
const MAX_BACKUPS = 30;
const SETTINGS_DEFAULT = Object.freeze({ mode: 'merge' });
const SYNC_MODES = new Set(['mirror', 'merge']);

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

const appendLog = (level, message, details) => {
  const userData = getUserDataDirectory();
  const line = `${new Date().toISOString()} [${String(level).toUpperCase()}] ${message}${details === undefined ? '' : ` ${safeJson(details)}`}\n`;
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.appendFileSync(path.join(userData, LOG_FILE_NAME), line, 'utf8');
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
      select filePath
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
    if (normalized && !roots.some((root) => root.toLowerCase() === normalized.toLowerCase())) {
      roots.push(normalized);
    }
  };

  if (config.savePath) {
    addRoot(config.savePath);
  }
  downloadRows.forEach((row) => {
    const directory = path.dirname(String(row.filePath));
    addRoot(directory);
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

  const uri = `${pathToFileURL(databasePath).href}?mode=ro&immutable=1`;
  const immutableDatabase = new DatabaseSync(uri, { readOnly: true, uri: true });
  let immutableData = null;
  try {
    immutableData = queryLxData(immutableDatabase, databasePath);
  } finally {
    immutableDatabase.close();
  }
  if (immutableData && immutableData.items.length > 0) {
    return { databasePath, ...immutableData };
  }

  // LX may still be running and holding an uncheckpointed WAL. Work on a
  // disposable copy so the sync never writes to LX's live database.
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
  const baseDirectory = path.join(getUserDataDirectory(), BACKUP_DIR_NAME);
  fs.mkdirSync(baseDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(baseDirectory, `${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  pruneBackups(baseDirectory);
  return { file };
};

const readSettings = () => {
  const settingsPath = path.join(getUserDataDirectory(), SETTINGS_FILE_NAME);
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    stored = {};
  }
  return {
    ...SETTINGS_DEFAULT,
    mode: SYNC_MODES.has(stored?.mode) ? stored.mode : SETTINGS_DEFAULT.mode,
    settingsPath
  };
};

const writeSettings = (patch) => {
  const current = readSettings();
  const nextMode = SYNC_MODES.has(patch?.mode) ? patch.mode : current.mode;
  const settingsPath = path.join(getUserDataDirectory(), SETTINGS_FILE_NAME);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    mode: nextMode
  }, null, 2), 'utf8');
  return {
    mode: nextMode,
    settingsPath
  };
};

const writeStatus = (payload) => {
  const userData = getUserDataDirectory();
  fs.mkdirSync(userData, { recursive: true });
  const jsonPath = path.join(userData, STATUS_FILE_NAME);
  const textPath = path.join(userData, STATUS_TEXT_FILE_NAME);
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
    unmatched: Array.isArray(payload?.unmatched) ? payload.unmatched.slice(0, 100) : [],
    downloadRoots: Array.isArray(payload?.downloadRoots) ? payload.downloadRoots : [],
    importStatus: payload?.importStatus || null,
    error: payload?.error ? String(payload.error) : ''
  };
  fs.writeFileSync(jsonPath, JSON.stringify(status, null, 2), 'utf8');
  const lines = [
    'LX Music → Folia 收藏同步状态',
    '==============================',
    `更新时间：${status.at}`,
    `同步结果：${status.ok ? '成功' : '失败'}`,
    `同步模式：${status.mode === 'merge' ? '只增加' : '完全同步'}`,
    `触发方式：${status.reason || '-'}`,
    `LX 收藏数量：${status.sourceCount}`,
    `Folia 本地曲库数量：${status.localSongCount}`,
    `匹配数量：${status.matchedCount}`,
    `未匹配数量：${status.unmatchedCount}`,
    `同步前收藏数量：${status.previousCount}`,
    `同步后收藏数量：${status.nextCount}`,
    `本次新增：${status.addedCount}`,
    `本次移除：${status.removedCount}`,
    `收藏是否有变化：${status.changed ? '是' : '否'}`
  ];
  if (status.downloadRoots.length > 0) {
    lines.push('', '检测到的 LX 下载目录：');
    status.downloadRoots.forEach((root) => lines.push(`- ${root}`));
  }
  if (status.importStatus) {
    lines.push('', `下载目录扫描状态：${status.importStatus.status || '-'}`);
    if (status.importStatus.rootName) {
      lines.push(`授权目录名称：${status.importStatus.rootName}`);
    }
  }
  if (status.unmatched.length > 0) {
    lines.push('', '未匹配歌曲：');
    status.unmatched.forEach((item) => {
      lines.push(`- ${item.name}${item.singer ? ` - ${item.singer}` : ''}`);
    });
  }
  if (status.error) {
    lines.push('', `错误：${status.error}`);
  }
  fs.writeFileSync(textPath, lines.join('\r\n'), 'utf8');
  return { jsonPath, textPath };
};

const readStatus = () => {
  const statusPath = path.join(getUserDataDirectory(), STATUS_FILE_NAME);
  try {
    return {
      ...JSON.parse(fs.readFileSync(statusPath, 'utf8')),
      statusPath,
      textPath: path.join(getUserDataDirectory(), STATUS_TEXT_FILE_NAME)
    };
  } catch {
    return {
      ok: null,
      statusPath,
      textPath: path.join(getUserDataDirectory(), STATUS_TEXT_FILE_NAME)
    };
  }
};

const readLatestBackup = () => {
  const backupDirectory = path.join(getUserDataDirectory(), BACKUP_DIR_NAME);
  try {
    const file = fs.readdirSync(backupDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(backupDirectory, entry.name))
      .sort()
      .reverse()[0];
    return file ? { ...JSON.parse(fs.readFileSync(file, 'utf8')), file } : null;
  } catch {
    return null;
  }
};

module.exports = (api) => {
  api.rpc.handle('lx.read-favorites', async () => readLxFavorites());
  api.rpc.handle('lx.write-backup', async (payload) => saveBackup(payload));
  api.rpc.handle('lx.read-latest-backup', async () => readLatestBackup());
  api.rpc.handle('lx.read-settings', async () => readSettings());
  api.rpc.handle('lx.write-settings', async (patch) => writeSettings(patch));
  api.rpc.handle('lx.read-status', async () => readStatus());
  api.rpc.handle('lx.write-status', async (payload) => writeStatus(payload));
  api.rpc.handle('lx.append-log', async (entry) => {
    appendLog(entry?.level || 'info', entry?.message || '', entry?.details);
    return true;
  });

  appendLog('info', 'Folia LX 收藏同步模组已加载');
};
