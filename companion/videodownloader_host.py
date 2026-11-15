#!/usr/bin/env python3
"""Video Downloader companion — Chrome native-messaging host for YouTube.

Chrome starts this process when the extension calls
chrome.runtime.connectNative('com.inventingfire.videodownloader') and talks
to it over stdin/stdout (4-byte little-endian length + UTF-8 JSON).

Messages from the extension:
  {"type": "probe"}
      -> {"type": "probe", "ok": true, "version": ..., "ytdlp": ..., "ffmpeg": bool}
  {"type": "download", "url": ..., "quality": "best|1080|720|480|audio",
   "subfolder": "", "cookiesFromBrowser": false}
      -> {"type": "progress", "percent": float, "speed": str, "eta": str} ...
      -> {"type": "done", "file": "/abs/path", "note"?: str} | {"type": "error", "error": str}
  {"type": "cancel"}
      -> stops the running download ({"type": "error", "cancelled": true, ...})

Only YouTube URLs are accepted. Files go to ~/Downloads[/subfolder].
Python 3.8+ standard library only; yt-dlp must be installed separately.

Inventing Fire with AI — by Rich Crane
"""

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
from urllib.parse import urlparse

HOST_VERSION = "1.0.0"
MAX_MESSAGE = 1024 * 1024  # Chrome caps extension -> host messages at 4 GB; we need tiny ones.
YOUTUBE_HOST_RE = re.compile(
    r"^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$|^youtu\.be$", re.I)
PROGRESS_PREFIX = "VDPROG "
COOKIE_ERROR_RE = re.compile(
    r"cookies? database|could not copy .*cookie|cookie.*(keychain|decrypt)"
    r"|(keychain|decrypt).*cookie|failed to (load|read) cookies", re.I)
FILE_PREFIX = "VDFILE "
# Chrome launches hosts with a minimal PATH; look in the usual install places too.
EXTRA_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
               os.path.expanduser("~/.local/bin"), os.path.expanduser("~/bin")]

_write_lock = threading.Lock()
_proc = None
_cancelled = False


# ── Native messaging framing ───────────────────────────────────────────

def _binary_stdio():
    if sys.platform == "win32":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    return sys.stdin.buffer, sys.stdout.buffer


STDIN, STDOUT = _binary_stdio()


def read_message():
    header = STDIN.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("<I", header)
    if length > MAX_MESSAGE:
        raise ValueError("message too large")
    body = STDIN.read(length)
    if len(body) < length:
        return None
    return json.loads(body.decode("utf-8"))


def send(message):
    data = json.dumps(message).encode("utf-8")
    with _write_lock:
        STDOUT.write(struct.pack("<I", len(data)))
        STDOUT.write(data)
        STDOUT.flush()


# ── Tool discovery ─────────────────────────────────────────────────────

def _search_path():
    parts = os.environ.get("PATH", "").split(os.pathsep)
    return os.pathsep.join(parts + [p for p in EXTRA_PATHS if p not in parts])


def find_ytdlp():
    """Command list that runs yt-dlp, or None."""
    override = os.environ.get("VIDEODOWNLOADER_YTDLP")
    if override:
        return [override]
    exe = shutil.which("yt-dlp", path=_search_path())
    if exe:
        return [exe]
    try:
        import yt_dlp  # noqa: F401  (installed as a module, e.g. pip --user)
        return [sys.executable, "-m", "yt_dlp"]
    except ImportError:
        return None


def find_ffmpeg():
    return shutil.which("ffmpeg", path=_search_path())


def ytdlp_version(cmd):
    try:
        out = subprocess.run(cmd + ["--version"], capture_output=True, text=True, timeout=20)
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


# ── Requests ───────────────────────────────────────────────────────────

def is_youtube_url(url):
    try:
        u = urlparse(url)
    except ValueError:
        return False
    return u.scheme in ("http", "https") and bool(YOUTUBE_HOST_RE.match(u.hostname or ""))


def format_selector(quality, has_ffmpeg):
    """yt-dlp -f value. Without ffmpeg only single-file (muxed) formats work."""
    if quality == "audio":
        return "ba[ext=m4a]/ba"
    cap = f"[height<={int(quality)}]" if quality in ("1080", "720", "480") else ""
    if has_ffmpeg:
        return f"bv*{cap}[ext=mp4]+ba[ext=m4a]/bv*{cap}+ba/b{cap}"
    return f"b{cap}[ext=mp4]/b{cap}"


def output_dir(subfolder):
    root = os.path.realpath(os.path.join(os.path.expanduser("~"), "Downloads"))
    target = root
    sub = (subfolder or "").strip().strip("/\\")
    if sub:
        parts = re.split(r"[\\/]+", sub)
        # Reject traversal, absolute paths, and Windows drive/stream syntax
        # ("C:foo" would otherwise join as a drive-relative path).
        if (any(p in ("", ".", "..") or ":" in p for p in parts)
                or os.path.isabs(sub) or os.path.splitdrive(sub)[0]):
            raise ValueError("Invalid download subfolder")
        target = os.path.realpath(os.path.join(root, *parts))
        if os.path.commonpath([root, target]) != root:
            raise ValueError("Invalid download subfolder")
    os.makedirs(target, exist_ok=True)
    return target


