export function encodeCursor(json: string): string {
  return btoa(json);
}

export function decodeCursor(b64: string): string {
  return atob(b64);
}

export function decodeBase64Path(encoded: string): string {
  return atob(encoded);
}

export function mapServerPath(serverPath: string, serverRoot: string, localRoot: string): string {
  if (!serverPath.startsWith(serverRoot)) {
    throw new Error(`Server path "${serverPath}" does not start with server root "${serverRoot}"`);
  }
  const relative = serverPath.slice(serverRoot.length);
  const base = localRoot.endsWith('/') ? localRoot.slice(0, -1) : localRoot;
  return base + relative;
}
