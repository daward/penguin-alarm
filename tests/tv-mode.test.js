import test from "node:test";
import assert from "node:assert/strict";

import { getTvOverlayHeightPercent, getYoutubeEmbedUrl } from "../src/tv-mode.js";

test("converts a youtube watch url into an autoplaying embed", () => {
  const embedUrl = getYoutubeEmbedUrl("https://www.youtube.com/watch?v=jfKfPfyJRdk");

  assert.equal(
    embedUrl,
    "https://www.youtube.com/embed/jfKfPfyJRdk?autoplay=1&mute=1&controls=0&enablejsapi=1&disablekb=1&fs=0&iv_load_policy=3&modestbranding=1&rel=0&playsinline=1"
  );
});

test("accepts short and live youtube urls", () => {
  assert.match(getYoutubeEmbedUrl("https://youtu.be/jfKfPfyJRdk"), /embed\/jfKfPfyJRdk/);
  assert.match(getYoutubeEmbedUrl("https://www.youtube.com/live/jfKfPfyJRdk"), /embed\/jfKfPfyJRdk/);
});

test("rejects non-youtube urls", () => {
  assert.equal(getYoutubeEmbedUrl("https://example.com/watch?v=jfKfPfyJRdk"), "");
  assert.equal(getYoutubeEmbedUrl("not a url"), "");
});

test("tv overlay stays hidden for zero PRs and caps for large queues", () => {
  assert.equal(getTvOverlayHeightPercent(0), 0);
  assert.equal(getTvOverlayHeightPercent(3), 42);
  assert.equal(getTvOverlayHeightPercent(99), 82);
});
