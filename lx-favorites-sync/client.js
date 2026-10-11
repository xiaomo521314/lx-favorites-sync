const DB_NAME = 'KineticPlayerDB';
const LOCAL_MUSIC_STORE = 'local_music';
const CACHE_STORE = 'api_cache';
const LOCAL_PLAYLISTS_KEY = 'local_playlists';
const SYNC_STATE_KEY = 'lx-favorites-sync-state';
const MISSING_SNAPSHOT_KEY = 'lx-favorites-sync-missing';
const FAVORITE_NAME = 'Liked Songs';
const SYNC_COMMAND_ID = 'sync-lx-favorites';
const RESTORE_COMMAND_ID = 'restore-last-sync';
const OPEN_MISSING_COMMAND_ID = 'open-missing-songs';
const MISSING_PANEL_TAB_ID = 'local-missing';
const SYNC_MODE_MIRROR = 'mirror';
const SYNC_MODE_MERGE = 'merge';
const STARTUP_DELAY_MS = 4500;
const DB_WAIT_TIMEOUT_MS = 20000;
const MAX_CHANGE_DETAILS = 300;

// 同步模式（完全同步 / 只增加）现在由模组面板的「同步设置」分区维护；
// 用模块级变量保存，供模块级的 syncOnce 跨 activate 边界读取。
let currentSyncMode = SYNC_MODE_MERGE;
let syncModeReady = Promise.resolve();

// Folia 在 activate 时注入；供跨作用域的 storage 读写小工具使用。
let foliumRef = null;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const normalizeText = (value) => String(value == null ? '' : value)
  .normalize('NFKC')
  .toLowerCase()
  .replace(/\.(mp3|flac|m4a|wav|ogg|opus|aac|alac|ape|wv|tta|wma|aif|aiff|caf)$/gi, '')
  .replace(/\b(feat|ft|featuring)\b.*$/gi, '')
  .replace(/[\s\-_.·•・:：,，、/\\|&+;；'"“”‘’!！?？()（）[\]]/g, '')
  .trim();

const parseIntervalMs = (value) => {
  const match = /^(\d{1,3}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) {
    return 0;
  }
  return (Number(match[1]) * 60 + Number(match[2])) * 1000;
};

const valueOfName = (value) => {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object') {
    return String(value.name ?? value.title ?? '');
  }
  return String(value);
};

const artistText = (song) => {
  const imported = song?.importedMetadata || {};
  const online = song?.onlineMetadata || {};
  const importedArtists = Array.isArray(imported.artistNames)
    ? imported.artistNames
    : Array.isArray(imported.artists)
      ? imported.artists
      : [];
  const onlineArtists = Array.isArray(online.artists) ? online.artists : [];
  const names = onlineArtists.length > 0 ? onlineArtists.map(valueOfName) : importedArtists.map(valueOfName);
  return names.filter(Boolean).join(', ');
};

const albumText = (song) => {
  const imported = song?.importedMetadata || {};
  const online = song?.onlineMetadata || {};
  return String(
    online.album?.name
      ?? imported.albumName
      ?? ''
  );
};

const basenameWithoutExtension = (filePath) => {
  const value = String(filePath || '').replace(/\\/g, '/');
  const name = value.slice(value.lastIndexOf('/') + 1);
  return name.replace(/\.[^.]+$/, '');
};

const splitTitleArtist = (value) => {
  const parts = String(value || '').split(/\s+-\s+/);
  if (parts.length < 2) {
    return null;
  }
  return {
    title: parts.slice(0, -1).join(' - ').trim(),
    artist: parts[parts.length - 1].trim()
  };
};

const cleanSongTitleAndArtist = (title, fileName, artist) => {
  const fileBase = basenameWithoutExtension(fileName);
  let nextTitle = String(title || '').trim();
  let nextArtist = String(artist || '').trim();

  const fromFile = splitTitleArtist(fileBase);
  if (fromFile && (!nextArtist || nextTitle.includes(' - '))) {
    nextTitle = fromFile.title;
    nextArtist = fromFile.artist;
  } else if (!nextArtist) {
    const fromTitle = splitTitleArtist(nextTitle);
    if (fromTitle) {
      nextTitle = fromTitle.title;
      nextArtist = fromTitle.artist;
    }
  }

  return {
    title: nextTitle || fileBase,
    artist: nextArtist
  };
};

// 时长比较：LX 记录的是整秒（mm:ss），本地文件是精确时长。
// 文件秒数按“截断”或“四舍五入”换算后，LX 秒数必须与之完全相等。
// 例如 LX 04:06=246 秒，文件 246.7 秒（截断 = 246）算一致；246.7 不会算成 247。
const durationSecondsFloor = (durationMs) => {
  const value = Number(durationMs);
  return value > 0 ? Math.floor(value / 1000) : 0;
};

const durationSecondsRounded = (durationMs) => {
  const value = Number(durationMs);
  return value > 0 ? Math.round(value / 1000) : 0;
};

const fieldKey = (title, artist) => (
  `${normalizeText(title)}\u0000${normalizeText(artist)}`
);

const songRecord = (song) => {
  const fileName = song.fileName || basenameWithoutExtension(song.filePath || song.folderName || '');
  const metadataTitle = String(song.title || basenameWithoutExtension(fileName) || '').trim();
  const metadataArtist = artistText(song).trim();
  const parsedFromFile = splitTitleArtist(basenameWithoutExtension(fileName));
  const parsedFromTitle = splitTitleArtist(metadataTitle);
  const rawVariants = [
    { title: metadataTitle, artist: metadataArtist, source: 'metadata' },
    parsedFromFile ? { ...parsedFromFile, source: 'filename' } : null,
    parsedFromTitle ? { ...parsedFromTitle, source: 'title' } : null
  ].filter(Boolean);
  const variants = [];
  rawVariants.forEach((variant) => {
    const title = String(variant.title || '').trim();
    const artist = String(variant.artist || '').trim();
    const normalizedTitle = normalizeText(title);
    const normalizedArtist = normalizeText(artist);
    if (!normalizedTitle || !normalizedArtist) {
      return;
    }
    if (variants.some((item) => item.normalizedTitle === normalizedTitle && item.normalizedArtist === normalizedArtist)) {
      return;
    }
    variants.push({
      title,
      artist,
      normalizedTitle,
      normalizedArtist,
      source: variant.source
    });
  });

  const display = cleanSongTitleAndArtist(song.title, fileName, metadataArtist);
  return {
    id: String(song.id),
    title: String(display.title || metadataTitle || ''),
    artist: display.artist || metadataArtist,
    album: albumText(song),
    fileName: String(fileName || ''),
    path: String(song.filePath || song.folderName || ''),
    durationMs: Number(song.duration) || 0,
    durationSec: durationSecondsFloor(song.duration),
    durationSecRounded: durationSecondsRounded(song.duration),
    variants
  };
};

const lxRecord = (item) => {
  const title = String(item.name || '').trim();
  const artist = String(item.singer || '').trim();
  const durationMs = parseIntervalMs(item.interval);
  return {
    id: String(item.id || ''),
    title,
    artist,
    album: String(item.albumName || ''),
    durationMs,
    durationSec: durationSecondsFloor(durationMs)
  };
};

const buildSongIndex = (songs) => {
  const byFields = new Map();
  songs.forEach((song) => {
    song.variants.forEach((variant) => {
      const key = fieldKey(variant.title, variant.artist);
      const list = byFields.get(key) || [];
      list.push({ song, source: variant.source });
      byFields.set(key, list);
    });
  });
  return { byFields };
};

// 只有 LX 秒数等于候选文件的截断秒数或四舍五入秒数时才采用该文件；
// 歌名、歌手一致但时长对不上的文件一律不采用（宁可显示为缺失，也不乱配版本）。
const durationMatches = (song, lxItem) => {
  if (!lxItem.durationSec) {
    return true;
  }
  if (!song.durationMs) {
    return false;
  }
  return song.durationSec === lxItem.durationSec
    || song.durationSecRounded === lxItem.durationSec;
};

// 文件名提示用的宽松归一化：只做大小写/标点统一，不去版本后缀、不去 feat.，
// 目的是判断"磁盘上有这么个文件"，不用于严格匹配。
const normalizeFileHint = (value) => String(value == null ? '' : value)
  .normalize('NFKC')
  .toLowerCase()
  .replace(/\.(mp3|flac|m4a|wav|ogg|opus|aac|alac|ape|wv|tta|wma|aif|aiff|caf)$/gi, '')
  .replace(/[\s\-_.·•・:：,，、/\\|&+;；'"“”‘’!！?？()（）[\]]/g, '')
  .trim();

// 主进程给了两条线索：downloadIndex（LX 下载记录，精确到歌曲 id）和
// scannedFiles（LX 下载目录里实际存在的音频文件名，宽松探测）。
const buildMissingHints = (downloadInfo) => ({
  index: downloadInfo && typeof downloadInfo.downloadIndex === 'object' && !Array.isArray(downloadInfo.downloadIndex)
    ? downloadInfo.downloadIndex
    : {},
  files: Array.isArray(downloadInfo?.scannedFiles)
    ? downloadInfo.scannedFiles
      .map((name) => normalizeFileHint(name))
      .filter((name) => name.length >= 2)
    : []
});

// 'downloaded'：LX 有该曲的下载记录且文件还在 → 确定是"已下载但未被 Folia 收录"。
// 'scan-maybe'：下载目录里存在文件名同时包含歌名与任一歌手的文件 → 疑似。
const classifyMissing = (lxItem, hints) => {
  const entry = hints.index[lxItem.id];
  if (entry && entry.exists === true) {
    return 'downloaded';
  }
  if (hints.files.length === 0) {
    return '';
  }
  const title = normalizeFileHint(lxItem.title);
  if (!title || title.length < 2) {
    return '';
  }
  const artists = String(lxItem.artist || '')
    .split(/[,，、/&;；]+/)
    .map((part) => normalizeFileHint(part))
    .filter((part) => part.length >= 1);
  for (const file of hints.files) {
    if (!file.includes(title)) {
      continue;
    }
    if (artists.length === 0 || artists.some((artist) => file.includes(artist))) {
      return 'scan-maybe';
    }
  }
  return '';
};

const chooseCandidate = (lxItem, index) => {
  if (!lxItem.title || !lxItem.artist) {
    return null;
  }
  const matches = index.byFields.get(fieldKey(lxItem.title, lxItem.artist)) || [];
  if (matches.length === 0) {
    return null;
  }
  const priority = { metadata: 3, title: 2, filename: 1 };
  const scoreOf = (entry) => (
    (durationMatches(entry.song, lxItem) ? 100 : 0) + (priority[entry.source] || 0)
  );
  const best = [...matches].sort((left, right) => scoreOf(right) - scoreOf(left))[0];
  if (lxItem.durationSec && !durationMatches(best.song, lxItem)) {
    return null;
  }
  return best.song;
};

const matchFavorites = (favorites, songs, downloadInfo) => {
  const index = buildSongIndex(songs);
  const hints = buildMissingHints(downloadInfo);
  const matchedIds = [];
  const unmatched = [];
  const seenIds = new Set();

  favorites.forEach((favorite) => {
    const lxItem = lxRecord(favorite);
    const song = chooseCandidate(lxItem, index);
    if (!song) {
      const item = { id: lxItem.id, name: lxItem.title, singer: lxItem.artist };
      const hint = classifyMissing(lxItem, hints);
      if (hint) {
        item.hint = hint;
      }
      unmatched.push(item);
      return;
    }
    if (!seenIds.has(song.id)) {
      seenIds.add(song.id);
      matchedIds.push(song.id);
    }
  });

  return { matchedIds, unmatched };
};

const openDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('无法打开 Folia 数据库'));
  request.onblocked = () => reject(new Error('Folia 数据库正在被其他操作占用'));
});

