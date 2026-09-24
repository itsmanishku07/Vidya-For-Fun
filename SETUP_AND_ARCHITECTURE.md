# Application Setup & Video Downloader Architecture

A comprehensive guide on setting up, building standalone Windows `.exe` files, and understanding the video downloader and live ETA architecture.

---

## 📋 Table of Contents
1. [Overview](#1-overview)
2. [Building Standalone `.exe` Files (No Setup Needed)](#2-building-standalone-exe-files-no-setup-needed)
3. [Running From Source (Development)](#3-running-from-source-development)
4. [High-Level Architecture](#4-high-level-architecture)
5. [Live Progress & Exact Time (ETA) Tracking](#5-live-progress--exact-time-eta-tracking)
6. [Codebase Map](#6-codebase-map)
7. [Troubleshooting & Common Questions](#7-troubleshooting--common-questions)

---

## 1. Overview

This is an **Electron-based desktop educational platform** that loads and displays web-based lecture content while providing native capabilities.

We added an automated **HLS Video Downloader with FFmpeg Remuxing** directly into the desktop client. It allows users to download streaming lectures as clean, high-quality, fully synchronized **`.mp4`** video files with **real-time progress, speed, and exact remaining time (ETA) countdowns**.

---

## 2. Building Standalone `.exe` Files (No Setup Needed)

You can generate standalone `.exe` files that can be copied to **any Windows 10/11 laptop** and run by double-clicking, with **zero configuration and no Node.js required**:

### To build the `.exe`:
```powershell
npm run build:exe
```

### Output Location:
📁 `Source_Code/release-builds/`

* **`Vidya Education 0.0.1.exe`** (~95 MB):  
  **Portable Standalone Executable**. Copy to any USB drive or send it to anyone. Double-click to launch immediately without installation.
* **`Vidya Education Setup 0.0.1.exe`** (~95 MB):  
  **Windows Installer**. Standard setup wizard that installs the app and creates a Desktop icon.

---

## 3. Running From Source (Development)

If you are developing or running the project directly with Node.js:

```powershell
npm install
npm start
```

* Node.js v18, v20, or v22 on Windows 10/11.
* Electron version: `v33.4.11` (stable release, compatible with pure JavaScript unzippers on Node 22).

---

## 4. High-Level Architecture

The video downloader pipeline operates across 5 coordinated stages:

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

## 5. Live Progress & Exact Time (ETA) Tracking

Both stages of the download pipeline track time and calculate remaining time dynamically:

### Stage 1: Segment Downloading (0% – 80%)
* **Rate Tracking**: Measures `segmentsDownloaded / elapsedTime`.
* **Dynamic Countdown**: Calculates `(totalSegments - currentDone) / rate`.
* **User UI**:
  ```text
  Downloading: 145/358 segments (40%) • ~38s left
  ```

### Stage 2: FFmpeg Remuxing (80% – 98%)
* **Total Video Duration**: Parsed directly from `#EXTINF:` tags in the `.m3u8` manifest (e.g. 7,030 seconds = 1h 57m 10s).
* **Live Microsecond Progress**: Uses FFmpeg's `-progress pipe:1` protocol to stream `out_time_us` and `speed` (e.g., `48x`).
* **Remaining Time Formula**:
  $$\text{ETA (seconds)} = \frac{\text{Total Duration} - \text{Processed Duration}}{\text{FFmpeg Processing Speed}}$$
* **User UI**:
  ```text
  Finalizing MP4: 65% • ~14s left (45x speed)
  ```
* **FastStart Finalization**:
  ```text
  Writing fast-start header (almost done, ~2-4s)...
  ```
* **Completion**:
  ```text
  ✅ Download Complete! Saved to: C:\Users\<User>\Downloads\Lecture.mp4
  ```

---

## 6. Codebase Map

| File | Purpose |
| :--- | :--- |
| [`main/app-process.js`](./main/app-process.js) | Network header interception, concurrent segment downloader, FFmpeg remuxing pipeline with live ETA calculation, and IPC handlers. |
| [`main/preload/preload.js`](./main/preload/preload.js) | Preload bridge, UI injection (floating download button, real-time progress & ETA toast, Ctrl+D hotkey). |
| [`main.js`](./main.js) | Main entry point, lifecycle events, and window management. |
| [`package.json`](./package.json) | Scripts (`build:exe`, `start`), dependencies, and `electron-builder` configuration. |
| [`env-variables.json`](./env-variables.json) | Base web platform domain URL. |

---

## 7. Troubleshooting & Common Questions

### How long does remuxing take?
Remuxing an entire 2-hour lecture takes approximately **20 to 45 seconds**. The app shows the live countdown (`~X s left`) and processing speed (`~45x speed`) so you always know exactly how much time remains.

### Can the output `.mp4` play everywhere?
Yes. It uses `-c:v copy` (100% original video frames preserved), `-c:a aac` (clean 44.1kHz stereo audio), and `-movflags +faststart` (web-optimized index at the front of the file). It opens instantly in Windows Media Player, VLC, QuickTime, iOS, Android, and web browsers.
