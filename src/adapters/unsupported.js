function unsupported(providerLabel) {
  return async () => {
    throw new Error(`${providerLabel} polling is not wired yet. GitHub is fully supported now.`);
  };
}

export function createUnsupportedAdapter(id, label, tokenPlaceholder, docsUrl) {
  return {
    id,
    label,
    tokenPlaceholder,
    docsUrl,
    fetchViewer: unsupported(label),
    fetchRepoSnapshot: unsupported(label)
  };
}
