const si = require('systeminformation');
const storage = require('electron-json-storage-sync');
const { contextBridge, ipcRenderer } = require('electron');
const { disableCache } = require('../../env-variables'); 

if (disableCache) {
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
        if (key == "current_user") {
            localStorage.removeItem(key);
        }
    });
}

si.baseboard()
    .then((data) => {
        const motherboardId = data.serial;
        contextBridge.exposeInMainWorld('get_guuid', motherboardId);
        //console.log(motherboardId);
    })
    .catch((error) => {
        //console.error(error);
        contextBridge.exposeInMainWorld('get_guuid', error);
    });

async function get_key(key) {
    let data = await storage.get(key);
    return data;
}

async function set_key(key, value) {
    return await storage.set(key, value);
}

async function remove_key(key) {
    return await storage.remove(key);
}

contextBridge.exposeInMainWorld('get_key', async (key) => {
    try {
        return await get_key(key);
    } catch (error) {
        console.error('Error retrieving key:', error);
    }
});

contextBridge.exposeInMainWorld('set_key', async (key, value) => {
    try {
        return await set_key(key,value);
    } catch (error) {
        console.error('Error retrieving key:', error);
    }
});

contextBridge.exposeInMainWorld('remove_key', async (key) => {
    try {
        return await remove_key(key);
    } catch (error) {
        console.error('Error retrieving key:', error);
    }
});

// =============================================================
// VIDEO DOWNLOAD FEATURE
// =============================================================

