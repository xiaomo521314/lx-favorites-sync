const DB_NAME = 'KineticPlayerDB';
const LOCAL_MUSIC_STORE = 'local_music';
const CACHE_STORE = 'api_cache';
const LOCAL_PLAYLISTS_KEY = 'local_playlists';
const LOCAL_DIR_HANDLES_KEY = 'local_dir_handles';
const SYNC_STATE_KEY = 'lx-favorites-sync-state';
const MISSING_SNAPSHOT_KEY = 'lx-favorites-sync-missing';
const FAVORITE_NAME = 'Liked Songs';
const SYNC_COMMAND_ID = 'sync-lx-favorites';
const CHOOSE_COMMAND_ID = 'choose-lx-download-folder';
const TOGGLE_MODE_COMMAND_ID = 'toggle-sync-mode';
const STATUS_COMMAND_ID = 'show-sync-status';
const RESTORE_COMMAND_ID = 'restore-last-sync';
const OPEN_MISSING_COMMAND_ID = 'open-missing-songs';
const MISSING_PANEL_TAB_ID = 'local-missing';
const SYNC_MODE_MIRROR = 'mirror';
const SYNC_MODE_MERGE = 'merge';
const STARTUP_DELAY_MS = 4500;
const DB_WAIT_TIMEOUT_MS = 20000;

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

