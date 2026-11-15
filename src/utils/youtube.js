/**
 * YouTube URL helpers. YouTube video is only downloadable through the
 * optional companion app (companion/ — a native-messaging host wrapping
 * yt-dlp); the extension itself never extracts YouTube streams.
 *
 * Inventing Fire with AI — by Rich Crane
 */

const YOUTUBE_HOST_RE = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$|^youtu\.be$/i;

/** True for youtube.com / youtu.be / youtube-nocookie.com page URLs. */
export function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && YOUTUBE_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

/** 11-character video ID from a watch, embed, shorts, live, or youtu.be URL, or null. */
export function youTubeVideoId(url) {
  if (!isYouTubeUrl(url)) return null;
  const u = new URL(url);
  const id = u.hostname.toLowerCase() === 'youtu.be'
    ? u.pathname.split('/')[1]
    : u.searchParams.get('v') || /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname)?.[1];
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

/** Canonical watch URL for a YouTube URL, or null when it names no video. */
export function youTubeWatchUrl(url) {
  const id = youTubeVideoId(url);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

/** Hosts that serve YouTube media chunks — never listed as downloads. */
export function isYouTubeMediaHost(url) {
  try {
    return /(^|\.)googlevideo\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}
