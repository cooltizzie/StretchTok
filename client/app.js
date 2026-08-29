// ---------- element refs ----------
const videoInput = document.getElementById('videoInput');
const dropZone = document.getElementById('dropZone');
const gridWrapper = document.getElementById('gridWrapper');
const videoGrid = document.getElementById('videoGrid');

const customRatio = document.getElementById('customRatio');
const ratioVal = document.getElementById('ratioVal');
const presetBtns = document.querySelectorAll('.preset-btn');
const exportBtn = document.getElementById('exportBtn');
const exportBtnText = document.getElementById('exportBtnText');
const exportRes = document.getElementById('exportRes');
const queueList = document.getElementById('queueList');
const queueCount = document.getElementById('queueCount');
const progressOverlay = document.getElementById('progressOverlay');
const progressPct = document.getElementById('progressPct');
const progressLabel = document.getElementById('progressLabel');

const consoleWindow = document.getElementById('consoleWindow');
const consoleHeader = document.getElementById('consoleHeader');
const consoleBody = document.getElementById('consoleBody');
const toggleConsoleBtn = document.getElementById('toggleConsoleBtn');
const closeConsoleBtn = document.getElementById('closeConsoleBtn');

const shortcutsPanel = document.getElementById('shortcutsPanel');
const shortcutsBtn = document.getElementById('shortcutsBtn');
const closeShortcutsBtn = document.getElementById('closeShortcutsBtn');

let currentAspectRatio = 16 / 9;
let isProcessing = false;
let fileQueue = [];       // array of { file, url, tileEl, videoEl }
let selectedIndex = -1;
let currentlyPlayingIndex = -1;

// Note: unlike earlier versions, there's no hidden export <canvas>/<video>
// here anymore — actual transcoding now happens server-side (see
// EXPORT_ENDPOINT below). The tile preview canvas is still used for the
// live stretched preview/fullscreen, that part is unchanged.

// ---------- logging ----------
function log(msg, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const now = new Date();
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const time = `${now.toLocaleTimeString().split(' ')[0]}.${ms}`;
  entry.textContent = `[${time}] ${msg}`;
  consoleBody.appendChild(entry);
  consoleBody.scrollTop = consoleBody.scrollHeight;
}

// ---------- console toggle + drag (mouse + touch) ----------
function toggleConsole() {
  consoleWindow.style.display = consoleWindow.style.display === 'none' ? 'flex' : 'none';
}
toggleConsoleBtn.addEventListener('click', toggleConsole);
closeConsoleBtn.addEventListener('click', () => consoleWindow.style.display = 'none');

let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;
function dragStart(clientX, clientY, target) {
  if (target === closeConsoleBtn) return;
  isDragging = true;
  const rect = consoleWindow.getBoundingClientRect();
  dragOffsetX = clientX - rect.left;
  dragOffsetY = clientY - rect.top;
}
function dragMove(clientX, clientY) {
  if (!isDragging) return;
  consoleWindow.style.left = `${clientX - dragOffsetX}px`;
  consoleWindow.style.top = `${clientY - dragOffsetY}px`;
  consoleWindow.style.bottom = 'auto';
  consoleWindow.style.right = 'auto';
}
consoleHeader.addEventListener('mousedown', (e) => dragStart(e.clientX, e.clientY, e.target));
window.addEventListener('mousemove', (e) => dragMove(e.clientX, e.clientY));
window.addEventListener('mouseup', () => isDragging = false);

consoleHeader.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  dragStart(t.clientX, t.clientY, e.target);
}, { passive: true });
window.addEventListener('touchmove', (e) => {
  if (!isDragging) return;
  const t = e.touches[0];
  dragMove(t.clientX, t.clientY);
}, { passive: true });
window.addEventListener('touchend', () => isDragging = false);

// ---------- shortcuts panel ----------
function toggleShortcuts() {
  shortcutsPanel.style.display = shortcutsPanel.style.display === 'none' ? 'block' : 'none';
}
shortcutsBtn.addEventListener('click', toggleShortcuts);
closeShortcutsBtn.addEventListener('click', () => shortcutsPanel.style.display = 'none');