def build_command(ytdlp, msg, has_ffmpeg):
    quality = str(msg.get("quality") or "best")
    cmd = ytdlp + [
        # --print implies --quiet; --progress keeps the progress lines.
        "--no-playlist", "--newline", "--no-colors", "--no-simulate", "--progress",
        "--progress-template",
        "download:" + PROGRESS_PREFIX + "%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        "--print", "after_move:" + FILE_PREFIX + "%(filepath)s",
        "-f", format_selector(quality, has_ffmpeg),
        "-P", output_dir(msg.get("subfolder")),
        "-o", "%(title).180B [%(id)s].%(ext)s",
    ]
    if has_ffmpeg and quality != "audio":
        cmd += ["--merge-output-format", "mp4"]
    if msg.get("cookiesFromBrowser"):
        cmd += ["--cookies-from-browser", "chrome"]
    # "--" ends option parsing so a URL can never be read as a yt-dlp flag.
    return cmd + ["--", msg["url"]]


def parse_progress(line):
    percent, speed, eta = (line[len(PROGRESS_PREFIX):].split("|") + ["", "", ""])[:3]
    try:
        value = float(percent.strip().rstrip("%"))
    except ValueError:
        value = 0.0
    clean = lambda s: "" if s.strip() in ("N/A", "NA", "Unknown", "") else s.strip()
    return {"type": "progress", "percent": value, "speed": clean(speed), "eta": clean(eta)}


def run_download(msg):
    global _proc, _cancelled
    url = msg.get("url", "")
    if not is_youtube_url(url):
        send({"type": "error", "error": "Only YouTube URLs are supported"})
        return
    ytdlp = find_ytdlp()
    if not ytdlp:
        send({"type": "error", "error": "yt-dlp is not installed"})
        return
    try:
        cmd = build_command(ytdlp, msg, bool(find_ffmpeg()))
    except ValueError as err:
        send({"type": "error", "error": str(err)})
        return

    env = dict(os.environ, PATH=_search_path())
    # _cancelled is reset by main() before this thread starts, so a Cancel
    # that arrives while we are still preparing is not lost.
    code, final_file, errors = _run_ytdlp(cmd, env)
    note = ""

    # Reading Chrome's cookies can fail when Chrome itself launches this host
    # (macOS may deny access to the profile folder, or the Keychain prompt is
    # refused). Public videos don't need them: retry once without cookies.
    if (not _cancelled and code != 0 and msg.get("cookiesFromBrowser")
            and any(COOKIE_ERROR_RE.search(e) for e in errors)):
        retry = dict(msg, cookiesFromBrowser=False)
        code, final_file, errors = _run_ytdlp(build_command(ytdlp, retry, bool(find_ffmpeg())), env)
        note = "Chrome sign-in cookies were unavailable; downloaded without them"

    if _cancelled:
        send({"type": "error", "cancelled": True, "error": "Cancelled"})
    elif code == 0 and final_file:
        send({"type": "done", "file": final_file, **({"note": note} if note else {})})
    else:
        detail = next((e for e in reversed(errors) if e.startswith("ERROR")), errors[-1] if errors else "")
        send({"type": "error", "error": detail.replace("ERROR: ", "", 1) or f"yt-dlp exited with code {code}"})


def _run_ytdlp(cmd, env):
    """Run yt-dlp, relaying progress. Returns (exit code, final file, stderr lines)."""
    global _proc
    if _cancelled:
        return -1, "", []
    try:
        _proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 stdin=subprocess.DEVNULL, text=True, bufsize=1, env=env)
    except OSError as err:
        return -1, "", [f"ERROR: Could not start yt-dlp: {err}"]

    errors = []

    def read_stderr(stream):
        # In quiet mode yt-dlp may write progress to stderr.
        for raw in stream:
            line = raw.strip()
            if line.startswith(PROGRESS_PREFIX):
                send(parse_progress(line))
            elif line:
                errors.append(line)

    stderr_thread = threading.Thread(target=read_stderr, args=(_proc.stderr,), daemon=True)
    stderr_thread.start()

    final_file = ""
    for line in _proc.stdout:
        line = line.rstrip("\n")
        if line.startswith(PROGRESS_PREFIX):
            send(parse_progress(line))
        elif line.startswith(FILE_PREFIX):
            final_file = line[len(FILE_PREFIX):]
    code = _proc.wait()
    stderr_thread.join(timeout=2)
    _proc = None
    return code, final_file, errors


def cancel():
    """Cancel the active download. The flag is set even between yt-dlp runs
    (e.g. just before the cookie-less retry) so no new run starts after it."""
    global _cancelled
    _cancelled = True
    proc = _proc
    if proc and proc.poll() is None:
        proc.terminate()


def main():
    global _cancelled
    worker = None
    while True:
        try:
            msg = read_message()
        except (ValueError, json.JSONDecodeError) as err:
            send({"type": "error", "error": f"Bad message: {err}"})
            return
        if msg is None:  # extension disconnected
            cancel()
            break
        kind = msg.get("type") if isinstance(msg, dict) else None
        if kind == "probe":
            ytdlp = find_ytdlp()
            version = ytdlp_version(ytdlp) if ytdlp else None
            send({"type": "probe", "ok": bool(version), "version": HOST_VERSION,
                  "ytdlp": version, "ffmpeg": bool(find_ffmpeg()),
                  **({} if version else {"error": "yt-dlp is not installed"})})
        elif kind == "download":
            if worker and worker.is_alive():
                send({"type": "error", "error": "A download is already running"})
                continue
            _cancelled = False
            worker = threading.Thread(target=run_download, args=(msg,), daemon=True)
            worker.start()
        elif kind == "cancel":
            if worker and worker.is_alive():
                cancel()
        else:
            send({"type": "error", "error": f"Unknown message type: {kind}"})
    if worker:
        worker.join(timeout=5)


if __name__ == "__main__":
    main()