const databaseExists = async () => {
  if (!indexedDB.databases) {
    return true;
  }
  const databases = await indexedDB.databases();
  return databases.some((database) => database.name === DB_NAME);
};

const waitForDatabase = async () => {
  const deadline = Date.now() + DB_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await databaseExists()) {
      return;
    }
    await sleep(300);
  }
  throw new Error('等待 Folia 本地数据库超时');
};

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('IndexedDB 操作失败'));
});

const readAll = async (database, storeName) => {
  const transaction = database.transaction(storeName, 'readonly');
  return requestResult(transaction.objectStore(storeName).getAll());
};

const readOne = async (database, storeName, key) => {
  const transaction = database.transaction(storeName, 'readonly');
  return requestResult(transaction.objectStore(storeName).get(key));
};

const putOne = async (database, storeName, value) => new Promise((resolve, reject) => {
  const transaction = database.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(value);
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 写入失败'));
  transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 写入已取消'));
});

const deleteOne = async (database, storeName, key) => new Promise((resolve, reject) => {
  const transaction = database.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).delete(key);
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 删除失败'));
  transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 删除已取消'));
});

const writeCachedData = async (database, key, data) => {
  await putOne(database, CACHE_STORE, {
    key,
    data,
    timestamp: Date.now()
  });
};

// 同步状态/缺失快照这类小数据存进 Folia 官方 storage（与主进程共享同一份
// mod-data.json）；旧版本存在 IndexedDB 里的键在首次读取时迁移一次。
const readPersistedState = async (key, database) => {
  const storage = foliumRef && foliumRef.storage ? foliumRef.storage : null;
  if (storage) {
    try {
      const value = await storage.get(key);
      if (value !== undefined) {
        return value;
      }
    } catch {
      // storage 不可用（老宿主/非主窗口）时回落到 IndexedDB。
    }
  }
  if (!database) {
    return undefined;
  }
  try {
    const record = await readOne(database, CACHE_STORE, key);
    if (record && record.data !== undefined) {
      try {
        if (storage) {
          await storage.set(key, record.data);
        }
        await deleteOne(database, CACHE_STORE, key);
      } catch {
        // 迁移失败就继续用旧数据，不影响本次读取。
      }
      return record.data;
    }
  } catch {
    // 读不到就按“没有数据”处理。
  }
  return undefined;
};

const writePersistedState = async (key, value, database) => {
  const storage = foliumRef && foliumRef.storage ? foliumRef.storage : null;
  if (storage) {
    try {
      await storage.set(key, value);
      return;
    } catch {
      // storage 不可用时回落到 IndexedDB，保证旧宿主仍能工作。
    }
  }
  if (database) {
    await writeCachedData(database, key, value);
  }
};

const isLightColor = (value) => {
  const color = String(value || '').trim();
  let red;
  let green;
  let blue;

  const shortHex = /^#([0-9a-f]{3})$/i.exec(color);
  const longHex = /^#([0-9a-f]{6})$/i.exec(color);
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color);
  if (shortHex) {
    const parts = shortHex[1].split('').map((part) => parseInt(part + part, 16));
    [red, green, blue] = parts;
  } else if (longHex) {
    red = parseInt(longHex[1].slice(0, 2), 16);
    green = parseInt(longHex[1].slice(2, 4), 16);
    blue = parseInt(longHex[1].slice(4, 6), 16);
  } else if (rgb) {
    red = Number(rgb[1]);
    green = Number(rgb[2]);
    blue = Number(rgb[3]);
  } else {
    return false;
  }

  return (red * 299 + green * 587 + blue * 114) / 1000 > 160;
};

const makeFavoriteRecord = (existing, songIds) => {
  const now = Date.now();
  if (existing) {
    return {
      ...existing,
      name: existing.name || FAVORITE_NAME,
      songIds,
      updatedAt: now,
      isFavorite: true
    };
  }
  return {
    id: `local_playlist_${now}_${Math.random().toString(36).slice(2, 10)}`,
    name: FAVORITE_NAME,
    songIds,
    createdAt: now,
    updatedAt: now,
    isFavorite: true
  };
};