// ---------- file handling (append, don't replace) ----------
dropZone.addEventListener('click', () => videoInput.click());
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (isProcessing) { log('Export running. Wait until finished.', 'error'); return; }
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
videoInput.addEventListener('change', (e) => {
  if (isProcessing) { log('Export running. Wait until finished.', 'error'); return; }
  if (e.target.files.length) addFiles(e.target.files);
  videoInput.value = ''; // allow re-adding same file later
});

function addFiles(fileList) {
  const newFiles = Array.from(fileList).filter(f => f.type.startsWith('video/'));
  if (newFiles.length === 0) { log('No valid video files found.', 'error'); return; }

  newFiles.forEach(file => {
    const entry = { file, url: URL.createObjectURL(file), tileEl: null, videoEl: null };
    fileQueue.push(entry);
  });

  log(`Added ${newFiles.length} file(s). Queue now ${fileQueue.length}.`, 'sys');
  renderQueueList();
  renderGrid();

  dropZone.style.display = 'none';
  gridWrapper.style.display = 'block';
  exportBtn.disabled = fileQueue.length === 0;
  exportBtnText.textContent = fileQueue.length === 1 ? 'Export Video' : `Export All as ZIP (${fileQueue.length})`;

  if (selectedIndex === -1 && fileQueue.length > 0) selectTile(0);
}

function renderQueueList() {
  queueCount.textContent = fileQueue.length;
  if (fileQueue.length === 0) {
    queueList.innerHTML = '<div class="queue-empty">No files loaded</div>';
    return;
  }
  queueList.innerHTML = fileQueue.map((entry, idx) => `
    <div class="queue-item">
      <span>${idx + 1}. ${entry.file.name}</span>
      <span>${(entry.file.size / 1048576).toFixed(1)}MB</span>
    </div>`).join('');
}

// ---------- grid rendering ----------
function renderGrid() {
  videoGrid.innerHTML = '';
  fileQueue.forEach((entry, idx) => {
    const tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.dataset.index = idx;

    // raw video acts as the always-visible square thumbnail AND the frame
    // source for the stretched canvas — it never gets stretched itself
    const video = document.createElement('video');
    video.src = entry.url;
    video.playsInline = true;
    video.muted = false;
    video.volume = 0.6; // reasonable default, not blasting on hover/tap
    video.loop = true;
    video.preload = 'metadata';

    // stretched live preview — only shown once playback starts, draws the
    // video at currentAspectRatio so what you see matches the export
    const previewCanvas = document.createElement('canvas');
    previewCanvas.className = 'tile-preview-canvas';

    const overlay = document.createElement('div');
    overlay.className = 'tile-overlay';

    const playBtn = document.createElement('button');
    playBtn.className = 'tile-play-btn';
    playBtn.innerHTML = playIconSVG();
    playBtn.title = 'Play/pause (stretched, with audio)';

    const fullscreenBtn = document.createElement('button');
    fullscreenBtn.className = 'tile-fullscreen-btn';
    fullscreenBtn.innerHTML = fullscreenIconSVG();
    fullscreenBtn.title = 'Fullscreen stretched preview';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'tile-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove from queue';

    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = entry.file.name;

    overlay.appendChild(playBtn);
    tile.appendChild(video);
    tile.appendChild(previewCanvas);
    tile.appendChild(overlay);
    tile.appendChild(fullscreenBtn);
    tile.appendChild(removeBtn);
    tile.appendChild(label);
    videoGrid.appendChild(tile);

    entry.tileEl = tile;
    entry.videoEl = video;
    entry.canvasEl = previewCanvas;
    entry.canvasCtx = previewCanvas.getContext('2d', { alpha: false });
    entry.rafId = null;

    // play button: works for both click (desktop) and tap (touch) via click event
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTilePlayback(idx);
    });

    fullscreenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      requestTileFullscreen(idx);
    });

    // tile select — also acts as the tap target on touch devices where hover
    // doesn't exist, so the play button is always visible on touch (see CSS)
    tile.addEventListener('click', () => selectTile(idx));

    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromQueue(idx);
    });

    video.addEventListener('ended', () => {
      stopTilePreviewLoop(idx);
      tile.classList.remove('playing');
      playBtn.innerHTML = playIconSVG();
    });
  });
  updateSelectedVisual();
}

function playIconSVG() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
}
function pauseIconSVG() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>`;
}
function fullscreenIconSVG() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/></svg>`;
}

