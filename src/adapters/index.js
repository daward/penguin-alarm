import { githubAdapter } from "./github.js";
import { gitlabAdapter } from "./gitlab.js";
import { createUnsupportedAdapter } from "./unsupported.js";

const bitbucketAdapter = createUnsupportedAdapter(
  "bitbucket",
  "Bitbucket",
  "bitbucket-app-password",
  "https://support.atlassian.com/bitbucket-cloud/docs/app-passwords/"
);

export const ADAPTERS = [githubAdapter, gitlabAdapter, bitbucketAdapter];

export function getAdapter(provider) {
  return ADAPTERS.find((item) => item.id === provider) || githubAdapter;
}