function initDownloadFeature() {
    // Prevent double-init
    if (document.getElementById('vdl-style-tag')) return;

    // --- Inject CSS styles ---
    const style = document.createElement('style');
    style.id = 'vdl-style-tag';
    style.textContent = `
        @keyframes vdl-pulse {
            0% { box-shadow: 0 0 8px rgba(0, 230, 118, 0.6), 0 0 20px rgba(0, 230, 118, 0.3); }
            50% { box-shadow: 0 0 20px rgba(0, 230, 118, 0.9), 0 0 50px rgba(0, 230, 118, 0.5); }
            100% { box-shadow: 0 0 8px rgba(0, 230, 118, 0.6), 0 0 20px rgba(0, 230, 118, 0.3); }
        }
        @keyframes vdl-bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-6px); }
        }

        #vdl-float-btn {
            position: fixed !important;
            bottom: 30px !important;
            right: 30px !important;
            z-index: 2147483647 !important;
            background: linear-gradient(135deg, #00E676, #00C853) !important;
            color: #000 !important;
            border: 3px solid #fff !important;
            border-radius: 50px !important;
            padding: 18px 32px !important;
            font-size: 18px !important;
            font-weight: 900 !important;
            font-family: Arial, Helvetica, sans-serif !important;
            cursor: pointer !important;
            display: flex !important;
            align-items: center !important;
            gap: 10px !important;
            animation: vdl-pulse 2s infinite ease-in-out, vdl-bounce 3s infinite ease-in-out !important;
            text-transform: uppercase !important;
            letter-spacing: 1.5px !important;
            visibility: visible !important;
            opacity: 1 !important;
            pointer-events: auto !important;
        }
        #vdl-float-btn:hover {
            transform: scale(1.12) !important;
            background: linear-gradient(135deg, #69F0AE, #00E676) !important;
            animation: vdl-pulse 0.8s infinite ease-in-out !important;
        }
        #vdl-float-btn:active {
            transform: scale(0.95) !important;
        }
        #vdl-float-btn svg {
            width: 28px !important;
            height: 28px !important;
            fill: #000 !important;
        }
        #vdl-float-btn.downloading {
            background: linear-gradient(135deg, #FFC107, #FF9800) !important;
            animation: vdl-pulse 1.5s infinite ease-in-out !important;
            cursor: wait !important;
        }

        #vdl-toast {
            position: fixed !important;
            bottom: 110px !important;
            right: 30px !important;
            z-index: 2147483647 !important;
            background: rgba(20, 20, 20, 0.96) !important;
            color: #fff !important;
            border-radius: 14px !important;
            padding: 18px 26px !important;
            font-size: 15px !important;
            font-family: Arial, sans-serif !important;
            box-shadow: 0 8px 32px rgba(0,0,0,0.6) !important;
            transform: translateY(120px) !important;
            opacity: 0 !important;
            transition: transform 0.4s ease, opacity 0.4s ease !important;
            max-width: 380px !important;
            border: 1px solid rgba(255,255,255,0.15) !important;
            pointer-events: none !important;
        }
        #vdl-toast.show {
            transform: translateY(0) !important;
            opacity: 1 !important;
        }
        #vdl-toast .t-title { font-weight: bold; margin-bottom: 6px; font-size: 16px; }
        #vdl-toast .t-progress { width:100%; height:6px; background:rgba(255,255,255,0.15); border-radius:3px; margin-top:10px; overflow:hidden; }
        #vdl-toast .t-bar { height:100%; background:linear-gradient(90deg,#00E676,#69F0AE); border-radius:3px; transition:width 0.3s; width:0%; }

        #vdl-hint {
            position: fixed !important;
            bottom: 80px !important;
            right: 42px !important;
            z-index: 2147483647 !important;
            color: rgba(255,255,255,0.6) !important;
            font-size: 12px !important;
            font-family: Arial, sans-serif !important;
            pointer-events: none !important;
            text-shadow: 0 1px 3px rgba(0,0,0,0.8) !important;
        }
    `;
    (document.head || document.documentElement).appendChild(style);

    // --- Toast functions ---
    function showToast(title, message, showProgress) {
        let t = document.getElementById('vdl-toast');
        if (t) t.remove();
        t = document.createElement('div');
        t.id = 'vdl-toast';
        t.innerHTML = '<div class="t-title">' + title + '</div><div class="t-msg">' + message + '</div>' +
            (showProgress ? '<div class="t-progress"><div class="t-bar"></div></div>' : '');
        document.body.appendChild(t);
        requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
    }
    function updateToastProgress(percent) {
        const t = document.getElementById('vdl-toast');
        if (!t) return;
        const bar = t.querySelector('.t-bar');
        const msg = t.querySelector('.t-msg');
        if (bar) bar.style.width = percent + '%';
        if (msg) msg.textContent = 'Downloading... ' + percent + '%';
    }
    function hideToast(delay) {
        setTimeout(() => {
            const t = document.getElementById('vdl-toast');
            if (t) { t.classList.remove('show'); setTimeout(() => { const t2 = document.getElementById('vdl-toast'); if (t2) t2.remove(); }, 500); }
        }, delay || 0);
    }

    // --- IPC listeners ---
    ipcRenderer.on('download-progress', (ev, data) => {
        updateToastProgress(data.percent);
        if (data.message) {
            const t = document.getElementById('vdl-toast');
            if (t) { const msg = t.querySelector('.t-msg'); if (msg) msg.textContent = data.message; }
        }
    });
    ipcRenderer.on('download-complete', (ev, data) => {
        if (data.success) {
            showToast('✅ Download Complete!', 'Saved to: ' + data.path, false);
        } else {
            showToast('❌ Download Failed', 'Error: ' + data.error, false);
        }
        hideToast(5000);
        const btn = document.getElementById('vdl-float-btn');
        if (btn) { btn.classList.remove('downloading'); const t = btn.querySelector('.vdl-btn-text'); if (t) t.textContent = 'DOWNLOAD VIDEO'; }
    });

    // --- Main download logic ---
    async function triggerDownload() {
        const btn = document.getElementById('vdl-float-btn');
        if (btn && btn.classList.contains('downloading')) return;

        let videoUrl = '';

        // 1. Try DOM video elements
        const videos = document.querySelectorAll('video');
        for (const v of videos) {
            const src = v.currentSrc || v.src;
            if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
                videoUrl = src;
                break;
            }
        }

        // 2. Always check network-captured URLs (this is the primary method)
        if (!videoUrl) {
            try {
                const captured = await ipcRenderer.invoke('get-captured-urls');
                console.log('[VDL] Captured from network:', captured);
                if (captured && typeof captured === 'object') {
                    if (captured.playlistUrl) {
                        videoUrl = captured.playlistUrl;
                    } else if (captured.urls && captured.urls.length > 0) {
                        const reversed = [...captured.urls].reverse();
                        const directUrl = reversed.find(u => /\.(mp4|webm|mkv|mov)(\?|#|$)/i.test(u));
                        const streamUrl = reversed.find(u => /\.(m3u8|mpd)(\?|#|$)/i.test(u));
                        videoUrl = streamUrl || directUrl || captured.urls[captured.urls.length - 1];
                    }
                } else if (Array.isArray(captured) && captured.length > 0) {
                    const reversed = [...captured].reverse();
                    const directUrl = reversed.find(u => /\.(mp4|webm|mkv|mov)(\?|#|$)/i.test(u));
                    const streamUrl = reversed.find(u => /\.(m3u8|mpd)(\?|#|$)/i.test(u));
                    videoUrl = streamUrl || directUrl || captured[captured.length - 1];
                }
            } catch (err) {
                console.error('[VDL] Error getting captured URLs:', err);
            }
        }

        if (!videoUrl) {
            showToast('⚠️ No Video Found', 'Play a video first, then click this button to download it.', false);
            hideToast(5000);
            return;
        }

        console.log('[VDL] Downloading:', videoUrl);

        if (btn) { btn.classList.add('downloading'); const t = btn.querySelector('.vdl-btn-text'); if (t) t.textContent = 'DOWNLOADING...'; }
        showToast('⬇️ Downloading Video', 'Opening save dialog...', true);

        try {
            const result = await ipcRenderer.invoke('download-video', videoUrl);
            if (!result.success) {
                if (btn) { btn.classList.remove('downloading'); const t = btn.querySelector('.vdl-btn-text'); if (t) t.textContent = 'DOWNLOAD VIDEO'; }
                if (result.error !== 'Cancelled') {
                    showToast('❌ Download Failed', result.error || 'Unknown error', false);
                    hideToast(3000);
                } else {
                    hideToast(0);
                }
            }
        } catch (err) {
            if (btn) { btn.classList.remove('downloading'); const t = btn.querySelector('.vdl-btn-text'); if (t) t.textContent = 'DOWNLOAD VIDEO'; }
            showToast('❌ Error', err.message, false);
            hideToast(3000);
        }
    }

    // --- Create/ensure floating button exists ---
    function ensureButton() {
        if (document.getElementById('vdl-float-btn')) return;
        if (!document.body) return;

        const btn = document.createElement('button');
        btn.id = 'vdl-float-btn';
        btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg><span class="vdl-btn-text">DOWNLOAD VIDEO</span>';
        document.body.appendChild(btn);
        btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); triggerDownload(); });

        const hint = document.createElement('div');
        hint.id = 'vdl-hint';
        hint.textContent = '';
        document.body.appendChild(hint);

        console.log('[VDL] ✅ Download button injected into page');
    }

    // --- Ctrl+D keyboard shortcut ---
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
            e.preventDefault();
            triggerDownload();
        }
    });

    // Ensure button exists now and keep re-injecting if page removes it
    ensureButton();
    setInterval(ensureButton, 1500);
    window.addEventListener('load', ensureButton);

    console.log('[VDL] ✅ Video Download feature ready. Button is ALWAYS visible. Shortcut: Ctrl+D');
}

// Initialize as soon as possible
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDownloadFeature);
} else {
    initDownloadFeature();
}
window.addEventListener('load', initDownloadFeature);
