# Application Setup & Video Downloader Architecture

A comprehensive guide on setting up, running, and understanding the video downloader architecture in this Electron desktop application.

---

## 📋 Table of Contents
1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Setup & Installation](#3-setup--installation)
4. [Running the Application](#4-running-the-application)
5. [Configuration (`env-variables.json`)](#5-configuration)
6. [High-Level Architecture: How the Video Downloader Works](#6-high-level-architecture-how-the-video-downloader-works)
7. [Step-by-Step Download Pipeline](#7-step-by-step-download-pipeline)
8. [Codebase Map](#8-codebase-map)
9. [Troubleshooting & Common Commands](#9-troubleshooting--common-commands)

---

## 1. Overview

This is an **Electron-based desktop educational platform** that loads and displays web-based lecture content while providing native capabilities.

We added an automated **HLS Video Downloader with FFmpeg Remuxing** directly into the desktop client. It enables users to download live or recorded streaming lectures as clean, high-quality, fully synchronized **`.mp4`** video files.

---

## 2. Prerequisites

Ensure the following are installed on your Windows PC:
* **Node.js**: Version 18.x or 20.x+ recommended ([Download Node.js](https://nodejs.org/))
* **npm**: Installed automatically with Node.js
* **Windows OS**: Windows 10 or Windows 11 (64-bit)

---

## 3. Setup & Installation

### Step 1: Open the Project Directory
Open your terminal (PowerShell, Command Prompt, or VS Code terminal) and navigate to the project directory:
```powershell
cd "c:\Users\manish\Desktop\Test'\Source_Code"
```

### Step 2: Install Dependencies
Run `npm install` to install all project dependencies, including Electron and `ffmpeg-static`:
```powershell
npm install
```

> **Note on FFmpeg**: The application uses `ffmpeg-static`, which automatically bundles a standalone, pre-compiled `ffmpeg.exe` binary inside `node_modules/ffmpeg-static/`. No manual system installation or PATH setup for FFmpeg is required.

---

## 4. Running the Application

### Development Mode:
To launch the desktop application, run:
```powershell
npx electron .
```
Or if configured in `package.json`:
```powershell
npm start
```

### If an instance is already running:
If you see an error like `Process singleton: Lock file can not be created`, kill old instances first:
```powershell
taskkill /F /IM electron.exe
npx electron .
```

---

## 5. Configuration

The application behavior is controlled by [`env-variables.json`](./env-variables.json):

```json
{
  "domain": "https://dsfvzfvgbhcfgnh.akamai.net.in",
  "version": "1",
  "splash_delay": 2000,
  "disableCache": 0,
  "isDev": 1
}
```

* **`domain`**: The base web application URL rendered inside the Electron window.
* **`isDev`**: Set to `1` for development (enables Chrome DevTools, window controls). Set to `0` for production kiosk mode.
* **`disableCache`**: When set to `1`, clears user session cache on startup.

---

## 6. High-Level Architecture: How the Video Downloader Works

Modern video streaming platforms do not serve videos as a single `.mp4` link. Instead, they use **HTTP Live Streaming (HLS)**:
* A master playlist (`.m3u8`) indexes variant resolutions (360p, 480p, 720p).
* A media playlist (`.m3u8`) indexes hundreds of individual encrypted/signed transport stream chunks (`.ts`), each lasting 6–12 seconds.
* CDN security checks authenticate requests using dynamic tokens (`?edge-cache-token=...`) and HTTP headers (`Referer`, `Origin`, `User-Agent`).

### Architecture Flow Diagram:

```
┌─────────────────────────────────────────────────────────────┐
│                     Electron Web Window                     │
│  User plays video  ──>  Page requests HLS streams (.m3u8)   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                [Network & Header Interception]
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     Electron Main Process                   │
│                                                             │
│  1. Captures M3U8 URL & dynamic CDN tokens                  │
│  2. Captures exact browser headers (Referer, Origin, etc.)  │
│  3. Injects Always-Visible Download Button & Ctrl+D listener│
└──────────────────────────────┬──────────────────────────────┘
                               │ User clicks "DOWNLOAD VIDEO"
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 5-Stage Downloader Pipeline                 │
│                                                             │
│  [Stage 1] Fetch full .m3u8 playlist with credentials       │
│  [Stage 2] Resolve all .ts URLs + inherit security tokens   │
│  [Stage 3] Concurrent Worker Pool (6 parallel downloads)    │
│  [Stage 4] FFmpeg Lossless Remux & Audio Synchronization    │
│  [Stage 5] Final MP4 output with +faststart optimization    │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│               Final Output: Clean, Synced MP4               │
│          Saved to: C:\Users\<Username>\Downloads\*.mp4      │
└─────────────────────────────────────────────────────────────┘
```

---

## 7. Step-by-Step Download Pipeline

### 1. Network Interception (`app-process.js`)
* Electron's `session.defaultSession.webRequest.onBeforeRequest` continuously monitors network traffic.
* Whenever the video player requests an `.m3u8` playlist, the URL and its signed authentication token (`edge-cache-token`) are preserved.
* `onBeforeSendHeaders` records the exact `Referer` and `Origin` headers the browser sent.

### 2. User Trigger & Save Dialog
* A prominent floating **"DOWNLOAD VIDEO"** button (or keyboard shortcut **`Ctrl+D`**) is injected into the window via `preload.js`.
* When clicked, Electron displays a native Windows **"Save As"** dialog defaulting to `.mp4`.

### 3. Authenticated Playlist Fetching
* The main process fetches the `.m3u8` playlist using Electron's native `net` stack, attaching the captured `Referer: https://...` and `User-Agent`.
* If a master playlist is detected, it automatically selects the highest resolution stream (e.g. 720p/480p).
* The playlist is parsed into a complete list of all `.ts` segment URLs (often 300+ segments for a full 1–2 hour lecture).
* Each segment URL automatically inherits the security token parameters.

### 4. Fast Concurrent Segment Streaming
* A concurrency pool of **6 parallel workers** streams the `.ts` chunks simultaneously into a temporary folder (`%TEMP%/vdl_<timestamp>/`).
* Each failed segment is automatically retried up to 3 times with exponential backoff.
* Real-time progress is sent via IPC to the UI toast (`Downloading: 45/358 segments (13%)`) and Windows taskbar.

### 5. FFmpeg Remuxing (Eliminating Video/Audio Corruption)
Once all segments are downloaded, **FFmpeg** runs:
```bash
ffmpeg -y -f concat -safe 0 -i concat.txt -c:v copy -c:a aac -b:a 192k -ar 44100 -movflags +faststart output.mp4
```
* **`-c:v copy` (Lossless Video)**: Copies the video stream directly without re-encoding, preserving 100% original visual quality at maximum speed.
* **`-c:a aac -b:a 192k -ar 44100` (Clean Synced Audio)**: Re-encodes audio into standard AAC stereo at 44.1 kHz, correcting all timestamp discontinuities, clock drift, and audio squeaks.
* **`-movflags +faststart`**: Relocates the MP4 index (`moov` atom) to the beginning of the file, allowing instant playback and seeking in Windows Media Player, VLC, and mobile devices.
* **Cleanup**: All temporary `.ts` files and staging folders are automatically purged after remuxing.

---

## 8. Codebase Map

| File | Purpose |
| :--- | :--- |
| [`main.js`](./main.js) | Application entry point, lifecycle events, process-killing filters, and display management. |
| [`main/app-process.js`](./main/app-process.js) | Main browser window creation, network interceptors, HLS downloader, FFmpeg remuxing, and IPC handlers. |
| [`main/preload/preload.js`](./main/preload/preload.js) | Preload bridge, UI injection (floating download button, progress toast, Ctrl+D hotkey). |
| [`env-variables.json`](./env-variables.json) | Domain endpoint and environment configuration. |
| [`package.json`](./package.json) | Project metadata, scripts, and dependencies (e.g. `ffmpeg-static`). |

---

## 9. Troubleshooting & Common Commands

### Kill Hanging Electron Instances:
If the app does not start due to an existing running process:
```powershell
taskkill /F /IM electron.exe
```

### Allowing Screenshots / Snipping Tool:
The default codebase contained anti-recording restrictions (`setContentProtection(true)` and killing `snippingtool`). In [`main/app-process.js`](./main/app-process.js), `setContentProtection` is disabled, and in [`main.js`](./main.js), `snippingtool` and `record` have been removed from the kill list so you can take screenshots normally.

### Supported Video Formats:
* **HLS Streams (`.m3u8` / `.ts`)**: Converted into standard, synchronized `.mp4`.
* **Direct Video (`.mp4`, `.webm`)**: Downloaded directly via authenticated streaming.
