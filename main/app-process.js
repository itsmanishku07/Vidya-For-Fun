/* global __dirname */

// main/app-process.js
const { BrowserWindow, app, ipcMain, dialog, session, net } = require("electron");
const path = require("path");
const fs = require('fs');
const { spawn } = require('child_process');
const rawFfmpegPath = require('ffmpeg-static');
const ffmpegPath = rawFfmpegPath ? rawFfmpegPath.replace('app.asar', 'app.asar.unpacked') : null;

const envVariables = require('../env-variables');

const window_setting = {
//    titleBarStyle: 'hidden',
    show: false,
    autoHideMenuBar: true,
    frame: true, // Standard window frame with Minimize, Maximize, and Close (X) buttons
    title: "Vidya Education",
    icon: path.join(__dirname, '../images/app_icon.ico'),
    webPreferences: {
        devTools: envVariables.isDev === 1 ? true : false,
        contextIsolation: true,
        nodeIntegration: true,
        plugins: true
    }
};

var mainWindow = null;
let lastFocusedWindow = null;

// --- Video Download Feature State ---
let capturedVideoUrls = [];
let latestPlaylistUrl = null;
let lastMediaHeaders = {};
let isDownloading = false;
let cancelDownloadRequested = false;
let activeFFmpegProcess = null;