// 「同步历史」的恢复入口：把收藏歌单的 songIds 还原为备份里的快照。
// 只动收藏歌单本身（其它歌单原地不动），歌单对象的 id/名称/创建时间等
// 元数据保持原样；只有收藏歌单完全不存在时才新建。
const restoreFavoriteFromBackup = async (folium, entry) => {
  const beforeIds = Array.isArray(entry?.before?.songIds) ? entry.before.songIds : null;
  if (!beforeIds) {
    throw new Error('这份备份里没有可用的收藏快照');
  }
  const database = await openDatabase();
  try {
    const record = await readOne(database, CACHE_STORE, LOCAL_PLAYLISTS_KEY);
    const playlists = Array.isArray(record?.data) ? record.data : [];
    const currentFavorite = playlists.find((playlist) => playlist && playlist.isFavorite) || null;
    const nextFavorite = makeFavoriteRecord(currentFavorite, beforeIds);
    const nextPlaylists = currentFavorite
      ? playlists.map((playlist) => (playlist === currentFavorite ? nextFavorite : playlist))
      : [nextFavorite, ...playlists];
    await putOne(database, CACHE_STORE, {
      key: LOCAL_PLAYLISTS_KEY,
      data: nextPlaylists,
      timestamp: Date.now()
    });
    window.dispatchEvent(new CustomEvent('folia-local-music-updated'));
    return beforeIds.length;
  } finally {
    database.close();
  }
};

const sameIds = (left, right) => Array.isArray(left)
  && Array.isArray(right)
  && left.length === right.length
  && left.every((value, index) => value === right[index]);

