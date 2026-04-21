import http from 'http';

// Daemon base URL. Production default is the hardcoded local daemon.
// `__setDaemonBaseForTest` allows L3 chaos tests to redirect traffic to
// a mock HTTP server on a dynamic port. Not exported via index / IPC.
let _daemonBase = 'http://127.0.0.1:37800';
export function __setDaemonBaseForTest(url: string): void {
  _daemonBase = url;
}
export function __resetDaemonBaseForTest(): void {
  _daemonBase = 'http://127.0.0.1:37800';
}

// Per-request project isolation: set via setMemoryClientProjectDir()
let _currentProjectDir: string | null = null;

export function setMemoryClientProjectDir(dir: string | null): void {
  _currentProjectDir = dir;
}

export function getMemoryClientProjectDir(): string | null {
  return _currentProjectDir;
}

// Node http rejects non-ISO-8859-1 bytes + control chars in header values
// (throws TypeError synchronously from http.request). CJK/emoji/fullwidth
// paths — common on Windows with Chinese usernames and on macOS workspace
// folders — all trip it. We detect header-safe values vs. paths that need
// base64 transport, and degrade to "no header" rather than crashing when
// even base64 encoding fails.
const HEADER_SAFE_RE = /^[\x20-\x7E\t]+$/;

export function applyProjectDirHeader(headers: Record<string, string>, dir: string | null): void {
  if (!dir) return;
  if (HEADER_SAFE_RE.test(dir)) {
    headers['X-Awareness-Project-Dir'] = dir;
    return;
  }
  try {
    headers['X-Awareness-Project-Dir-B64'] = Buffer.from(dir, 'utf8').toString('base64');
  } catch (err) {
    console.warn('[memory-client] failed to encode project dir for header; request will use daemon default project:', (err as Error).message);
  }
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  applyProjectDirHeader(headers, _currentProjectDir);
  return headers;
}

function buildGetHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  applyProjectDirHeader(headers, _currentProjectDir);
  return headers;
}

export function callMcp(toolName: string, args: Record<string, any>): Promise<any> {
  return new Promise((resolve) => {
    // Validate args to prevent Ajv schema validation errors
    if (args && typeof args !== 'object') {
      console.error(`callMcp: Invalid args for tool ${toolName}`, args);
      resolve({ error: `Invalid arguments: expected object, got ${typeof args}` });
      return;
    }
    
    // Ensure args is a plain object without special constructors that might cause schema validation issues
    let validatedArgs = args;
    if (args !== null && typeof args === 'object') {
      try {
        // Deep clone to remove any prototype pollution or special objects
        validatedArgs = JSON.parse(JSON.stringify(args));
      } catch (e) {
        console.error(`callMcp: Error cloning args for tool ${toolName}`, e);
        resolve({ error: `Invalid arguments: ${e.message}` });
        return;
      }
    }
    
    const req = http.request(`${_daemonBase}/mcp`, {
      method: 'POST',
      headers: buildHeaders(),
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try { 
          const result = JSON.parse(data);
          
          // Check if result contains Ajv validation error
          if (result.error && typeof result.error === 'string' && 
              (result.error.includes('schema must be object or boolean'))) {
            console.error(`callMcp: Schema validation error for tool ${toolName}:`, result.error);
            resolve({ 
              error: 'Schema validation error. This may indicate a protocol mismatch between desktop client and local daemon.', 
              original_error: result.error 
            });
          } else {
            resolve(result); 
          }
        } catch { 
          resolve({ error: 'Invalid JSON response from daemon' }); 
        }
      });
    });
    req.on('error', (err) => resolve({ error: String(err) }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Timeout' }); });
    req.write(JSON.stringify({
      jsonrpc: '2.0', id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: validatedArgs },
    }));
    req.end();
  });
}

