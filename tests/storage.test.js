import test from "node:test";
import assert from "node:assert/strict";

import { clearToken, readToken, writeToken } from "../src/storage.js";

function createStorage(seed = {}) {
  const values = { ...seed };

  return {
    getItem(key) {
      return Object.hasOwn(values, key) ? values[key] : null;
    },
    setItem(key, value) {
      values[key] = String(value);
    },
    removeItem(key) {
      delete values[key];
    }
  };
}

test("stores and reads scoped tokens by config id", () => {
  const storage = createStorage();

  writeToken("gitlab", "token-a", "cfg_a", storage);
  writeToken("gitlab", "token-b", "cfg_b", storage);

  assert.equal(readToken("gitlab", "cfg_a", storage), "token-a");
  assert.equal(readToken("gitlab", "cfg_b", storage), "token-b");
});

test("falls back to provider token for legacy entries", () => {
  const storage = createStorage({
    "penguin-alarm.provider-tokens": JSON.stringify({ gitlab: "legacy-gitlab-token" })
  });

  assert.equal(readToken("gitlab", "cfg_missing", storage), "legacy-gitlab-token");
});

test("clearToken removes only the targeted scoped token", () => {
  const storage = createStorage();

  writeToken("gitlab", "token-a", "cfg_a", storage);
  writeToken("gitlab", "token-b", "cfg_b", storage);
  clearToken("gitlab", "cfg_a", storage);

  assert.equal(readToken("gitlab", "cfg_a", storage), "");
  assert.equal(readToken("gitlab", "cfg_b", storage), "token-b");
});
