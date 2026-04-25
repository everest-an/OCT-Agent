// Extracted from register-chat-handlers.ts — text pattern matching and heuristic detection.
// No logic changes, only moved.

export function getHostOsLabel(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  return 'Linux';
}

export function looksLikePathReference(text: string): boolean {
  return /[a-zA-Z]:\\|\\\\|\/[A-Za-z0-9._-]|\.[A-Za-z0-9]{1,8}\b/.test(text);
}

export function looksLikeFilesystemMutationRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const hasMutationVerb = /(create|write|save|edit|modify|update|append|rename|move|delete|remove|overwrite|mkdir|touch|生成|写入|保存|创建|新建|编辑|修改|更新|追加|重命名|移动|删除|移除|覆盖)/i.test(trimmed);
  if (!hasMutationVerb) return false;

  const hasFilesystemContext = /(file|folder|directory|path|txt|md|json|csv|docx?|log|文件|文件夹|目录|路径|文档|文本)/i.test(trimmed);
  return hasFilesystemContext || looksLikePathReference(trimmed);
}

export function looksLikeFilesystemToolName(toolName: string | undefined): boolean {
  const normalized = String(toolName || '').trim().toLowerCase();
  if (!normalized) return false;
  return /(^|[_.:-])(exec|bash|powershell|read|write|edit|replace|rename|move|delete|remove|mkdir|touch|cat|ls|stat|file)([_.:-]|$)/.test(normalized);
}

export function looksLikeSuccessfulFilesystemMutationResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/(did not|didn't|unable|can't|cannot|could not|failed|not able|was not|were not|没能|无法|不能|失败|未能|未成功)/i.test(trimmed)) {
    return false;
  }

  const hasSuccessVerb = /(saved|created|wrote|written|updated|edited|renamed|deleted|removed|moved|overwritten|placed|put|listed|found|contains?|there (?:is|are)|saving|writing|保存|创建|写入|写好|写好了|更新|修改|重命名|删除|移除|移动|放在|放到|列出|读取|看到|找到了|包含|目前有|如下|已保存|已创建|已写入|已更新|已读取|已列出)/i.test(trimmed);
  if (!hasSuccessVerb) return false;

  const hasFilesystemContext = /(file|folder|directory|path|txt|md|json|csv|docx?|log|文件|文件夹|目录|路径|文档|文本)/i.test(trimmed);
  return hasFilesystemContext || looksLikePathReference(trimmed);
}

export function looksLikeWebOperationRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /(https?:\/\/|\bwww\.|\burl\b|\bwebsite\b|\bweb ?page\b|\bbrowser\b|\bbrowse\b|\bweb\b|\bsearch\b|\bfetch\b|\bdownload\b|网页|网站|浏览|搜索|抓取|下载)/i.test(trimmed);
}

export function looksLikeSpecialUseIpWebBlock(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /(private\s*[,/ ]\s*internal\s*[,/ ]\s*(or\s+)?special-use\s+ip|private\/internal\/special-use\s+ip|special-use\s+ip\s+address)/i.test(trimmed);
}

export function extractFirstHttpUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s)\]"'>]+/i);
  return match?.[0] || null;
}

export function hasMeaningfulAgentText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^no response$/i.test(trimmed)) return false;
  if (/^blocked$/i.test(trimmed)) return false;
  if (isGatewayDiagnosticNoise(trimmed)) return false;
  return true;
}

/**
 * Detect Gateway verbose diagnostic lines that should NOT be shown as assistant text.
 *
 * OpenClaw Gateway emits plugin/config diagnostics through the same WS event stream
 * as assistant text when verbose='full'. These lines are internal warnings, not LLM
 * output. If they are the *only* content in a response, the user sees a confusing
 * diagnostic instead of an actual reply.
 *
 * Known patterns:
 *   - `plugins.entries.<name>: plugin disabled (memory slot set to "<slot>") but config is present`
 *   - `plugins.entries.<name>: <any single-line diagnostic>`
 *   - `[plugins] Registered <name>`
 *   - `[diagnostic] ...`
 *   - `[info] ...` / `[warn] ...` / `[error] ...`
 *
 * This function is intentionally conservative — it only matches well-known Gateway
 * noise patterns. Unknown text passes through to the user.
 */
export function isGatewayDiagnosticNoise(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Each line must be a diagnostic line for the whole block to be noise.
  const lines = trimmed.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return false;

  return lines.every(line => {
    const l = line.trim();
    // plugins.entries.<id>: <diagnostic>
    if (/^plugins\.entries\.\S+:\s+/i.test(l)) return true;
    // [plugins] Registered ... / [diagnostic] ... / [info] ... / [warn] ... / [error] ...
    if (/^\[(plugins|diagnostic|info|warn|error|tools|agent\/|context-diag|commands|reload|acp-client)\]/i.test(l)) return true;
    // Registered plugin ...
    if (/^Registered plugin\b/i.test(l)) return true;
    return false;
  });
}

export function looksLikeAwarenessInitCompatibilityError(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /schema must be object or boolean/i.test(trimmed);
}