const dedupeIds = (ids) => {
  const seen = new Set();
  return ids.filter((id) => {
    if (!id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
};

const normalizeSyncMode = (mode) => mode === SYNC_MODE_MERGE ? SYNC_MODE_MERGE : SYNC_MODE_MIRROR;

const syncModeLabel = (mode) => normalizeSyncMode(mode) === SYNC_MODE_MERGE
  ? '只增加'
  : '完全同步';

// 容器挂在 open ShadowRoot 里：document 级监听器收到的 event.target 会被重定向到宿主节点，
// 判断“点击是否落在我们的控件里”必须通过 composedPath 检查。
const eventPathIncludes = (event, element) => {
  if (!element) {
    return false;
  }
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  return path.includes(element) || (event.target instanceof Node && element.contains(event.target));
};

// 状态文件写的是 UTC ISO 时间；界面里统一换算成本地时间显示。
const formatLocalTimestamp = (value) => {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

// 「同步设置」分区的自绘面板：宿主的 select 会弹出 Windows 系统配色的选项列表，
// 这里改用自己的下拉控件（颜色跟随主题），并顺带显示上次同步结果。
const mountSyncSettingsPanel = (folium, container, ctx) => {
  const isChinese = String(ctx?.locale || '').toLowerCase().startsWith('zh');
  const text = (zh, en) => isChinese ? zh : en;
  const theme = ctx?.getTheme?.() || {};
  const lightTheme = isLightColor(theme.backgroundColor);
  const hoverAlpha = lightTheme ? 10 : 20;
  const activeAlpha = lightTheme ? 8 : 12;

  const root = document.createElement('div');
  root.style.cssText = 'display:flex;flex-direction:column;gap:10px;color:var(--folium-primary,inherit);font-family:var(--folium-font,inherit);';
  container.replaceChildren(root);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:10px;font-size:13px;';
  const label = document.createElement('span');
  label.textContent = text('同步模式', 'Sync mode');
  label.style.cssText = 'min-width:64px;opacity:.85;';

  const options = [
    { value: SYNC_MODE_MERGE, label: text('只增加（推荐）', 'Add only (recommended)') },
    { value: SYNC_MODE_MIRROR, label: text('完全同步', 'Full mirror') }
  ];
  const findOption = (value) => (
    options.find((option) => option.value === normalizeSyncMode(value)) || options[0]
  );

  const picker = document.createElement('div');
  picker.style.cssText = 'position:relative;display:inline-flex;';
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.style.cssText = 'display:inline-flex;align-items:center;gap:6px;border:1px solid color-mix(in srgb, currentColor 40%, transparent);border-radius:8px;padding:4px 10px;background:color-mix(in srgb, currentColor 5%, transparent);color:inherit;font:inherit;font-size:13px;line-height:1.4;cursor:pointer;';

  let menuOpen = false;
  let menuElement = null;
  const paintButton = () => {
    button.textContent = `${findOption(ctx.params.get().mode).label} ▾`;
    button.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
  };
  const closeMenu = () => {
    menuOpen = false;
    if (menuElement && menuElement.isConnected) {
      menuElement.remove();
    }
    menuElement = null;
    paintButton();
  };
  const openMenu = () => {
    menuOpen = true;
    const menu = document.createElement('div');
    menu.setAttribute('role', 'listbox');
    menu.style.cssText = 'position:absolute;top:calc(100% + 5px);left:0;min-width:100%;z-index:1000;display:flex;flex-direction:column;gap:2px;padding:4px;border-radius:9px;box-sizing:border-box;white-space:nowrap;background:var(--folium-bg,#1b1b1f);border:1px solid color-mix(in srgb, currentColor 28%, transparent);box-shadow:0 8px 22px rgba(0,0,0,0.3);';
    options.forEach((option) => {
      const isActive = option.value === normalizeSyncMode(ctx.params.get().mode);
      const item = document.createElement('div');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', isActive ? 'true' : 'false');
      item.textContent = option.label;
      const baseBackground = isActive ? `color-mix(in srgb, currentColor ${activeAlpha}%, transparent)` : 'transparent';
      item.style.cssText = `padding:5px 10px;border-radius:6px;font-size:13px;line-height:1.5;cursor:pointer;user-select:none;${isActive ? 'font-weight:600;' : ''}`;
      item.style.backgroundColor = baseBackground;
      item.addEventListener('mouseenter', () => {
        item.style.backgroundColor = `color-mix(in srgb, currentColor ${hoverAlpha}%, transparent)`;
      });
      item.addEventListener('mouseleave', () => {
        item.style.backgroundColor = baseBackground;
      });
      item.addEventListener('click', () => {
        try {
          ctx.params.set({ mode: option.value });
        } catch (error) {
          folium.log.warn('切换同步模式失败', error);
        }
        closeMenu();
      });
      menu.append(item);
    });
    picker.append(menu);
    menuElement = menu;
    paintButton();
  };
  button.addEventListener('click', () => {
    if (menuOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  });
  picker.append(button);
  row.append(label, picker);

  const hint = document.createElement('div');
  hint.textContent = text(
    '只增加：只追加收藏，从不删除；完全同步：与 LX 保持一致（会移除 LX 里没有的收藏）。更改立即保存，不会自动同步。',
    'Add only: append, never remove. Full mirror: match LX exactly (removes favorites missing from LX). Changes save immediately without syncing.'
  );
  hint.style.cssText = 'font-size:12px;line-height:1.55;opacity:.62;';

  const statusLine = document.createElement('div');
  statusLine.style.cssText = 'font-size:12px;line-height:1.5;opacity:.78;';
  const refreshStatus = () => {
    if (folium.env.context !== 'main') {
      statusLine.remove();
      return;
    }
    folium.rpc.call('lx.read-status').then((status) => {
      if (!status || status.ok === null || status.ok === undefined) {
        statusLine.textContent = text('还没有同步记录；点进度条旁的按钮可以立即同步。', 'No sync yet; use the button next to the progress bar.');
        return;
      }
      const time = formatLocalTimestamp(status.at);
      statusLine.textContent = text(
        `上次同步：${status.ok ? '成功' : '失败'} · 匹配 ${status.matchedCount || 0}/${status.sourceCount || 0} · 缺失 ${status.unmatchedCount || 0}${time ? ` · ${time}` : ''}`,
        `Last sync: ${status.ok ? 'ok' : 'failed'} · matched ${status.matchedCount || 0}/${status.sourceCount || 0} · missing ${status.unmatchedCount || 0}${time ? ` · ${time}` : ''}`
      );
    }).catch(() => undefined);
  };
  refreshStatus();

  const onDocumentPointerDown = (event) => {
    if (menuOpen && !eventPathIncludes(event, picker)) {
      closeMenu();
    }
  };
  const onDocumentKeyDown = (event) => {
    if (event.key === 'Escape') {
      closeMenu();
    }
  };
  const onSyncFinished = () => refreshStatus();
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeyDown);
  window.addEventListener('lx-favorites-sync-finished', onSyncFinished);
  const offParams = typeof ctx?.params?.subscribe === 'function'
    ? ctx.params.subscribe(() => paintButton())
    : () => undefined;
  paintButton();

  // —— 同步历史（折叠区）：列出每次真实变化，可任选一条回退 ——
  const historyWrap = document.createElement('div');
  historyWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;border-top:1px solid color-mix(in srgb, currentColor 14%, transparent);padding-top:10px;';

  const historyHeader = document.createElement('button');
  historyHeader.type = 'button';
  historyHeader.style.cssText = 'display:flex;align-items:center;gap:6px;border:0;padding:2px 0;background:none;color:inherit;font:inherit;font-size:13px;cursor:pointer;text-align:left;';

  const historyBody = document.createElement('div');
  historyBody.style.cssText = 'display:none;flex-direction:column;gap:6px;max-height:250px;overflow:auto;padding-right:2px;';

  let historyOpen = false;
  let historyEntries = null;
  let historyError = '';

  const reasonLabel = (reason) => (
    reason === 'startup' ? text('启动自动', 'Startup') : text('手动', 'Manual')
  );
  const modeLabelOf = (mode) => (
    normalizeSyncMode(mode) === SYNC_MODE_MERGE ? text('只增加', 'Add only') : text('完全同步', 'Mirror')
  );
  const songLabel = (song) => `${song.title || song.id || '?'}${song.artist ? ` - ${song.artist}` : ''}`;

  const makeSmallButton = (label) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.style.cssText = 'border:1px solid color-mix(in srgb, currentColor 45%, transparent);border-radius:7px;padding:3px 9px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px;line-height:1.3;flex:none;';
    return element;
  };

  const renderHistory = () => {
    historyHeader.textContent = historyOpen
      ? text('同步历史 ▾', 'Sync history ▾')
      : text('同步历史 ▸', 'Sync history ▸');
    historyBody.style.display = historyOpen ? 'flex' : 'none';
    historyBody.replaceChildren();
    if (!historyOpen) {
      return;
    }
    if (historyError) {
      const errorLine = document.createElement('div');
      errorLine.textContent = text(`读取历史失败：${historyError}`, `Failed to load history: ${historyError}`);
      errorLine.style.cssText = 'font-size:12px;opacity:.8;';
      historyBody.append(errorLine);
      return;
    }
    if (!historyEntries || historyEntries.length === 0) {
      const emptyLine = document.createElement('div');
      emptyLine.textContent = text('还没有同步历史；收藏发生变化时会自动记录。', 'No history yet; records appear when favorites change.');
      emptyLine.style.cssText = 'font-size:12px;opacity:.7;';
      historyBody.append(emptyLine);
      return;
    }

    historyEntries.forEach((entry) => {
      const counts = entry.counts || { added: 0, removed: 0 };
      const timeText = formatLocalTimestamp(entry.at) || entry.at;
      const card = document.createElement('div');
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;border-radius:9px;padding:8px 10px;background:color-mix(in srgb, currentColor 6%, transparent);';

      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:10px;font-size:12px;line-height:1.4;';

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;cursor:pointer;user-select:none;';
      const headLine = document.createElement('span');
      headLine.textContent = `${timeText} · ${reasonLabel(entry.reason)} · ${modeLabelOf(entry.mode)}`;
      headLine.style.cssText = 'opacity:.9;';
      const delta = document.createElement('span');
      delta.textContent = `+${counts.added || 0} / -${counts.removed || 0}`;
      delta.style.cssText = 'font-weight:600;opacity:.95;';
      const toggleHint = document.createElement('span');
      toggleHint.textContent = '▸';
      toggleHint.style.cssText = 'opacity:.55;';
      info.append(headLine, delta, toggleHint);

      const details = document.createElement('div');
      details.style.cssText = 'display:none;flex-direction:column;gap:3px;font-size:12px;line-height:1.5;opacity:.85;';
      const fillDetails = () => {
        if (details.childElementCount > 0) {
          return;
        }
        const changes = entry.changes;
        const added = Array.isArray(changes?.added) ? changes.added : [];
        const removed = Array.isArray(changes?.removed) ? changes.removed : [];
        if (added.length === 0 && removed.length === 0) {
          const line = document.createElement('div');
          line.textContent = text('（这份备份来自旧版本，没有明细记录）', '(Older backup: no details recorded.)');
          line.style.opacity = '.65';
          details.append(line);
          return;
        }
        if (added.length > 0) {
          const line = document.createElement('div');
          line.textContent = `${text('新增', 'Added')}（${counts.added ?? added.length}）：${added.map(songLabel).join('、')}${changes.addedTruncated ? text(' 等', ' …') : ''}`;
          details.append(line);
        }
        if (removed.length > 0) {
          const line = document.createElement('div');
          line.textContent = `${text('移除', 'Removed')}（${counts.removed ?? removed.length}）：${removed.map(songLabel).join('、')}${changes.removedTruncated ? text(' 等', ' …') : ''}`;
          details.append(line);
        }
      };
      info.addEventListener('click', () => {
        const visible = details.style.display !== 'none';
        if (!visible) {
          fillDetails();
        }
        details.style.display = visible ? 'none' : 'flex';
        toggleHint.textContent = visible ? '▸' : '▾';
      });

      const restoreButton = makeSmallButton(text('回退', 'Restore'));
      let armed = false;
      let armTimer = null;
      const resetArm = () => {
        armed = false;
        if (armTimer !== null) {
          window.clearTimeout(armTimer);
          armTimer = null;
        }
        restoreButton.textContent = text('回退', 'Restore');
        restoreButton.style.fontWeight = '500';
      };
      restoreButton.addEventListener('click', () => {
        if (restoreButton.disabled) {
          return;
        }
        if (!armed) {
          armed = true;
          restoreButton.textContent = text('确认回退?', 'Confirm?');
          restoreButton.style.fontWeight = '700';
          armTimer = window.setTimeout(resetArm, 4000);
          return;
        }
        resetArm();
        restoreButton.disabled = true;
        restoreButton.style.opacity = '0.55';
        void (async () => {
          try {
            const restoredCount = await restoreFavoriteFromBackup(folium, entry);
            folium.ui.toast(
              text(`已回退到 ${timeText} 的状态（收藏 ${restoredCount} 首）`, `Restored to ${timeText} (${restoredCount} favorites).`),
              { type: 'success', durationMs: 9000 }
            );
            await folium.rpc.call('lx.append-log', {
              level: 'info',
              message: '已按同步历史回退收藏',
              details: { file: entry.file, restoredCount, at: entry.at }
            }).catch(() => undefined);
            refreshStatus();
          } catch (error) {
            folium.ui.toast(
              text(`回退失败：${error.message}`, `Restore failed: ${error.message}`),
              { type: 'error', durationMs: 9000 }
            );
          } finally {
            restoreButton.disabled = false;
            restoreButton.style.opacity = '1';
          }
        })();
      });

      head.append(info, restoreButton);
      card.append(head, details);
      historyBody.append(card);
    });
  };

  const loadHistory = async () => {
    try {
      const list = await folium.rpc.call('lx.read-backup-list');
      historyEntries = Array.isArray(list) ? list : [];
      historyError = '';
    } catch (error) {
      historyEntries = [];
      historyError = error.message;
    }
    renderHistory();
  };

  historyHeader.addEventListener('click', () => {
    historyOpen = !historyOpen;
    if (historyOpen && historyEntries === null) {
      historyHeader.textContent = text('同步历史 ▾', 'Sync history ▾');
      historyBody.style.display = 'flex';
      historyBody.replaceChildren();
      const loadingLine = document.createElement('div');
      loadingLine.textContent = text('加载中…', 'Loading…');
      loadingLine.style.cssText = 'font-size:12px;opacity:.7;';
      historyBody.append(loadingLine);
      void loadHistory();
      return;
    }
    renderHistory();
  });
  renderHistory();
  historyWrap.append(historyHeader, historyBody);

  root.append(row, hint, historyWrap, statusLine);

  return () => {
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onDocumentKeyDown);
    window.removeEventListener('lx-favorites-sync-finished', onSyncFinished);
    offParams();
    closeMenu();
  };
};

const countMissingHints = (unmatched) => {
  let downloaded = 0;
  let maybe = 0;
  unmatched.forEach((item) => {
    if (item?.hint === 'downloaded') {
      downloaded += 1;
    } else if (item?.hint === 'scan-maybe') {
      maybe += 1;
    }
  });
  return { downloaded, maybe };
};

const syncOnce = async (folium, reason) => {
  await syncModeReady.catch(() => undefined);
  await waitForDatabase();
  const database = await openDatabase();
  try {
    const favoriteResponse = await folium.rpc.call('lx.read-favorites');

    const [localSongs, cacheRecord] = await Promise.all([
      readAll(database, LOCAL_MUSIC_STORE),
      readOne(database, CACHE_STORE, LOCAL_PLAYLISTS_KEY)
    ]);

    const favorites = Array.isArray(favoriteResponse?.items) ? favoriteResponse.items : [];
    if (favorites.length === 0) {
      throw new Error('LX Music 的“我喜欢”列表为空，已停止同步以避免清空 Folia 收藏');
    }
    if (!Array.isArray(localSongs) || localSongs.length === 0) {
      throw new Error('Folia 本地曲库为空，请先导入本地音乐后再同步');
    }

    const songs = localSongs.map(songRecord);
    const { matchedIds, unmatched } = matchFavorites(favorites, songs, favoriteResponse);
    if (matchedIds.length === 0) {
      throw new Error('LX 收藏没有匹配到 Folia 本地曲库，已停止同步');
    }

    const syncMode = normalizeSyncMode(currentSyncMode);
    const previousState = await readPersistedState(SYNC_STATE_KEY, database);
    const lastMatchedCount = Number(previousState?.lastMatchedCount) || 0;
    if (
      syncMode === SYNC_MODE_MIRROR
      && reason === 'startup'
      && lastMatchedCount >= 60
      && matchedIds.length < lastMatchedCount * 0.6
    ) {
      throw new Error(`匹配结果异常下降（上次 ${lastMatchedCount} 首、本次 ${matchedIds.length} 首），已中止自动完全同步以免误删收藏；如确认无误，请手动执行“同步 LX Music 收藏”。`);
    }
    const playlists = Array.isArray(cacheRecord?.data) ? cacheRecord.data : [];
    const currentFavorite = playlists.find((playlist) => playlist && playlist.isFavorite) || null;
    const previousIds = Array.isArray(currentFavorite?.songIds) ? currentFavorite.songIds : [];
    const nextIds = syncMode === SYNC_MODE_MERGE
      ? dedupeIds([...previousIds, ...matchedIds])
      : matchedIds;
    const nextFavorite = makeFavoriteRecord(currentFavorite, nextIds);
    const nextPlaylists = currentFavorite
      ? playlists.map((playlist) => playlist === currentFavorite ? nextFavorite : playlist)
      : [nextFavorite, ...playlists];

    if (!sameIds(previousIds, nextIds)) {
      await putOne(database, CACHE_STORE, {
        key: LOCAL_PLAYLISTS_KEY,
        data: nextPlaylists,
        timestamp: Date.now()
      });
      window.dispatchEvent(new CustomEvent('folia-local-music-updated'));
    }

    const beforeSet = new Set(previousIds);
    const afterSet = new Set(nextIds);
    const addedIds = nextIds.filter((id) => !beforeSet.has(id));
    const removedIds = previousIds.filter((id) => !afterSet.has(id));
    const hintCounts = countMissingHints(unmatched);
    const summary = {
      reason,
      mode: syncMode,
      sourceCount: favorites.length,
      localSongCount: localSongs.length,
      matchedCount: matchedIds.length,
      unmatchedCount: unmatched.length,
      previousCount: previousIds.length,
      nextCount: nextIds.length,
      addedCount: addedIds.length,
      removedCount: removedIds.length,
      changed: !sameIds(previousIds, nextIds),
      downloadedMissingCount: hintCounts.downloaded,
      scanMaybeMissingCount: hintCounts.maybe,
      unmatched: unmatched.slice(0, 30),
      databasePath: favoriteResponse?.databasePath || '',
      downloadRoots: Array.isArray(favoriteResponse?.downloadRoots) ? favoriteResponse.downloadRoots : []
    };

    // 备份只在收藏真的发生变化时写（记录变化前的状态），保证
    // 「回退到某次变化前」始终可用；没有变化的同步不会刷掉旧备份。
    if (summary.changed) {
      const songById = new Map(songs.map((song) => [song.id, song]));
      const detailsOf = (ids) => ids.slice(0, MAX_CHANGE_DETAILS).map((id) => {
        const song = songById.get(id);
        return {
          id,
          title: song ? song.title : '',
          artist: song ? song.artist : ''
        };
      });
      await folium.rpc.call('lx.write-backup', {
        at: new Date().toISOString(),
        reason,
        mode: syncMode,
        counts: {
          added: addedIds.length,
          removed: removedIds.length,
          previous: previousIds.length,
          next: nextIds.length,
          source: favorites.length,
          matched: matchedIds.length,
          unmatched: unmatched.length
        },
        before: { songIds: previousIds },
        changes: {
          added: detailsOf(addedIds),
          removed: detailsOf(removedIds),
          addedTruncated: addedIds.length > MAX_CHANGE_DETAILS,
          removedTruncated: removedIds.length > MAX_CHANGE_DETAILS
        }
      });
    }
    await writePersistedState(MISSING_SNAPSHOT_KEY, {
      at: new Date().toISOString(),
      mode: syncMode,
      sourceCount: favorites.length,
      matchedCount: matchedIds.length,
      items: unmatched
    }, database);
    await writePersistedState(SYNC_STATE_KEY, {
      lastMatchedCount: matchedIds.length,
      lastSyncAt: Date.now()
    }, database);
    window.dispatchEvent(new CustomEvent('lx-favorites-sync-updated'));
    await folium.rpc.call('lx.append-log', {
      level: 'info',
      message: 'LX 收藏同步完成',
      details: summary
    });

    return summary;
  } finally {
    database.close();
  }
};

const mountMissingPanel = (container, ctx) => {
  let disposed = false;
  let sortMode = 'title';
  let sortMenuOpen = false;
  let sortMenuElement = null;
  let sortPickerElement = null;
  let syncState = 'idle';
  let feedback = '';
  const isChinese = String(ctx?.locale || '').toLowerCase().startsWith('zh');
  const text = (zh, en) => isChinese ? zh : en;
  const collator = new Intl.Collator(['zh-CN', 'en'], { numeric: true, sensitivity: 'base' });
  const root = document.createElement('div');
  root.style.cssText = 'display:flex;flex-direction:column;gap:12px;width:100%;box-sizing:border-box;padding:14px;';
  container.replaceChildren(root);

  const makeButton = (label, handler) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = 'border:1px solid currentColor;border-radius:7px;padding:4px 8px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px;line-height:1.2;font-weight:500;';
    button.addEventListener('click', handler);
    return button;
  };

  const closeSortMenu = () => {
    if (!sortMenuOpen) {
      return;
    }
    sortMenuOpen = false;
    if (sortMenuElement && sortMenuElement.isConnected) {
      sortMenuElement.remove();
    }
    sortMenuElement = null;
  };

  const render = async () => {
    if (disposed) {
      return;
    }
    const theme = ctx?.getTheme?.() || {};
    root.style.color = theme.primaryColor || '#e8e8ec';
    root.style.colorScheme = isLightColor(theme.backgroundColor) ? 'light' : 'dark';

    let snapshot = null;
    let error = null;
    try {
      const database = await openDatabase();
      try {
        snapshot = await readPersistedState(MISSING_SNAPSHOT_KEY, database);
      } finally {
        database.close();
      }
    } catch (renderError) {
      error = renderError;
    }
    if (disposed) {
      return;
    }

    root.replaceChildren();
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;';
    const title = document.createElement('div');
    title.textContent = text('本地缺失歌曲', 'Missing Local Songs');
    title.style.cssText = 'font-size:15px;font-weight:600;';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;';
    const syncButton = makeButton(
      syncState === 'syncing' ? text('同步中…', 'Syncing…') : text('重新同步', 'Sync now'),
      () => {
        if (syncState === 'syncing') {
          return;
        }
        syncState = 'syncing';
        safeRender();
        window.dispatchEvent(new CustomEvent('lx-favorites-sync-request'));
      }
    );
    if (syncState === 'syncing') {
      syncButton.disabled = true;
      syncButton.style.opacity = '0.55';
      syncButton.style.cursor = 'default';
    }
    actions.append(syncButton);
    header.append(title, actions);
    root.append(header);

    if (error) {
      const message = document.createElement('div');
      message.textContent = `${text('读取失败', 'Failed to read')}：${error.message}`;
      message.style.cssText = 'font-size:13px;opacity:.8;';
      root.append(message);
      return;
    }

    if (!snapshot) {
      const empty = document.createElement('div');
      empty.textContent = text('还没有同步结果，请先执行一次同步。', 'No sync result yet. Run a sync first.');
      empty.style.cssText = 'font-size:13px;opacity:.75;';
      root.append(empty);
      return;
    }

    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    const summary = document.createElement('div');
    summary.textContent = text(
      items.length === 0
        ? `LX 收藏 ${snapshot.sourceCount || 0} 首，匹配 ${snapshot.matchedCount || 0} 首，没有缺失喵~`
        : `LX 收藏 ${snapshot.sourceCount || 0} 首，匹配 ${snapshot.matchedCount || 0} 首，缺失 ${items.length} 首喵~`,
      items.length === 0
        ? `LX favorites ${snapshot.sourceCount || 0}, matched ${snapshot.matchedCount || 0}, no missing songs.`
        : `LX favorites ${snapshot.sourceCount || 0}, matched ${snapshot.matchedCount || 0}, missing ${items.length}.`
    );
    summary.style.cssText = 'font-size:12px;opacity:.72;';
    root.append(summary);

    const downloadedCount = items.filter((item) => item?.hint === 'downloaded').length;
    const maybeCount = items.filter((item) => item?.hint === 'scan-maybe').length;
    if (downloadedCount > 0 || maybeCount > 0) {
      const hintLine = document.createElement('div');
      hintLine.style.cssText = 'font-size:12px;line-height:1.6;opacity:.88;padding:8px 10px;border-radius:8px;background:color-mix(in srgb, currentColor 8%, transparent);';
      const parts = [];
      if (downloadedCount > 0) {
        parts.push(text(`${downloadedCount} 首已下载但未被 Folia 收录`, `${downloadedCount} downloaded but not scanned by Folia`));
      }
      if (maybeCount > 0) {
        parts.push(text(`${maybeCount} 首疑似就在下载目录中`, `${maybeCount} maybe present in the download folder`));
      }
      hintLine.textContent = `${parts.join('；')}——${text('请在「本地音乐」里重新扫描对应目录，或在设置里开启「自动扫描本地文件夹」。', 'Rescan the folder from Local Music, or enable "Auto scan local folders" in settings.')}`;
      root.append(hintLine);
    }
    if (feedback) {
      const feedbackLine = document.createElement('div');
      feedbackLine.textContent = feedback;
      feedbackLine.style.cssText = 'font-size:12px;line-height:1.45;opacity:.9;';
      root.append(feedbackLine);
    }

    if (items.length === 0) {
      // 没有缺失时不需要“本地缺失歌曲”这个标题（标签页名已经说明了），
      // 只留下按钮和上面的汇总行。
      title.remove();
      return;
    }

    const sortRow = document.createElement('div');
    sortRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;';
    const sortLabel = document.createElement('span');
    sortLabel.textContent = text('排序：', 'Sort:');
    sortLabel.style.opacity = '.82';

    // 原生 <select> 的下拉高亮色由系统决定（Windows 上是固定蓝色），无法跟随主题。
    // 这里改用自绘下拉：悬浮和选中背景都用 currentColor 混色，深浅主题自动匹配。
    const sortOptions = [
      { value: 'title', label: text('歌名', 'Title') },
      { value: 'artist', label: text('歌手', 'Artist') },
      { value: 'lx', label: text('LX 原顺序', 'LX order') }
    ];
    const currentSort = sortOptions.find((optionData) => optionData.value === sortMode) || sortOptions[0];
    const sortPicker = document.createElement('div');
    sortPicker.style.cssText = 'position:relative;display:inline-flex;';
    sortPickerElement = sortPicker;

    const sortButton = makeButton(`${currentSort.label} ▾`, () => {
      sortMenuOpen = !sortMenuOpen;
      safeRender();
    });
    sortButton.setAttribute('aria-haspopup', 'listbox');
    sortButton.setAttribute('aria-expanded', sortMenuOpen ? 'true' : 'false');
    sortButton.style.opacity = '0.82';
    sortPicker.append(sortButton);

    sortMenuElement = null;
    if (sortMenuOpen) {
      const menu = document.createElement('div');
      menu.setAttribute('role', 'listbox');
      menu.style.cssText = 'position:absolute;top:calc(100% + 6px);left:0;min-width:100%;z-index:1000;display:flex;flex-direction:column;gap:2px;padding:4px;border-radius:8px;box-sizing:border-box;white-space:nowrap;';
      menu.style.backgroundColor = theme.backgroundColor || (isLightColor(theme.backgroundColor) ? '#ffffff' : '#1b1b1f');
      menu.style.color = theme.primaryColor || '#e8e8ec';
      menu.style.border = `1px solid ${theme.secondaryColor || 'color-mix(in srgb, currentColor 30%, transparent)'}`;
      menu.style.boxShadow = '0 8px 20px rgba(0,0,0,0.28)';
      // 浅色主题下高亮要更淡；深色主题保持原有浓度
      const lightTheme = isLightColor(theme.backgroundColor);
      const hoverAlpha = lightTheme ? 10 : 20;
      const activeAlpha = lightTheme ? 8 : 12;
      sortOptions.forEach((optionData) => {
        const isActive = optionData.value === sortMode;
        const optionRow = document.createElement('div');
        optionRow.textContent = optionData.label;
        optionRow.setAttribute('role', 'option');
        optionRow.setAttribute('aria-selected', isActive ? 'true' : 'false');
        const baseBackground = isActive ? `color-mix(in srgb, currentColor ${activeAlpha}%, transparent)` : 'transparent';
        optionRow.style.cssText = `padding:4px 10px;border-radius:6px;font-size:12px;line-height:1.5;cursor:pointer;user-select:none;${isActive ? 'font-weight:600;' : ''}`;
        optionRow.style.backgroundColor = baseBackground;
        optionRow.addEventListener('mouseenter', () => {
          optionRow.style.backgroundColor = `color-mix(in srgb, currentColor ${hoverAlpha}%, transparent)`;
        });
        optionRow.addEventListener('mouseleave', () => {
          optionRow.style.backgroundColor = baseBackground;
        });
        optionRow.addEventListener('click', () => {
          sortMode = optionData.value;
          sortMenuOpen = false;
          safeRender();
        });
        menu.append(optionRow);
      });
      sortPicker.append(menu);
      sortMenuElement = menu;
    }

    sortRow.append(sortLabel, sortPicker);
    root.append(sortRow);

    const sortedItems = [...items];
    if (sortMode === 'title') {
      sortedItems.sort((left, right) => (
        collator.compare(left.name || '', right.name || '')
        || collator.compare(left.singer || '', right.singer || '')
      ));
    } else if (sortMode === 'artist') {
      sortedItems.sort((left, right) => (
        collator.compare(left.singer || '', right.singer || '')
        || collator.compare(left.name || '', right.name || '')
      ));
    }

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:55vh;overflow:auto;padding-right:4px;';
    sortedItems.forEach((item, index) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:baseline;gap:8px;font-size:13px;line-height:1.45;padding:6px 8px;border-radius:8px;background:color-mix(in srgb, currentColor 8%, transparent);';
      const name = document.createElement('span');
      name.style.cssText = 'flex:1;min-width:0;';
      name.textContent = `${index + 1}. ${item.name || ''}${item.singer ? ` - ${item.singer}` : ''}`;
      row.append(name);
      if (item.hint === 'downloaded' || item.hint === 'scan-maybe') {
        const badge = document.createElement('span');
        badge.textContent = item.hint === 'downloaded'
          ? text('已下载未收录', 'Not scanned yet')
          : text('疑似在下载目录', 'Maybe in folder');
        badge.style.cssText = 'flex:none;font-size:11px;line-height:1.3;padding:2px 7px;border-radius:999px;background:color-mix(in srgb, currentColor 16%, transparent);opacity:.9;';
        row.append(badge);
      }
      list.append(row);
    });
    root.append(list);
  };

  const safeRender = () => {
    void render().catch((error) => {
      if (disposed) {
        return;
      }
      root.replaceChildren();
      const message = document.createElement('div');
      message.textContent = `${text('加载失败', 'Failed to load')}：${error.message}`;
      message.style.cssText = 'font-size:13px;opacity:.8;';
      root.append(message);
    });
  };

  const onUpdated = () => safeRender();
  const onFinished = (event) => {
    const detail = event.detail || {};
    // 成功时不再单独显示一行反馈（汇总行会自行刷新，仍有 toast 提示）；
    // 只有失败时才把错误留在面板上。
    feedback = detail.ok
      ? ''
      : text(
        `同步失败：${detail.error || '未知错误'}`,
        `Sync failed: ${detail.error || 'unknown error'}`
      );
    syncState = 'idle';
    safeRender();
  };
  window.addEventListener('lx-favorites-sync-updated', onUpdated);
  window.addEventListener('lx-favorites-sync-finished', onFinished);
  const onDocumentPointerDown = (event) => {
    if (sortMenuOpen && !eventPathIncludes(event, sortPickerElement)) {
      closeSortMenu();
    }
  };
  const onDocumentKeyDown = (event) => {
    if (event.key === 'Escape') {
      closeSortMenu();
    }
  };
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeyDown);
  const unsubscribe = ctx?.subscribe?.(() => safeRender());
  safeRender();

  return () => {
    disposed = true;
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onDocumentKeyDown);
    window.removeEventListener('lx-favorites-sync-updated', onUpdated);
    window.removeEventListener('lx-favorites-sync-finished', onFinished);
    unsubscribe?.();
  };
};

