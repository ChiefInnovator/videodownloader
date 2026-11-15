# Enhanced Downloader (companion helper)

YouTube video cannot be downloaded by a browser extension alone. This optional
Enhanced Downloader is a small native-messaging host that lets the extension hand a
YouTube URL to [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your computer.

- **Runs outside Chrome.** yt-dlp fetches the video and writes the file to
  `~/Downloads` (plus the extension's *Download subfolder* setting). It does
  not show in Chrome's download list.
- **YouTube only.** The host rejects every other URL.
- **Nothing else is sent anywhere.** The host talks only to the extension
  over stdin/stdout and to YouTube through yt-dlp. There is no telemetry.
- **Not in the Chrome Web Store build.** The store package
  (`scripts/package.sh --store`) omits the `nativeMessaging` permission, so
  this integration is off there.
- Only download videos you have the right to keep (your own uploads, or
  content whose licence allows it). YouTube's terms restrict downloading.

## Requirements

- Python 3.8+ (standard library only)
- yt-dlp: `brew install yt-dlp`, `pipx install yt-dlp`, or `winget install yt-dlp`
- ffmpeg (optional, needed for 1080p and above, which YouTube serves as
  separate video and audio streams): `brew install ffmpeg`

## Install

1. Find the extension ID: `chrome://extensions` → Video Downloader → **ID**
   (also shown in the extension's Settings).
2. Register the host:
   - macOS / Linux: `bash companion/install.sh <extension-id>`
   - Windows: `powershell -ExecutionPolicy Bypass -File companion\install.ps1 <extension-id>`
3. In the extension's **Settings**, under **Enhanced Downloader**, tick
   **Enable Enhanced Downloader**, approve Chrome's permission prompt, and
   click **Test connection**.

Keep the companion folder where it is after installing; the registration
points at it. Re-run the installer if you move the folder or the extension ID
changes (an unpacked extension's ID depends on its folder path).

Uninstall: `bash companion/install.sh --uninstall` (or `install.ps1 -Uninstall`).

## Use

Open a YouTube video (or a page with an embedded one), click the extension,
pick a quality under **Embedded Streams**, and click **Download**. Progress
shows in the popup; the finished file's path appears when done.

Optional: **Let yt-dlp use your Chrome sign-in** passes
`--cookies-from-browser chrome`, so yt-dlp can read Chrome's cookies for
age-restricted or members-only videos. On macOS this asks for Keychain access.
If yt-dlp cannot read the cookies (for example when macOS blocks the
Chrome-launched helper from Chrome's profile folder), the helper retries once
without them; the popup then says the download finished without your sign-in.
Videos that require sign-in still fail in that case.

## Protocol

Messages are native-messaging frames (4-byte little-endian length + JSON):

| Extension → host | Host → extension |
| --- | --- |
| `{"type":"probe"}` | `{"type":"probe","ok":true,"version":"1.0.0","ytdlp":"2026.10.26","ffmpeg":true}` |
| `{"type":"download","url":…,"quality":"best\|1080\|720\|480\|audio","subfolder":"","cookiesFromBrowser":false}` | `{"type":"progress","percent":42.0,"speed":"3.1MiB/s","eta":"00:12"}` … then `{"type":"done","file":"/abs/path.mp4","note"?:…}` or `{"type":"error","error":…}` |
| `{"type":"cancel"}` | `{"type":"error","cancelled":true,"error":"Cancelled"}` |

Host name: `com.inventingfire.videodownloader`. Set `VIDEODOWNLOADER_YTDLP`
to override the yt-dlp executable (used by the regression tests).