export function callMcpStrict(toolName: string, args: Record<string, any>, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    // Validate args to prevent Ajv schema validation errors
    if (args && typeof args !== 'object') {
      const errorMsg = `callMcpStrict: Invalid args for tool ${toolName}`;
      console.error(errorMsg, args);
      reject(new Error(`Invalid arguments: expected object, got ${typeof args}`));
      return;
    }
    
    // Ensure args is a plain object without special constructors that might cause schema validation issues
    let validatedArgs = args;
    if (args !== null && typeof args === 'object') {
      try {
        // Deep clone to remove any prototype pollution or special objects
        validatedArgs = JSON.parse(JSON.stringify(args));
      } catch (e) {
        console.error(`callMcpStrict: Error cloning args for tool ${toolName}`, e);
        reject(new Error(`Invalid arguments: ${e.message}`));
        return;
      }
    }
    
    const req = http.request(`${_daemonBase}/mcp`, {
      method: 'POST',
      headers: buildHeaders(),
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result?.error) {
            // Check if it's an Ajv validation error
            const errorMessage = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
            if (errorMessage.includes('schema must be object or boolean')) {
              console.error(`callMcpStrict: Schema validation error for tool ${toolName}:`, result.error);
              reject(new Error('Schema validation error. This may indicate a protocol mismatch between desktop client and local daemon.'));
            } else {
              reject(new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error)));
            }
          } else {
            resolve(result);
          }
        } catch {
          reject(new Error('Invalid JSON from daemon'));
        }
      });
    });
    req.on('error', (err) => reject(new Error(`Daemon connection failed: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Daemon request timed out')); });
    req.write(JSON.stringify({
      jsonrpc: '2.0', id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: validatedArgs },
    }));
    req.end();
  });
}

export type MemoryEventQueryOptions = {
  limit?: number;
  offset?: number;
  search?: string;
  type?: string;
  agent_role?: string;
  source?: string;
  source_exclude?: string;
};

export function fetchMemoryEvents(opts: MemoryEventQueryOptions): Promise<any> {
  const limit = opts?.limit || 50;
  const offset = opts?.offset || 0;
  const search = opts?.search || '';
  const typeFilter = opts?.type || '';
  const agentRoleFilter = opts?.agent_role || '';
  const sourceFilter = opts?.source || '';
  const sourceExclude = opts?.source_exclude || '';

  let endpoint: string;
  if (search) {
    const params = new URLSearchParams({ q: search, limit: String(limit) });
    if (typeFilter) params.set('type', typeFilter);
    if (agentRoleFilter) params.set('agent_role', agentRoleFilter);
    if (sourceFilter) params.set('source', sourceFilter);
    if (sourceExclude) params.set('source_exclude', sourceExclude);
    endpoint = `http://127.0.0.1:37800/api/v1/memories/search?${params.toString()}`;
  } else {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (typeFilter) params.set('type', typeFilter);
    if (agentRoleFilter) params.set('agent_role', agentRoleFilter);
    if (sourceFilter) params.set('source', sourceFilter);
    if (sourceExclude) params.set('source_exclude', sourceExclude);
    endpoint = `http://127.0.0.1:37800/api/v1/memories?${params.toString()}`;
  }

  return new Promise((resolve) => {
    const req = http.request(endpoint, { method: 'GET', headers: buildGetHeaders(), timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: 'Invalid JSON' }); }
      });
    });
    req.on('error', (err: Error) => resolve({ error: String(err) }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Timeout' }); });
    req.end();
  });
}

export function fetchKnowledgeCards(opts: { category?: string; limit?: number } = {}): Promise<any> {
  const params = new URLSearchParams();
  if (opts.category) params.set('category', opts.category);
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const endpoint = `http://127.0.0.1:37800/api/v1/knowledge${qs ? `?${qs}` : ''}`;

  return new Promise((resolve) => {
    const req = http.request(endpoint, { method: 'GET', headers: buildGetHeaders(), timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: 'Invalid JSON' }); }
      });
    });
    req.on('error', (err: Error) => resolve({ error: String(err) }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Timeout' }); });
    req.end();
  });
}

export function fetchCardEvolution(cardId: string): Promise<any> {
  return new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:37800/api/v1/knowledge/${encodeURIComponent(cardId)}/evolution`, {
      method: 'GET', headers: buildGetHeaders(), timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: 'Invalid JSON' }); }
      });
    });
    req.on('error', (err: Error) => resolve({ error: String(err) }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Timeout' }); });
    req.end();
  });
}

export function checkMemoryHealth(): Promise<any> {
  return new Promise((resolve) => {
    const req = http.request('http://127.0.0.1:37800/healthz', { method: 'GET', timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: 'Invalid JSON' }); }
      });
    });
    req.on('error', () => resolve({ error: 'Not running' }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Timeout' }); });
    req.end();
  });
}