// Draws the current video frame into the tile's canvas at currentAspectRatio,
// i.e. exactly the stretch that export will produce — so play/fullscreen
// shows the real output, not the untouched source video.
//
// The canvas backing-store resolution is capped for the in-grid (non-
// fullscreen) case. Without this, a 1080p+ source drawn at full resolution
// into a canvas that's only ~200px on screen forces a full-res draw *and*
// a browser-side downscale every single frame — on a lot of devices that's
// expensive enough to tank the actual frame rate to the "5fps" people see,
// even though requestAnimationFrame itself is firing at 60fps. Capping the
// backing store to the tile's real on-screen size (times devicePixelRatio,
// with a sane ceiling) keeps the draw cheap. Fullscreen uses full source
// resolution since the canvas is then actually large on screen.
const PREVIEW_MAX_DIM = 640; // backing-store cap for in-grid preview, in px

function stretchDrawLoop(idx) {
  const entry = fileQueue[idx];
  if (!entry) return;
  const { videoEl, canvasEl, canvasCtx, tileEl } = entry;

  if (videoEl.readyState >= 2) {
    const isFullscreen = document.fullscreenElement === canvasEl
      || document.webkitFullscreenElement === canvasEl;

    const sourceH = videoEl.videoHeight || 720;
    const fullW = Math.round(sourceH * currentAspectRatio);

    let targetW, targetH;
    if (isFullscreen) {
      // full source resolution — canvas is genuinely full-screen-sized now
      targetW = fullW;
      targetH = sourceH;
    } else {
      // scale down to a cheap-to-draw backing store, keeping the same
      // stretched aspect ratio so it still looks correct, just smaller
      const scale = Math.min(1, PREVIEW_MAX_DIM / Math.max(fullW, sourceH));
      targetW = Math.max(1, Math.round(fullW * scale));
      targetH = Math.max(1, Math.round(sourceH * scale));
    }

    if (canvasEl.width !== targetW || canvasEl.height !== targetH) {
      canvasEl.width = targetW;
      canvasEl.height = targetH;
    }

    if (!videoEl.paused && !videoEl.ended) {
      try {
        canvasCtx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
      } catch (err) {
        // ignore transient draw errors (e.g. mid-seek) — next frame retries
      }
    }
  }

  entry.rafId = requestAnimationFrame(() => stretchDrawLoop(idx));
}

function stopTilePreviewLoop(idx) {
  const entry = fileQueue[idx];
  if (!entry) return;
  if (entry.rafId) {
    cancelAnimationFrame(entry.rafId);
    entry.rafId = null;
  }
  entry.tileEl.classList.remove('stretched-active');
}

function toggleTilePlayback(idx) {
  const entry = fileQueue[idx];
  if (!entry) return;
  const video = entry.videoEl;
  const tile = entry.tileEl;
  const btn = tile.querySelector('.tile-play-btn');

  // pause whatever else is playing so audio doesn't stack
  if (currentlyPlayingIndex !== -1 && currentlyPlayingIndex !== idx) {
    const prev = fileQueue[currentlyPlayingIndex];
    if (prev && prev.videoEl) {
      prev.videoEl.pause();
      stopTilePreviewLoop(currentlyPlayingIndex);
      prev.tileEl.classList.remove('playing');
      prev.tileEl.querySelector('.tile-play-btn').innerHTML = playIconSVG();
    }
  }

  if (video.paused) {
    video.play().catch(err => log(`Playback blocked: ${err.message}`, 'warn'));
    tile.classList.add('playing', 'stretched-active');
    btn.innerHTML = pauseIconSVG();
    currentlyPlayingIndex = idx;
    if (!entry.rafId) stretchDrawLoop(idx);
  } else {
    video.pause();
    stopTilePreviewLoop(idx);
    tile.classList.remove('playing');
    btn.innerHTML = playIconSVG();
    currentlyPlayingIndex = -1;
  }
}