export default function activate(folium) {
  foliumRef = folium;
  let disposed = false;
  let activeSync = null;
  let startupTimer = null;
  let command = null;
  let modeSection = null;
  let restoreCommand = null;
  let openMissingCommand = null;
  let controlButton = null;
  let panelTab = null;
  let missingRequestHandler = null;

  missingRequestHandler = () => {
    void run('manual', { force: true });
  };
  window.addEventListener('lx-favorites-sync-request', missingRequestHandler);

  const run = async (reason, options = {}) => {
    if (disposed) {
      return null;
    }
    if (activeSync) {
      if (!options.force) {
        return activeSync;
      }
      try {
        await activeSync;
      } catch {
        // A failed startup sync must not block a user-triggered directory import.
      }
    }

    activeSync = (async () => {
      try {
        const summary = await syncOnce(folium, reason);
        const text = summary.changed
          ? `【${syncModeLabel(summary.mode)}】LX 收藏已同步：匹配 ${summary.matchedCount}/${summary.sourceCount} 首`
          : `【${syncModeLabel(summary.mode)}】LX 收藏已检查：${summary.matchedCount}/${summary.sourceCount} 首，无需改动`;
        folium.ui.toast(text, { type: summary.unmatchedCount > 0 ? 'info' : 'success', durationMs: 6000 });
        if (summary.downloadedMissingCount > 0) {
          folium.ui.toast(
            `有 ${summary.downloadedMissingCount} 首已下载的歌曲未被 Folia 收录：请在「本地音乐」里重新扫描对应目录，或在设置里开启「自动扫描本地文件夹」`,
            { type: 'info', durationMs: 12000 }
          );
        } else if (summary.scanMaybeMissingCount > 0) {
          folium.ui.toast(
            `缺失歌曲里有 ${summary.scanMaybeMissingCount} 首疑似就在 LX 下载目录里：如果已经下载，请在 Folia 里重新扫描对应目录`,
            { type: 'info', durationMs: 10000 }
          );
        }
        await folium.rpc.call('lx.write-status', {
          ok: true,
          at: new Date().toISOString(),
          ...summary
        }).catch(() => undefined);
        window.dispatchEvent(new CustomEvent('lx-favorites-sync-finished', {
          detail: { ok: true, summary }
        }));
        return summary;
      } catch (error) {
        folium.log.error('LX 收藏同步失败', error);
        folium.ui.toast(`LX 收藏同步失败：${error.message}`, { type: 'error', durationMs: 9000 });
        await folium.rpc.call('lx.write-status', {
          ok: false,
          at: new Date().toISOString(),
          reason,
          mode: currentSyncMode,
          error: error.message
        }).catch(() => undefined);
        window.dispatchEvent(new CustomEvent('lx-favorites-sync-finished', {
          detail: { ok: false, error: error.message }
        }));
        await folium.rpc.call('lx.append-log', {
          level: 'error',
          message: 'LX 收藏同步失败',
          details: { reason, error: error.message }
        }).catch(() => undefined);
        return null;
      } finally {
        activeSync = null;
      }
    })();

    return activeSync;
  };

  command = folium.registries.commands.register({
    id: SYNC_COMMAND_ID,
    label: {
      'zh-CN': '同步 LX Music 收藏',
      en: 'Sync LX Music Favorites'
    },
    description: {
      'zh-CN': '从 LX Music 的“我喜欢”列表更新 Folia 的本地收藏歌单。',
      en: 'Update Folia local favorites from LX Music liked songs.'
    },
    run: async () => {
      await run('manual');
    }
  });

  // 同步模式选择器：显示在模组面板的「同步设置」分区（命令卡片上方），
  // 直接展示当前模式并可直接点选切换；更改只保存、不自动同步——避免切到
  // 「完全同步」时立刻删除收藏。
  try {
    if (folium.registries.settingsSections && typeof folium.registries.settingsSections.register === 'function') {
      modeSection = folium.registries.settingsSections.register({
        id: 'sync-settings',
        label: {
          'zh-CN': '同步设置',
          en: 'Sync settings'
        },
        description: {
          'zh-CN': '选择「我喜欢」同步到 Folia 收藏的方式；更改会立即保存，不会自动同步。',
          en: 'How LX favorites sync into Folia. Changes save immediately without syncing.'
        },
        settings: [
          {
            key: 'mode',
            type: 'select',
            label: {
              'zh-CN': '同步模式',
              en: 'Sync mode'
            },
            description: {
              'zh-CN': '只增加：只追加收藏，从不删除；完全同步：Folia 收藏与 LX 保持一致（会移除 LX 里没有的收藏，谨慎选择）。',
              en: 'Add only: append favorites, never remove. Full mirror: Folia favorites match LX (removes ones missing from LX; use with care).'
            },
            options: [
              { value: SYNC_MODE_MERGE, label: { 'zh-CN': '只增加（推荐）', en: 'Add only (recommended)' } },
              { value: SYNC_MODE_MIRROR, label: { 'zh-CN': '完全同步', en: 'Full mirror' } }
            ],
            defaultValue: SYNC_MODE_MERGE
          }
        ],
        settingsPanel: (container, panelCtx) => mountSyncSettingsPanel(folium, container, panelCtx)
      });

      currentSyncMode = normalizeSyncMode(modeSection.params.get().mode);
      modeSection.params.subscribe(() => {
        const nextMode = normalizeSyncMode(modeSection.params.get().mode);
        if (nextMode === currentSyncMode) {
          return;
        }
        currentSyncMode = nextMode;
        if (folium.env.context === 'main') {
          void folium.rpc.call('lx.write-settings', { mode: nextMode }).catch(() => undefined);
        }
        folium.ui.toast(
          nextMode === SYNC_MODE_MIRROR
            ? '同步模式已设为：完全同步（下次同步会移除 LX 里没有的收藏）'
            : '同步模式已设为：只增加',
          { type: nextMode === SYNC_MODE_MIRROR ? 'info' : 'success', durationMs: 7000 }
        );
      });

      // 旧版本把模式存在 lx-favorites-sync-settings.json 里；首次升级时以文件为准迁移一次。
      syncModeReady = (async () => {
        if (folium.env.context !== 'main') {
          return;
        }
        try {
          const fileSettings = await folium.rpc.call('lx.read-settings');
          if (fileSettings && fileSettings.mode) {
            const fileMode = normalizeSyncMode(fileSettings.mode);
            if (fileMode !== currentSyncMode) {
              currentSyncMode = fileMode;
              modeSection.params.set({ mode: fileMode });
            }
          }
        } catch {
          // 读不到旧设置文件时保持界面上的值
        }
      })();
    } else {
      // 老宿主没有设置分区：仍然从旧设置文件恢复模式
      syncModeReady = (async () => {
        try {
          const fileSettings = await folium.rpc.call('lx.read-settings');
          currentSyncMode = normalizeSyncMode(fileSettings?.mode);
        } catch {
          // 保持默认的“只增加”
        }
      })();
    }
  } catch (error) {
    folium.log.warn('注册同步设置分区失败', error);
  }

  panelTab = folium.registries.playerPanelTabs.register({
    id: MISSING_PANEL_TAB_ID,
    label: {
      'zh-CN': '本地缺失',
      en: 'Missing Local'
    },
    order: 150,
    mount: mountMissingPanel
  });

  openMissingCommand = folium.registries.commands.register({
    id: OPEN_MISSING_COMMAND_ID,
    label: {
      'zh-CN': '查看本地缺失歌曲',
      en: 'Show Missing Local Songs'
    },
    description: {
      'zh-CN': '打开“本地缺失”面板，查看 LX 收藏中没有匹配到本地文件的歌曲。',
      en: 'Open the Missing Local panel to see LX favorites without a local file.'
    },
    run: async () => {
      try {
        await folium.rpc.call('lx.append-log', {
          level: 'info',
          message: '正在打开本地缺失面板',
          details: { tabId: MISSING_PANEL_TAB_ID }
        }).catch(() => undefined);
        let preview = '还没有同步结果，请先执行一次同步。';
        try {
          const database = await openDatabase();
          try {
            const snapshot = await readPersistedState(MISSING_SNAPSHOT_KEY, database);
            const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
            preview = items.length === 0
              ? '没有缺失歌曲喵~'
              : `本地缺失 ${items.length} 首，正在打开“本地缺失”面板。`;
          } finally {
            database.close();
          }
        } catch {
          // The panel will show the detailed read error if the cache is unavailable.
        }
        folium.ui.navigate('player');
        folium.ui.toast(preview, { type: 'info', durationMs: 9000 });
        window.setTimeout(() => {
          try {
            folium.ui.openPlayerPanel(MISSING_PANEL_TAB_ID);
          } catch (error) {
            folium.log.error('打开本地缺失面板失败', error);
            folium.ui.toast(`打开本地缺失面板失败：${error.message}`, { type: 'error', durationMs: 9000 });
          }
        }, 150);
      } catch (error) {
        folium.log.error('打开本地缺失面板失败', error);
        folium.ui.toast(`打开本地缺失面板失败：${error.message}`, { type: 'error', durationMs: 9000 });
      }
    }
  });

  restoreCommand = folium.registries.commands.register({
    id: RESTORE_COMMAND_ID,
    label: {
      'zh-CN': '恢复最近一次变化前的收藏',
      en: 'Restore Favorites From Before Last Change'
    },
    description: {
      'zh-CN': '用最新一份同步备份把 Folia 收藏回退到最近一次变化之前（只动收藏歌单）；想回退到更早的状态，请到模组设置的「同步设置」里打开同步历史。',
      en: 'Restore Folia favorites to just before the latest change (favorites playlist only). Use Sync history in the mod settings to restore an older point.'
    },
    run: async () => {
      try {
        const list = await folium.rpc.call('lx.read-backup-list');
        const latest = Array.isArray(list) && list.length > 0 ? list[0] : null;
        if (!latest) {
          throw new Error('没有找到可用的同步备份');
        }
        const restoredCount = await restoreFavoriteFromBackup(folium, latest);
        const time = formatLocalTimestamp(latest.at) || latest.at;
        folium.ui.toast(`已回退到 ${time} 的收藏状态（${restoredCount} 首）`, { type: 'success', durationMs: 9000 });
        await folium.rpc.call('lx.append-log', {
          level: 'info',
          message: '已恢复最近一次变化前的收藏',
          details: { backupFile: latest.file || '', restoredCount }
        }).catch(() => undefined);
      } catch (error) {
        folium.log.error('恢复同步前收藏失败', error);
        folium.ui.toast(`恢复失败：${error.message}`, { type: 'error', durationMs: 9000 });
      }
    }
  });

  // 播放器进度条旁的「一键同步」按钮（参照 lyrics-list 的 controlButtons 用法）。
  // 单击立即同步；悬停提示里附带上次同步结果。老版本 Folium 没有这个注册表时自动跳过。
  if (folium.registries.controlButtons && typeof folium.registries.controlButtons.register === 'function') {
    try {
      controlButton = folium.registries.controlButtons.register({
        id: 'sync-now',
        slot: 'progress.trailing',
        order: 540,
        mount(container, ctx) {
          const button = document.createElement('button');
          button.type = 'button';
          button.title = '同步 LX Music 收藏';
          button.setAttribute('aria-label', '同步 LX Music 收藏');
          button.style.cssText = 'display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:none;cursor:pointer;';
          button.textContent = '↻';

          const iconCandidates = ['refresh-cw', 'rotate-cw', 'refresh', 'repeat'];
          const loadIcon = (index) => {
            if (index >= iconCandidates.length) {
              return Promise.resolve(null);
            }
            return Promise.resolve(folium.ui.icon(iconCandidates[index], { size: 16 }))
              .then((icon) => icon || loadIcon(index + 1))
              .catch(() => loadIcon(index + 1));
          };
          loadIcon(0).then((icon) => {
            if (icon && button.isConnected) {
              button.replaceChildren(icon);
            }
          }).catch(() => undefined);

          const refreshTitle = () => {
            folium.rpc.call('lx.read-status').then((status) => {
              if (status && typeof status.matchedCount === 'number') {
                const suffix = status.unmatchedCount > 0 ? `，缺失 ${status.unmatchedCount}` : '';
                button.title = `上次同步：匹配 ${status.matchedCount}/${status.sourceCount}${suffix} · 点击立即同步`;
              }
            }).catch(() => undefined);
          };
          refreshTitle();

          const paint = () => {
            const colors = ctx.getColors() || {};
            button.style.color = colors.text || 'inherit';
          };
          const onClick = () => {
            void run('manual');
          };
          button.addEventListener('click', onClick);
          container.appendChild(button);
          paint();
          const offColors = typeof ctx.subscribe === 'function' ? ctx.subscribe(paint) : () => undefined;
          const onSyncFinished = () => refreshTitle();
          window.addEventListener('lx-favorites-sync-finished', onSyncFinished);
          return () => {
            offColors();
            window.removeEventListener('lx-favorites-sync-finished', onSyncFinished);
            button.removeEventListener('click', onClick);
            button.remove();
          };
        }
      });
    } catch (error) {
      folium.log.warn('注册播放器一键同步按钮失败', error);
    }
  }

  startupTimer = window.setTimeout(() => {
    void run('startup');
  }, STARTUP_DELAY_MS);

  folium.log.info('LX 收藏同步客户端已加载');

  return () => {
    disposed = true;
    if (startupTimer !== null) {
      window.clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (missingRequestHandler) {
      window.removeEventListener('lx-favorites-sync-request', missingRequestHandler);
      missingRequestHandler = null;
    }
    try {
      command?.unregister();
      modeSection?.unregister();
      restoreCommand?.unregister();
      openMissingCommand?.unregister();
      controlButton?.unregister();
      panelTab?.unregister();
    } catch {
      // The host may already have removed the command.
    }
  };
}
