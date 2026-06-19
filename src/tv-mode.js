const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be"
]);

function sanitizeYoutubeId(value) {
  const id = String(value || "").trim();
  return /^[\w-]{6,}$/.test(id) ? id : "";
}

export function getYoutubeEmbedUrl(value) {
  const input = String(value || "").trim();
  if (!input) {
    return "";
  }

  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase();
    if (!YOUTUBE_HOSTS.has(hostname)) {
      return "";
    }

    let videoId = "";

    if (hostname === "youtu.be") {
      videoId = sanitizeYoutubeId(url.pathname.slice(1).split("/")[0]);
    } else if (url.pathname.startsWith("/watch")) {
      videoId = sanitizeYoutubeId(url.searchParams.get("v"));
    } else if (url.pathname.startsWith("/live/")) {
      videoId = sanitizeYoutubeId(url.pathname.split("/")[2]);
    } else if (url.pathname.startsWith("/embed/")) {
      videoId = sanitizeYoutubeId(url.pathname.split("/")[2]);
    } else if (url.pathname.startsWith("/shorts/")) {
      videoId = sanitizeYoutubeId(url.pathname.split("/")[2]);
    }

    if (!videoId) {
      return "";
    }

    const embedUrl = new URL(`https://www.youtube.com/embed/${videoId}`);
    embedUrl.searchParams.set("autoplay", "1");
    embedUrl.searchParams.set("mute", "1");
    embedUrl.searchParams.set("controls", "0");
    embedUrl.searchParams.set("enablejsapi", "1");
    embedUrl.searchParams.set("disablekb", "1");
    embedUrl.searchParams.set("fs", "0");
    embedUrl.searchParams.set("iv_load_policy", "3");
    embedUrl.searchParams.set("modestbranding", "1");
    embedUrl.searchParams.set("rel", "0");
    embedUrl.searchParams.set("playsinline", "1");
    return embedUrl.toString();
  } catch {
    return "";
  }
}

export function getTvOverlayHeightPercent(prCount) {
  const count = Math.max(0, Number(prCount) || 0);
  if (count === 0) {
    return 0;
  }

  return Math.min(82, count * 14);
}