// Fullscreens the stretched canvas (the actual output look), not the raw
// <video> element — that's the whole point of this button.
function requestTileFullscreen(idx) {
  const entry = fileQueue[idx];
  if (!entry) return;

  // make sure it's playing/drawing before going fullscreen so it's not blank
  if (entry.videoEl.paused) {
    toggleTilePlayback(idx);
  }

  const canvas = entry.canvasEl;
  const req = canvas.requestFullscreen
    || canvas.webkitRequestFullscreen  // Safari
    || canvas.webkitEnterFullscreen;   // iOS Safari video-style fallback

  if (!req) {
    log('Fullscreen not supported in this browser.', 'warn');
    return;
  }

  try {
    const result = req.call(canvas);
    if (result && result.catch) {
      result.catch(err => log(`Fullscreen failed: ${err.message}`, 'warn'));
    }
  } catch (err) {
    log(`Fullscreen failed: ${err.message}`, 'warn');
  }
}

function selectTile(idx) {
  selectedIndex = idx;
  updateSelectedVisual();
}

function updateSelectedVisual() {
  fileQueue.forEach((entry, idx) => {
    if (!entry.tileEl) return;
    entry.tileEl.classList.toggle('selected', idx === selectedIndex);
  });
}

function removeFromQueue(idx) {
  const entry = fileQueue[idx];
  if (entry.videoEl) entry.videoEl.pause();
  stopTilePreviewLoop(idx);
  URL.revokeObjectURL(entry.url);
  fileQueue.splice(idx, 1);
  if (currentlyPlayingIndex === idx) currentlyPlayingIndex = -1;
  if (selectedIndex >= fileQueue.length) selectedIndex = fileQueue.length - 1;

  renderQueueList();
  renderGrid();

  if (fileQueue.length === 0) {
    dropZone.style.display = 'block';
    gridWrapper.style.display = 'none';
    exportBtn.disabled = true;
  } else {
    exportBtnText.textContent = fileQueue.length === 1 ? 'Export Video' : `Export All as ZIP (${fileQueue.length})`;
  }
}

// ---------- ratio controls ----------
function setRatio(r) {
  currentAspectRatio = r;
  customRatio.value = r.toFixed(2);
  ratioVal.textContent = r.toFixed(2);
}

presetBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    presetBtns.forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    const [w, h] = e.currentTarget.getAttribute('data-ratio').split('/').map(Number);
    setRatio(w / h);
  });
});

customRatio.addEventListener('input', (e) => {
  presetBtns.forEach(b => b.classList.remove('active'));
  setRatio(parseFloat(e.target.value));
});

// ---------- keyboard shortcuts (desktop only, harmless on mobile since no keyboard events fire) ----------
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  if (/^[1-6]$/.test(e.key)) {
    const btn = document.querySelector(`.preset-btn[data-key="${e.key}"]`);
    if (btn) btn.click();
    return;
  }
  if (e.key === '[' || e.key === ']') {
    e.preventDefault();
    const step = e.key === ']' ? 0.05 : -0.05;
    const next = Math.min(3.5, Math.max(0.5, currentAspectRatio + step));
    presetBtns.forEach(b => b.classList.remove('active'));
    setRatio(next);
    return;
  }
  if (e.key.toLowerCase() === 'o') { videoInput.click(); return; }
  if (e.key === ' ') {
    e.preventDefault();
    if (selectedIndex !== -1) toggleTilePlayback(selectedIndex);
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!exportBtn.disabled) exportBtn.click();
    return;
  }
  if (e.key === '`') { toggleConsole(); return; }
  if (e.key === '?') { toggleShortcuts(); return; }
});

// ---------- export config ----------
// Point this at your deployed Cloudflare Worker (see the tutorial). During
// local testing before you've deployed anything, you can temporarily point
// this straight at your Render server's URL instead — just note that skips
// the Worker layer entirely.
const EXPORT_ENDPOINT = 'https://stretchtok-proxy.YOUR-SUBDOMAIN.workers.dev/export';

