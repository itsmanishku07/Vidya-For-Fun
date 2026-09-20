/* global __dirname */

// main/app-process.js
const { BrowserWindow, app, ipcMain, dialog, session, net } = require("electron");
const path = require("path");
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const envVariables = require('../env-variables');

const window_setting = {
//    titleBarStyle: 'hidden',
    show: false,
    autoHideMenuBar: true,
    frame: false,
//    kiosk: true,
//    resizable: false,
    title: "Login Page",
    icon: path.join(__dirname, '../assets/images/app_icon.png'),
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

    // --- 6. Helper: Send completion to renderer ---
    function sendComplete(success, detail) {
        isDownloading = false;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setProgressBar(-1);
            if (success) {
                mainWindow.webContents.send('download-complete', { success: true, path: detail });
            } else {
                mainWindow.webContents.send('download-complete', { success: false, error: detail });
            }
        }
    }

    // --- 7. Download all segments concurrently ---
    async function downloadAllSegments(segments, tempDir) {
        let completed = 0;
        let failed = 0;
        const total = segments.length;
        const concurrency = 6;
        let nextIndex = 0;

        async function worker() {
            while (nextIndex < total) {
                const i = nextIndex++;
                const segUrl = segments[i];
                const segPath = path.join(tempDir, 'seg_' + String(i).padStart(5, '0') + '.ts');

                let success = false;
                for (let attempt = 0; attempt < 3; attempt++) {
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

                if (success) {
                    completed++;
                } else {
                    failed++;
                    console.error('[HLS Downloader] Segment ' + i + ' permanently failed');
                }

                const currentDone = completed + failed;
                const percent = Math.round((currentDone / total) * 88);
                sendProgress(percent, `Downloading: ${currentDone}/${total} segments (${Math.round((currentDone / total) * 100)}%)`);

                if (currentDone % 20 === 0 || currentDone === total) {
                    console.log(`[HLS Downloader] Progress: ${currentDone}/${total} (${percent}%)`);
                }
            }
        }

        const workers = [];
        for (let w = 0; w < Math.min(concurrency, total); w++) {
            workers.push(worker());
        }
        await Promise.all(workers);
        return { completed, failed, total };
    }

    // --- 8. Remux downloaded segments using FFmpeg into a clean MP4 ---
    function remuxWithFFmpeg(tempDir, segmentCount, savePath) {
        return new Promise((resolve, reject) => {
            sendProgress(92, 'Finalizing video (remuxing to clean MP4 with FFmpeg)...');
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
                return reject(new Error('No valid segments to remux'));
            }

            fs.writeFileSync(concatFile, fileLines.join('\n'));
            console.log(`[FFmpeg] Concat list ready with ${fileLines.length} segments. Running ffmpeg...`);

            // Output clean MP4: copy video stream losslessly, clean audio re-encode to AAC
            const args = [
                '-y',
                '-f', 'concat',
                '-safe', '0',
                '-i', concatFile,
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-ar', '44100',
                '-movflags', '+faststart',
                savePath
            ];

            const ff = spawn(ffmpegPath, args);
            let stderr = '';

            ff.stderr.on('data', d => {
                stderr += d.toString();
            });

            ff.on('error', err => {
                console.error('[FFmpeg] Failed to spawn:', err);
                reject(err);
            });

            ff.on('close', code => {
                if (code === 0 && fs.existsSync(savePath) && fs.statSync(savePath).size > 0) {
                    console.log('[FFmpeg] ✅ Remux successful! File size:', fs.statSync(savePath).size, 'bytes');
                    resolve(savePath);
                } else {
                    console.error('[FFmpeg] Remux failed with code:', code, stderr.slice(-400));
                    reject(new Error(`FFmpeg remuxing failed with code ${code}`));
                }
            });
        });
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

            // Step 2: Parse segment URLs
            const tokenQuery = playlistUrl.includes('?') ? playlistUrl.substring(playlistUrl.indexOf('?')) : '';
            const segments = [];

            for (const line of lines) {
                if (!line.startsWith('#')) {
                    let segUrl = line.startsWith('http') ? line : baseUrl + line;
                    // Append edge-cache-token query string if not present
                    if (!segUrl.includes('?') && tokenQuery) {
                        segUrl += tokenQuery;
                    }
                    segments.push(segUrl);
                }
            }

            console.log(`[HLS Downloader] Total segments in playlist: ${segments.length}`);

            if (segments.length === 0) {
                throw new Error('No video segments found in the playlist');
            }

            // Step 3: Download all segments
            sendProgress(5, `Starting download of ${segments.length} segments...`);
            const downloadResult = await downloadAllSegments(segments, tempDir);

            if (downloadResult.completed === 0) {
                throw new Error('Failed to download video segments');
            }

            // Step 4: Remux all segments into clean MP4 with FFmpeg
            await remuxWithFFmpeg(tempDir, segments.length, savePath);

            // Step 5: Clean up temp directory
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {}

            console.log('[HLS Downloader] ✅ Complete and saved to:', savePath);
            sendComplete(true, savePath);

        } catch (error) {
            console.error('[HLS Downloader] Error:', error.message);
            // Clean up temp directory on error
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {}
            sendComplete(false, error.message);
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
            return { success: false, error: 'A download is already in progress. Please wait.' };
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

    mainWindow.on('closed', function () {
        mainWindow = null;

        if (lastFocusedWindow === mainWindow) {
            lastFocusedWindow = null;
        }
    });
}

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