async function createAppWindow() {
    console.log(path.join(__dirname, "preload/preload.js"));
    window_setting.webPreferences.preload = path.join(__dirname, "preload/preload.js");
    mainWindow = new BrowserWindow(window_setting);
    // mainWindow.setContentProtection(true); // Disabled to allow screenshots
    mainWindow.loadURL(envVariables.domain);
    mainWindow.once('ready-to-show', async () => {
        mainWindow.show();
        if (envVariables.isDev === 1) {
            mainWindow.webContents.openDevTools();
        }
    });

    // --- 1. Intercept network requests to capture video/media URLs ---
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
        const url = details.url;
        const isM3u8 = /\.m3u8(\?|#|$)/i.test(url);
        const isMedia = details.resourceType === 'media' ||
            /\.(mp4|webm|mkv|m3u8|mpd|ts|m4s|mov|avi|flv|m4v|3gp)(\?|#|$)/i.test(url) ||
            /\/(video|media|stream|chunk|segment|playlist|manifest)\//i.test(url);

        if (isM3u8) {
            latestPlaylistUrl = url;
            console.log('[Video Capture] ⭐ Captured M3U8 Playlist URL:', url.substring(0, 160));
        }

        if (isMedia && !url.startsWith('blob:') && !url.startsWith('data:') && !url.startsWith('chrome:')) {
            if (!capturedVideoUrls.includes(url)) {
                capturedVideoUrls.push(url);
                if (capturedVideoUrls.length > 200) {
                    capturedVideoUrls = capturedVideoUrls.slice(-200);
                }
                console.log('[Video Capture] Detected media URL:', url.substring(0, 140));
            }
        }
        callback({});
    });

    // --- 2. Intercept request headers to capture Referer, Origin, User-Agent ---
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
        if (/\.(m3u8|ts|mpd|mp4)/i.test(details.url) || details.url.includes('classx.co.in') || details.url.includes('akamai')) {
            lastMediaHeaders = { ...details.requestHeaders };
        }
        callback({ requestHeaders: details.requestHeaders });
    });

    // --- 3. IPC: Return captured media URLs and latest playlist to renderer ---
    ipcMain.handle('get-captured-urls', () => {
        return {
            playlistUrl: latestPlaylistUrl,
            urls: [...capturedVideoUrls]
        };
    });

    // --- 3b. IPC: Cancel active video download ---
    ipcMain.handle('cancel-download', () => {
        if (!isDownloading) return { success: false, message: 'No download in progress' };
        console.log('[Video Download] Cancel requested by user.');
        cancelDownloadRequested = true;
        if (activeFFmpegProcess) {
            try {
                activeFFmpegProcess.kill('SIGKILL');
            } catch (e) {}
            activeFFmpegProcess = null;
        }
        return { success: true };
    });

    // --- 4. Helper: fetch URL using Electron's net with authentication headers ---
    function netFetch(url, customHeaders = {}) {
        return new Promise((resolve, reject) => {
            const request = net.request({
                url: url,
                session: session.defaultSession
            });

            // Base headers required by protected CDNs
            const defaultReferer = envVariables.domain.endsWith('/') ? envVariables.domain : envVariables.domain + '/';
            const headersToSend = {
                'User-Agent': lastMediaHeaders['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': lastMediaHeaders['Referer'] || defaultReferer,
                'Origin': lastMediaHeaders['Origin'] || envVariables.domain,
                ...customHeaders
            };

            for (const [k, v] of Object.entries(headersToSend)) {
                if (v && !['host', 'content-length'].includes(k.toLowerCase())) {
                    try { request.setHeader(k, v); } catch (e) {}
                }
            }

            const chunks = [];
            request.on('response', (response) => {
                if (response.statusCode >= 400) {
                    reject(new Error(`HTTP ${response.statusCode}`));
                    return;
                }
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => resolve(Buffer.concat(chunks)));
                response.on('error', reject);
            });
            request.on('error', reject);
            request.end();
        });
    }

    // --- 5. Helper: Send progress to renderer ---
    function sendProgress(percent, message) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-progress', { percent, message });
            mainWindow.setProgressBar(Math.max(0, percent / 100));
        }
    }

    // --- 6. Helper: Send completion or cancellation to renderer ---
    function sendComplete(success, detail, isCancelled = false) {
        isDownloading = false;
        cancelDownloadRequested = false;
        activeFFmpegProcess = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setProgressBar(-1);
            if (isCancelled) {
                mainWindow.webContents.send('download-complete', { success: false, cancelled: true, message: detail || 'Download cancelled' });
            } else if (success) {
                mainWindow.webContents.send('download-complete', { success: true, path: detail });
            } else {
                mainWindow.webContents.send('download-complete', { success: false, error: detail });
            }
        }
    }

    // --- 7. Download all segments concurrently with real-time ETA ---
    async function downloadAllSegments(segments, tempDir) {
        let completed = 0;
        let failed = 0;
        const total = segments.length;
        const concurrency = 6;
        let nextIndex = 0;
        const downloadStartTime = Date.now();

        async function worker() {
            while (nextIndex < total && !cancelDownloadRequested) {
                const i = nextIndex++;
                const segUrl = segments[i];
                const segPath = path.join(tempDir, 'seg_' + String(i).padStart(5, '0') + '.ts');

                let success = false;
                for (let attempt = 0; attempt < 3; attempt++) {
                    if (cancelDownloadRequested) break;
                    try {
                        const data = await netFetch(segUrl);
                        if (data && data.length > 0) {
                            fs.writeFileSync(segPath, data);
                            success = true;
                            break;
                        }
                    } catch (err) {
                        await new Promise(r => setTimeout(r, 600));
                    }
                }

                if (cancelDownloadRequested) break;

                if (success) {
                    completed++;
                } else {
                    failed++;
                    console.error('[HLS Downloader] Segment ' + i + ' permanently failed');
                }

                const currentDone = completed + failed;
                const elapsedSec = (Date.now() - downloadStartTime) / 1000;
                let etaStr = '';
                if (elapsedSec > 1.5 && currentDone > 3) {
                    const segPerSec = currentDone / elapsedSec;
                    const remSec = Math.ceil((total - currentDone) / segPerSec);
                    if (remSec < 60) {
                        etaStr = ` • ~${remSec}s left`;
                    } else {
                        const m = Math.floor(remSec / 60);
                        const s = remSec % 60;
                        etaStr = ` • ~${m}m ${s}s left`;
                    }
                }

                // Download phase covers 5% to 80%
                const overallPercent = Math.min(80, Math.round(5 + ((currentDone / total) * 75)));
                const dlPercent = Math.round((currentDone / total) * 100);
                sendProgress(overallPercent, `Downloading: ${currentDone}/${total} segments (${dlPercent}%)${etaStr}`);

                if (currentDone % 25 === 0 || currentDone === total) {
                    console.log(`[HLS Downloader] Progress: ${currentDone}/${total} (${dlPercent}%)${etaStr}`);
                }
            }
        }

        const workers = [];
        for (let w = 0; w < Math.min(concurrency, total); w++) {
            workers.push(worker());
        }
        await Promise.all(workers);

        if (cancelDownloadRequested) {
            throw new Error('DOWNLOAD_CANCELLED');
        }

        return { completed, failed, total };
    }

    // --- Helper: Run an FFmpeg pass with live speed and ETA reporting ---
    function runFFmpegPass(args, totalDurationSeconds, statusPrefix, savePath) {
        return new Promise((resolve, reject) => {
            if (cancelDownloadRequested) {
                return reject(new Error('DOWNLOAD_CANCELLED'));
            }

            const ff = spawn(ffmpegPath, args);
            activeFFmpegProcess = ff;
            let stderr = '';
            let buffer = '';
            let lastUpdate = 0;
            const startTime = Date.now();

            ff.stdout.on('data', chunk => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep last incomplete line

                let outTimeUs = null;
                let speedStr = null;

                for (const l of lines) {
                    const parts = l.trim().split('=');
                    if (parts[0] === 'out_time_us') outTimeUs = parseInt(parts[1]);
                    if (parts[0] === 'speed') speedStr = parts[1] ? parts[1].trim() : null;
                }

                if (outTimeUs !== null && !isNaN(outTimeUs) && totalDurationSeconds > 0) {
                    const now = Date.now();
                    if (now - lastUpdate > 300) { // update ~3 times per second
                        lastUpdate = now;
                        const processedSec = outTimeUs / 1000000;
                        const fraction = Math.min(0.99, Math.max(0, processedSec / totalDurationSeconds));
                        const overallPercent = Math.min(98, Math.round(80 + (fraction * 18)));
                        const remuxPct = Math.round(fraction * 100);

                        let speed = speedStr ? parseFloat(speedStr) : 0;
                        if (!speed || isNaN(speed) || speed <= 0) {
                            const elapsed = (now - startTime) / 1000;
                            if (elapsed > 0.4 && processedSec > 0) speed = processedSec / elapsed;
                        }

                        let etaStr = '';
                        if (speed > 0) {
                            const remainingSec = Math.max(0, totalDurationSeconds - processedSec);
                            const etaSec = Math.ceil(remainingSec / speed);
                            if (etaSec < 60) {
                                etaStr = ` • ~${etaSec}s left`;
                            } else {
                                const m = Math.floor(etaSec / 60);
                                const s = etaSec % 60;
                                etaStr = ` • ~${m}m ${s}s left`;
                            }
                        }

                        const speedDisplay = speed > 0 ? ` (${speed.toFixed(0)}x speed)` : '';
                        const msg = `${statusPrefix}: ${remuxPct}%${etaStr}${speedDisplay}`;
                        sendProgress(overallPercent, msg);
                    }
                }
            });

            ff.stderr.on('data', d => {
                stderr += d.toString();
            });

            ff.on('error', err => {
                reject(err);
            });

            ff.on('close', code => {
                activeFFmpegProcess = null;
                if (cancelDownloadRequested) {
                    return reject(new Error('DOWNLOAD_CANCELLED'));
                }
                if (code === 0 && fs.existsSync(savePath) && fs.statSync(savePath).size > 0) {
                    resolve(savePath);
                } else {
                    reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-300)}`));
                }
            });
        });
    }

    // --- 8. Remux downloaded segments with Ultra-Fast Stream Copy (~3-6 seconds) ---
    async function remuxWithFFmpeg(tempDir, segmentCount, savePath, totalDurationSeconds) {
        sendProgress(80, 'Finalizing video (fast stream copy)...');
        console.log('[FFmpeg] Preparing concat list...');

        const concatFile = path.join(tempDir, 'concat.txt');
        const fileLines = [];
        for (let i = 0; i < segmentCount; i++) {
            const segFile = path.join(tempDir, 'seg_' + String(i).padStart(5, '0') + '.ts').replace(/\\/g, '/');
            if (fs.existsSync(segFile) && fs.statSync(segFile).size > 0) {
                fileLines.push(`file '${segFile}'`);
            }
        }

        if (fileLines.length === 0) {
            throw new Error('No valid segments to remux');
        }

        fs.writeFileSync(concatFile, fileLines.join('\n'));
        console.log(`[FFmpeg] Concat list ready with ${fileLines.length} segments.`);

        // Strategy 1: Ultra-Fast Stream Copy (instant, 0% CPU re-encode, ~3-6 seconds)
        const fastArgs = [
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', concatFile,
            '-c', 'copy',
            '-bsf:a', 'aac_adtstoasc',
            '-avoid_negative_ts', 'make_zero',
            '-fflags', '+genpts+discardcorrupt',
            '-progress', 'pipe:1',
            savePath
        ];

        try {
            console.log('[FFmpeg] Running Strategy 1: Ultra-Fast Copy Remux...');
            await runFFmpegPass(fastArgs, totalDurationSeconds, 'Finalizing MP4', savePath);
            console.log('[FFmpeg] ✅ Ultra-Fast remux successful! File size:', fs.statSync(savePath).size, 'bytes');
            return savePath;
        } catch (fastErr) {
            console.warn('[FFmpeg] Strategy 1 failed, falling back to safe re-encode:', fastErr.message);

            // Strategy 2: Safe Re-encode Fallback (guaranteed compatibility for unusual audio codecs)
            const fallbackArgs = [
                '-y',
                '-f', 'concat',
                '-safe', '0',
                '-i', concatFile,
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-ar', '44100',
                '-progress', 'pipe:1',
                savePath
            ];
            await runFFmpegPass(fallbackArgs, totalDurationSeconds, 'Finalizing MP4 (Safe Mode)', savePath);
            return savePath;
        }
    }

    // --- 9. HLS Stream Downloader Pipeline ---
    async function downloadHLSWithFFmpeg(targetM3u8Url, savePath) {
        const tempDir = path.join(app.getPath('temp'), 'vdl_' + Date.now());
        try {
            fs.mkdirSync(tempDir, { recursive: true });
            console.log('[HLS Downloader] Temp dir created:', tempDir);
            sendProgress(2, 'Fetching video playlist...');

            // Step 1: Fetch the m3u8 playlist with browser credentials/referer
            let playlistUrl = targetM3u8Url;
            let playlistBuffer = await netFetch(playlistUrl);
            let playlistContent = playlistBuffer.toString('utf8');
            let lines = playlistContent.split('\n').map(l => l.trim()).filter(Boolean);
            let baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);

            // If it's a master playlist, find the best media stream
            if (playlistContent.includes('#EXT-X-STREAM-INF')) {
                console.log('[HLS Downloader] Master playlist detected, selecting best stream quality...');
                let bestUrl = '';
                let bestBandwidth = 0;
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                        const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                        const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;
                        for (let j = i + 1; j < lines.length; j++) {
                            if (!lines[j].startsWith('#')) {
                                if (bandwidth >= bestBandwidth) {
                                    bestBandwidth = bandwidth;
                                    bestUrl = lines[j].startsWith('http') ? lines[j] : baseUrl + lines[j];
                                }
                                break;
                            }
                        }
                    }
                }

                if (bestUrl) {
                    // Carry over query tokens if variant URL doesn't have them
                    if (!bestUrl.includes('?') && playlistUrl.includes('?')) {
                        bestUrl += playlistUrl.substring(playlistUrl.indexOf('?'));
                    }
                    console.log('[HLS Downloader] Selected stream URL:', bestUrl);
                    playlistUrl = bestUrl;
                    playlistBuffer = await netFetch(playlistUrl);
                    playlistContent = playlistBuffer.toString('utf8');
                    lines = playlistContent.split('\n').map(l => l.trim()).filter(Boolean);
                    baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
                }
            }

            // Step 2: Parse segment URLs and total video duration
            const tokenQuery = playlistUrl.includes('?') ? playlistUrl.substring(playlistUrl.indexOf('?')) : '';
            const segments = [];
            let totalDurationSeconds = 0;

            for (const line of lines) {
                if (line.startsWith('#EXTINF:')) {
                    const m = line.match(/#EXTINF:([\d.]+)/);
                    if (m) totalDurationSeconds += parseFloat(m[1]);
                }
                if (!line.startsWith('#')) {
                    let segUrl = line.startsWith('http') ? line : baseUrl + line;
                    // Append edge-cache-token query string if not present
                    if (!segUrl.includes('?') && tokenQuery) {
                        segUrl += tokenQuery;
                    }
                    segments.push(segUrl);
                }
            }

            if (totalDurationSeconds === 0) {
                totalDurationSeconds = segments.length * 10; // estimate ~10s per segment if not in headers
            }

            console.log(`[HLS Downloader] Total segments in playlist: ${segments.length}, estimated duration: ${Math.round(totalDurationSeconds)}s`);

            if (segments.length === 0) {
                throw new Error('No video segments found in the playlist');
            }

            // Step 3: Download all segments
            sendProgress(5, `Starting download of ${segments.length} segments...`);
            const downloadResult = await downloadAllSegments(segments, tempDir);

            if (downloadResult.completed === 0) {
                throw new Error('Failed to download video segments');
            }

            // Step 4: Remux all segments into clean MP4 with live progress & ETA
            await remuxWithFFmpeg(tempDir, segments.length, savePath, totalDurationSeconds);

            // Step 5: Clean up temp directory
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {}

            console.log('[HLS Downloader] ✅ Complete and saved to:', savePath);
            sendComplete(true, savePath);

        } catch (error) {
            console.error('[HLS Downloader] Status/Error:', error.message);
            // Clean up temp directory on error or cancel
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {}

            // Remove partial output file if cancelled
            if ((cancelDownloadRequested || error.message === 'DOWNLOAD_CANCELLED') && fs.existsSync(savePath)) {
                try { fs.unlinkSync(savePath); } catch (e) {}
            }

            if (cancelDownloadRequested || error.message === 'DOWNLOAD_CANCELLED') {
                console.log('[HLS Downloader] Download cancelled by user, cleaned up.');
                sendComplete(false, 'Download cancelled by user', true);
            } else {
                sendComplete(false, error.message);
            }
        }
    }

    // --- 10. Direct Media File Downloader (for MP4/WebM) ---
    async function downloadDirectVideo(url, savePath) {
        try {
            sendProgress(10, 'Downloading video file...');
            const data = await netFetch(url);
            fs.writeFileSync(savePath, data);
            sendComplete(true, savePath);
        } catch (error) {
            console.error('[Direct Download] Error:', error.message);
            sendComplete(false, error.message);
        }
    }

    // --- 11. IPC: Trigger a video download ---
    ipcMain.handle('download-video', async (event, url) => {
        if (isDownloading) {
            return { success: false, error: 'A download is already in progress. Please wait or cancel it.' };
        }

        // Determine target URL (prefer latest playlist if available)
        let targetUrl = url;
        if (latestPlaylistUrl && (!targetUrl || /\.ts(\?|#|$)/i.test(targetUrl))) {
            targetUrl = latestPlaylistUrl;
        }
        if (!targetUrl && capturedVideoUrls.length > 0) {
            targetUrl = capturedVideoUrls.find(u => /\.m3u8/i.test(u)) || capturedVideoUrls[capturedVideoUrls.length - 1];
        }

        if (!targetUrl) {
            return { success: false, error: 'No video URL detected. Please play a video first.' };
        }

        console.log('[Video Download] Selected URL for download:', targetUrl);

        // Default name as .mp4
        let defaultName = 'Lecture_Video.mp4';
        try {
            const urlObj = new URL(targetUrl);
            let base = path.basename(urlObj.pathname).replace(/\.(m3u8|ts|mpd|webm)$/i, '');
            if (base && base.length > 2) {
                defaultName = base + '.mp4';
            }
        } catch (e) {}

        const savePath = dialog.showSaveDialogSync(mainWindow, {
            title: 'Save Video',
            defaultPath: path.join(app.getPath('downloads'), defaultName),
            filters: [
                { name: 'MP4 Video (*.mp4)', extensions: ['mp4'] },
                { name: 'All Files (*.*)', extensions: ['*'] }
            ]
        });

        if (!savePath) return { success: false, error: 'Cancelled' };

        // Ensure .mp4 extension
        let finalSavePath = savePath;
        if (!/\.mp4$/i.test(finalSavePath)) {
            finalSavePath += '.mp4';
        }

        isDownloading = true;
        cancelDownloadRequested = false;
        activeFFmpegProcess = null;

        const isHLS = /\.m3u8(\?|#|$)/i.test(targetUrl) || (latestPlaylistUrl && targetUrl === latestPlaylistUrl);

        if (isHLS) {
            downloadHLSWithFFmpeg(targetUrl, finalSavePath);
            return { success: true, path: finalSavePath };
        } else {
            downloadDirectVideo(targetUrl, finalSavePath);
            return { success: true, path: finalSavePath };
        }
    });

    if (!mainWindow.isMaximized()) {
        mainWindow.maximize();
    }

    mainWindow.on("focus", () => {
        lastFocusedWindow = mainWindow;
    });

    mainWindow.on('close', function () {
        cancelDownloadRequested = true;
        if (activeFFmpegProcess) {
            try {
                activeFFmpegProcess.kill('SIGKILL');
            } catch (e) {}
            activeFFmpegProcess = null;
        }
    });

    mainWindow.on('closed', function () {
        mainWindow = null;

        if (lastFocusedWindow === mainWindow) {
            lastFocusedWindow = null;
        }
    });
}

// Ensure clean termination on quit
app.on('before-quit', () => {
    cancelDownloadRequested = true;
    if (activeFFmpegProcess) {
        try {
            activeFFmpegProcess.kill('SIGKILL');
        } catch (e) {}
        activeFFmpegProcess = null;
    }
});

// Ensure only a single instance runs
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (lastFocusedWindow) {
            if (lastFocusedWindow.isMinimized()) {
                lastFocusedWindow.restore();
            }
            lastFocusedWindow.focus();
        }
    });
}

module.exports = {
    createAppWindow
};