exportBtn.addEventListener('click', async () => {
  if (isProcessing || fileQueue.length === 0) return;

  isProcessing = true;
  exportBtn.disabled = true;

  // stop any preview playback (and its stretch draw loop) so nothing keeps
  // burning CPU in the background while we wait on the server
  fileQueue.forEach((entry, idx) => {
    if (entry.videoEl && !entry.videoEl.paused) {
      entry.videoEl.pause();
      entry.tileEl.classList.remove('playing');
      entry.tileEl.querySelector('.tile-play-btn').innerHTML = playIconSVG();
    }
    stopTilePreviewLoop(idx);
  });
  currentlyPlayingIndex = -1;

  progressOverlay.style.display = 'flex';
  progressPct.textContent = '';

  const queueSnapshot = fileQueue.map(e => e.file);

  if (queueSnapshot.length > 1) {
    log(`--- BATCH EXPORT: ${queueSnapshot.length} files (server-side) ---`, 'warn');
    const zip = new JSZip();
    for (let i = 0; i < queueSnapshot.length; i++) {
      progressLabel.textContent = `File ${i + 1} of ${queueSnapshot.length} — uploading & transcoding`;
      const { name, blob } = await exportOne(queueSnapshot[i], i, queueSnapshot.length);
      if (blob) zip.file(name, blob);
    }
    progressLabel.textContent = 'Zipping...';
    log('Building ZIP file...', 'warn');
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url; a.download = `StretchTok_Export_${Date.now()}.zip`; a.click();
    log('ZIP download started.', 'success');
  } else {
    log('--- SINGLE EXPORT INITIATED (server-side) ---', 'warn');
    progressLabel.textContent = 'Uploading & transcoding on server...';
    const { name, blob } = await exportOne(queueSnapshot[0], 0, 1);
    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      log(`Export success (${(blob.size / 1048576).toFixed(2)} MB). Downloading...`, 'success');
    }
  }

  progressOverlay.style.display = 'none';
  isProcessing = false;
  exportBtn.disabled = false;
});

// Uploads one file to the Worker (which forwards to Render's real ffmpeg)
// and resolves with the transcoded result. Uses XHR instead of fetch so we
// get real upload-progress events — fetch's request-body progress support
// is still inconsistent across browsers.
function exportOne(file, index, total) {
  return new Promise((resolve) => {
    log(`[${index + 1}/${total}] Uploading: ${file.name} (${(file.size / 1048576).toFixed(1)}MB)`, 'sys');

    const formData = new FormData();
    formData.append('video', file);
    formData.append('aspectRatio', String(currentAspectRatio));
    formData.append('targetHeight', exportRes.value);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', EXPORT_ENDPOINT);
    xhr.responseType = 'blob';

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        progressPct.textContent = `${pct}%`;
        progressLabel.textContent = `File ${index + 1}/${total} — uploading (${pct}%)`;
      }
    };

    xhr.onloadstart = () => {
      progressPct.textContent = '0%';
    };

    // once the upload finishes, we're waiting on server-side ffmpeg —
    // there's no standard progress event for that, so just show it's working
    xhr.upload.onload = () => {
      progressLabel.textContent = `File ${index + 1}/${total} — transcoding on server...`;
      progressPct.textContent = '';
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const blob = xhr.response;
        const disposition = xhr.getResponseHeader('Content-Disposition') || '';
        const match = disposition.match(/filename="([^"]+)"/);
        const name = match ? match[1] : file.name.replace(/\.[^/.]+$/, '') + '_stretched.mp4';
        log(`[${index + 1}/${total}] Done: ${name} (${(blob.size / 1048576).toFixed(2)} MB)`, 'success');
        resolve({ name, blob });
      } else {
        // error responses come back as JSON blobs since responseType is 'blob'
        const reader = new FileReader();
        reader.onload = () => {
          let message = `HTTP ${xhr.status}`;
          try {
            const parsed = JSON.parse(reader.result);
            message = parsed.error || message;
            if (parsed.detail) log(`Server detail: ${parsed.detail}`, 'error');
          } catch (e) { /* not JSON, use default message */ }
          log(`[${index + 1}/${total}] Export failed: ${message}`, 'error');
          resolve({ name: null, blob: null });
        };
        reader.readAsText(xhr.response);
      }
    };

    xhr.onerror = () => {
      log(`[${index + 1}/${total}] Network error reaching the export server. If it's been idle a while, it may be waking up — try again in ~30-60s.`, 'error');
      resolve({ name: null, blob: null });
    };

    xhr.ontimeout = () => {
      log(`[${index + 1}/${total}] Request timed out.`, 'error');
      resolve({ name: null, blob: null });
    };

    // large files + cold-start server can legitimately take a while
    xhr.timeout = 5 * 60 * 1000; // 5 minutes

    xhr.send(formData);
  });
}

log('StretchTok initialized. Export engine: server-side ffmpeg via Cloudflare Worker.', 'sys');
log('Note: first export after idle time may be slow (~30-60s) while the free-tier server wakes up.', 'info');