const matchFavorites = (favorites, songs) => {
  const index = buildSongIndex(songs);
  const matchedIds = [];
  const unmatched = [];
  const seenIds = new Set();

  favorites.forEach((favorite) => {
    const lxItem = lxRecord(favorite);
    const song = chooseCandidate(lxItem, index);
    if (!song) {
      unmatched.push({ id: lxItem.id, name: lxItem.title, singer: lxItem.artist });
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

const readCachedData = async (database, key) => {
  const record = await readOne(database, CACHE_STORE, key);
  return record ? record.data : undefined;
};

const writeCachedData = async (database, key, data) => {
  await putOne(database, CACHE_STORE, {
    key,
    data,
    timestamp: Date.now()
  });
};

const loadFoliaBootstrap = (() => {
  let loadPromise = null;
  return () => {
    if (!loadPromise) {
      loadPromise = (async () => {
        const mainScript = Array.from(document.querySelectorAll('script[type="module"][src]'))
          .map((script) => script.src)
          .find((source) => /\/assets\/main-[^/]+\.js(?:\?|$)/.test(source));
        const candidates = [];
        const addCandidate = (url) => {
          if (url && !candidates.includes(url)) {
            candidates.push(url);
          }
        };

        if (mainScript) {
          addCandidate(new URL('./bootstrap-KlVCxytD.js', mainScript).href);
          try {
            const source = await (await fetch(mainScript)).text();
            const match = source.match(/["']\.\/(bootstrap-[^"']+\.js)["']/);
            if (match) {
              addCandidate(new URL(`./${match[1]}`, mainScript).href);
            }
          } catch {
            // A file URL may be unreadable through fetch in some Electron builds.
          }
        }
        performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter((url) => /\/assets\/bootstrap-[^/]+\.js(?:\?|$)/.test(url))
          .forEach(addCandidate);
        addCandidate(new URL('./assets/bootstrap-KlVCxytD.js', document.baseURI).href);

        for (const url of candidates) {
          try {
            const module = await import(/* @vite-ignore */ url);
            const importFunction = Object.values(module)
              .find((value) => typeof value === 'function' && value.name === 'Pk')
              || module.Xn;
            if (typeof importFunction === 'function') {
              return importFunction;
            }
          } catch {
            // Folia updates can change the chunk hash; try the next candidate.
          }
        }
        return null;
      })();
    }
    return loadPromise;
  };
})();

const toBasename = (value) => String(value || '')
  .replace(/\\/g, '/')
  .replace(/\/+$/, '')
  .split('/')
  .pop() || '';

const findSavedRootName = (state, handles, lxSavePath) => {
  if (state?.rootName && handles && handles[state.rootName]) {
    return state.rootName;
  }
  const expectedName = toBasename(lxSavePath);
  if (!expectedName || !handles) {
    return '';
  }
  return Object.keys(handles).find((name) => name.toLowerCase() === expectedName.toLowerCase()) || '';
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

const rememberDirectoryHandle = async (database, handle) => {
  const handles = await readCachedData(database, LOCAL_DIR_HANDLES_KEY);
  const nextHandles = handles && typeof handles === 'object' && !Array.isArray(handles)
    ? { ...handles }
    : {};
  nextHandles[handle.name] = handle;
  await writeCachedData(database, LOCAL_DIR_HANDLES_KEY, nextHandles);
  const state = await readCachedData(database, SYNC_STATE_KEY);
  await writeCachedData(database, SYNC_STATE_KEY, {
    ...(state && typeof state === 'object' ? state : {}),
    rootName: handle.name,
    rootChosenAt: Date.now()
  });
  return handle.name;
};

const rescanSavedDownloadDirectory = async (database, folium, lxData) => {
  const [state, handles] = await Promise.all([
    readCachedData(database, SYNC_STATE_KEY),
    readCachedData(database, LOCAL_DIR_HANDLES_KEY)
  ]);
  const rootName = findSavedRootName(state, handles, lxData?.lxSavePath);
  if (!rootName || !handles?.[rootName]) {
    return { status: 'not-configured', rootName: '' };
  }

  const handle = handles[rootName];
  try {
    const permission = typeof handle.queryPermission === 'function'
      ? await handle.queryPermission({ mode: 'read' })
      : 'granted';
    if (permission !== 'granted') {
      return { status: 'needs-permission', rootName };
    }
  } catch {
    return { status: 'needs-permission', rootName };
  }

  const importDirectory = await loadFoliaBootstrap();
  if (typeof importDirectory !== 'function') {
    return { status: 'unsupported-version', rootName };
  }

  await importDirectory(rootName);
  return { status: 'rescanned', rootName };
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

const syncOnce = async (folium, reason) => {
  await waitForDatabase();
  const database = await openDatabase();
  try {
    const favoriteResponse = await folium.rpc.call('lx.read-favorites');
    let importStatus = { status: 'skipped', rootName: '' };
    if (reason === 'startup' || reason === 'manual' || reason === 'manual-import') {
      try {
        importStatus = await rescanSavedDownloadDirectory(database, folium, favoriteResponse);
      } catch (error) {
        importStatus = { status: 'failed', rootName: '', error: error.message };
        await folium.rpc.call('lx.append-log', {
          level: 'warn',
          message: '自动扫描 LX 下载目录失败，将继续同步现有本地曲库',
          details: { error: error.message }
        }).catch(() => undefined);
      }
    }

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
    const { matchedIds, unmatched } = matchFavorites(favorites, songs);
    if (matchedIds.length === 0) {
      throw new Error('LX 收藏没有匹配到 Folia 本地曲库，已停止同步');
    }

    const settings = await folium.rpc.call('lx.read-settings').catch(() => ({ mode: SYNC_MODE_MIRROR }));
    const syncMode = normalizeSyncMode(settings?.mode);
    const previousState = await readCachedData(database, SYNC_STATE_KEY);
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
    const summary = {
      reason,
      mode: syncMode,
      sourceCount: favorites.length,
      localSongCount: localSongs.length,
      matchedCount: matchedIds.length,
      unmatchedCount: unmatched.length,
      previousCount: previousIds.length,
      nextCount: nextIds.length,
      addedCount: nextIds.filter((id) => !beforeSet.has(id)).length,
      removedCount: previousIds.filter((id) => !afterSet.has(id)).length,
      changed: !sameIds(previousIds, nextIds),
      unmatched: unmatched.slice(0, 30),
      databasePath: favoriteResponse?.databasePath || '',
      downloadRoots: Array.isArray(favoriteResponse?.downloadRoots) ? favoriteResponse.downloadRoots : [],
      importStatus
    };

    await folium.rpc.call('lx.write-backup', {
      at: new Date().toISOString(),
      reason,
      summary,
      before: currentFavorite,
      beforePlaylists: playlists,
      after: nextFavorite,
      playlists: nextPlaylists
    });
    await writeCachedData(database, MISSING_SNAPSHOT_KEY, {
      at: new Date().toISOString(),
      mode: syncMode,
      sourceCount: favorites.length,
      matchedCount: matchedIds.length,
      items: unmatched
    });
    await writeCachedData(database, SYNC_STATE_KEY, {
      ...(previousState && typeof previousState === 'object' ? previousState : {}),
      lastMatchedCount: matchedIds.length,
      lastSyncAt: Date.now()
    });
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
        snapshot = await readCachedData(database, MISSING_SNAPSHOT_KEY);
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
        feedback = text('正在重新同步…', 'Syncing…');
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
      `LX 收藏 ${snapshot.sourceCount || 0} 首，匹配 ${snapshot.matchedCount || 0} 首，缺失 ${items.length} 首`,
      `LX favorites ${snapshot.sourceCount || 0}, matched ${snapshot.matchedCount || 0}, missing ${items.length}`
    );
    summary.style.cssText = 'font-size:12px;opacity:.72;';
    root.append(summary);
    if (feedback) {
      const feedbackLine = document.createElement('div');
      feedbackLine.textContent = feedback;
      feedbackLine.style.cssText = 'font-size:12px;line-height:1.45;opacity:.9;';
      root.append(feedbackLine);
    }

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = text('没有缺失歌曲。', 'No missing songs.');
      empty.style.cssText = 'font-size:13px;opacity:.75;';
      root.append(empty);
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
      row.textContent = `${index + 1}. ${item.name || ''}${item.singer ? ` - ${item.singer}` : ''}`;
      row.style.cssText = 'font-size:13px;line-height:1.45;padding:6px 8px;border-radius:8px;background:color-mix(in srgb, currentColor 8%, transparent);';
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
    if (detail.ok) {
      const summary = detail.summary || {};
      feedback = text(
        `同步完成：匹配 ${summary.matchedCount || 0}/${summary.sourceCount || 0} 首，缺失 ${summary.unmatchedCount || 0} 首`,
        `Sync complete: matched ${summary.matchedCount || 0}/${summary.sourceCount || 0}, missing ${summary.unmatchedCount || 0}`
      );
    } else {
      feedback = text(
        `同步失败：${detail.error || '未知错误'}`,
        `Sync failed: ${detail.error || 'unknown error'}`
      );
    }
    syncState = 'idle';
    safeRender();
  };
  window.addEventListener('lx-favorites-sync-updated', onUpdated);
  window.addEventListener('lx-favorites-sync-finished', onFinished);
  const onDocumentPointerDown = (event) => {
    if (sortMenuOpen && !(sortPickerElement && sortPickerElement.contains(event.target))) {
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
  let disposed = false;
  let activeSync = null;
  let startupTimer = null;
  let command = null;
  let chooseCommand = null;
  let toggleCommand = null;
  let statusCommand = null;
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
        if (summary.importStatus?.status === 'not-configured') {
          folium.ui.toast('如需自动扫描 LX 下载目录，请在命令面板执行一次“选择 LX 下载目录”', {
            type: 'info',
            durationMs: 9000
          });
        } else if (summary.importStatus?.status === 'needs-permission') {
          folium.ui.toast('LX 下载目录需要重新授权，请执行“选择 LX 下载目录”', {
            type: 'info',
            durationMs: 9000
          });
        } else if (summary.importStatus?.status === 'unsupported-version') {
          folium.ui.toast('当前 Folia 版本无法自动导入目录，请先在 Folia 中手动导入 LX 下载目录', {
            type: 'info',
            durationMs: 10000
          });
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
        const settings = await folium.rpc.call('lx.read-settings').catch(() => ({ mode: SYNC_MODE_MIRROR }));
        await folium.rpc.call('lx.write-status', {
          ok: false,
          at: new Date().toISOString(),
          reason,
          mode: settings?.mode,
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

  chooseCommand = folium.registries.commands.register({
    id: CHOOSE_COMMAND_ID,
    label: {
      'zh-CN': '选择 LX 下载目录',
      en: 'Choose LX Download Folder'
    },
    description: {
      'zh-CN': '授权一次 LX 下载目录；以后 Folia 每次启动都会自动扫描其中的新歌曲。',
      en: 'Authorize the LX download folder once; future Folia launches rescan it automatically.'
    },
    run: async () => {
      try {
        if (typeof window.showDirectoryPicker !== 'function') {
          throw new Error('当前 Folia 不支持目录选择，请先在 Folia 中手动导入 LX 下载目录');
        }
        const handle = await window.showDirectoryPicker({
          id: 'lx-favorites-sync-download-root',
          mode: 'read'
        });
        if (!handle) {
          return;
        }
        const database = await openDatabase();
        try {
          await rememberDirectoryHandle(database, handle);
        } finally {
          database.close();
        }
        await run('manual-import', { force: true });
      } catch (error) {
        folium.log.error('选择 LX 下载目录失败', error);
        folium.ui.toast(`选择 LX 下载目录失败：${error.message}`, { type: 'error', durationMs: 9000 });
      }
    }
  });

  toggleCommand = folium.registries.commands.register({
    id: TOGGLE_MODE_COMMAND_ID,
    label: {
      'zh-CN': '切换 LX 收藏同步模式',
      en: 'Toggle LX Favorite Sync Mode'
    },
    description: {
      'zh-CN': '在“完全同步”和“只增加”之间切换；切换后会立即同步一次。',
      en: 'Toggle between full mirror sync and add-only sync, then synchronize once.'
    },
    run: async () => {
      try {
        const settings = await folium.rpc.call('lx.read-settings');
        const nextMode = normalizeSyncMode(settings?.mode) === SYNC_MODE_MIRROR
          ? SYNC_MODE_MERGE
          : SYNC_MODE_MIRROR;
        await folium.rpc.call('lx.write-settings', { mode: nextMode });
        const warning = nextMode === SYNC_MODE_MIRROR
          ? '下次同步会移除 Folia 中 LX 没有的收藏'
          : '下次同步只会增加，不会删除已有收藏';
        folium.ui.toast(`同步模式已切换为：${syncModeLabel(nextMode)}。${warning}`, {
          type: nextMode === SYNC_MODE_MIRROR ? 'info' : 'success',
          durationMs: 9000
        });
      } catch (error) {
        folium.log.error('切换 LX 收藏同步模式失败', error);
        folium.ui.toast(`切换同步模式失败：${error.message}`, { type: 'error', durationMs: 9000 });
      }
    }
  });

  statusCommand = folium.registries.commands.register({
    id: STATUS_COMMAND_ID,
    label: {
      'zh-CN': '查看 LX 收藏同步状态',
      en: 'Show LX Favorite Sync Status'
    },
    description: {
      'zh-CN': '查看当前同步模式、上次同步结果、匹配数量和最近一次是否有移除。',
      en: 'Show the current sync mode, last result, match count, and whether entries were removed.'
    },
    run: async () => {
      try {
        const [settings, status] = await Promise.all([
          folium.rpc.call('lx.read-settings'),
          folium.rpc.call('lx.read-status')
        ]);
        const mode = syncModeLabel(settings?.mode);
        if (!status || status.ok === null || status.ok === undefined) {
          folium.ui.toast(`当前模式：${mode}。还没有同步记录，请先执行一次同步。`, {
            type: 'info',
            durationMs: 9000
          });
          return;
        }
        const result = status.ok ? '成功' : '失败';
        const text = `模式：${mode}；上次同步：${result}；匹配 ${status.matchedCount || 0}/${status.sourceCount || 0}；新增 ${status.addedCount || 0}；移除 ${status.removedCount || 0}`;
        folium.ui.toast(text, {
          type: status.ok ? 'info' : 'error',
          durationMs: 12000
        });
      } catch (error) {
        folium.log.error('读取 LX 收藏同步状态失败', error);
        folium.ui.toast(`读取同步状态失败：${error.message}`, { type: 'error', durationMs: 9000 });
      }
    }
  });

  restoreCommand = folium.registries.commands.register({
    id: RESTORE_COMMAND_ID,
    label: {
      'zh-CN': '恢复上次同步前的收藏',
      en: 'Restore Favorites From Before Last Sync'
    },
    description: {
      'zh-CN': '用最近一次同步前的备份恢复 Folia 本地收藏，主要用于误删后的回滚。',
      en: 'Restore Folia local favorites from the latest pre-sync backup.'
    },
    run: async () => {
      try {
        const backup = await folium.rpc.call('lx.read-latest-backup');
        if (!backup) {
          throw new Error('没有找到可用的同步备份');
        }

        const database = await openDatabase();
        try {
          let playlists = Array.isArray(backup.beforePlaylists) ? backup.beforePlaylists : null;
          if (!playlists) {
            const record = await readOne(database, CACHE_STORE, LOCAL_PLAYLISTS_KEY);
            playlists = Array.isArray(record?.data) ? record.data : [];
            if (backup.before) {
              playlists = playlists.map((playlist) => (
                playlist?.isFavorite ? backup.before : playlist
              ));
            }
          }
          await writeCachedData(database, LOCAL_PLAYLISTS_KEY, playlists);
          window.dispatchEvent(new CustomEvent('folia-local-music-updated'));
        } finally {
          database.close();
        }

        folium.ui.toast('已恢复最近一次同步前的收藏', { type: 'success', durationMs: 9000 });
        await folium.rpc.call('lx.append-log', {
          level: 'info',
          message: '已恢复最近一次同步前的收藏',
          details: { backupFile: backup.file || '' }
        }).catch(() => undefined);
      } catch (error) {
        folium.log.error('恢复同步前收藏失败', error);
        folium.ui.toast(`恢复失败：${error.message}`, { type: 'error', durationMs: 9000 });
      }
    }
  });

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
            const snapshot = await readCachedData(database, MISSING_SNAPSHOT_KEY);
            const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
            preview = items.length === 0
              ? '没有本地缺失歌曲。'
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
      chooseCommand?.unregister();
      toggleCommand?.unregister();
      statusCommand?.unregister();
      restoreCommand?.unregister();
      openMissingCommand?.unregister();
      controlButton?.unregister();
      panelTab?.unregister();
    } catch {
      // The host may already have removed the command.
    }
  };
}
