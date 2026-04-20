/**
 * ShareAgentForm — modal for submitting a locally-created agent to the
 * marketplace review queue (F-063 0.4.0).
 *
 * Invoked from the multi-agent page (one button per user-created agent).
 * The workspace files of the selected agent are read via main-process IPC,
 * reverse-composed into a single Claude-Code-style markdown, and submitted
 * alongside category/tier/contact metadata.
 */

import { useState, useEffect } from 'react';
import { Loader2, X } from 'lucide-react';

type Tier = 'consumer' | 'prosumer' | 'engineering';

interface ComposedAgent {
  markdown: string;
  description: string;
  tools: string[];
  name: string;
  emoji?: string;
  files: string[];
}

interface Props {
  /** Local agent id (from openclaw.json agents.list[].id) to pre-select. */
  preselectedAgentId: string;
  onClose: () => void;
  onSubmitted?: () => void;
}

function yamlEscape(value: string): string {
  if (/[:#"\n]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

export default function ShareAgentForm({ preselectedAgentId, onClose, onSubmitted }: Props) {
  const [composed, setComposed] = useState<ComposedAgent | null>(null);
  const [loading, setLoading] = useState(true);
  const [slug, setSlug] = useState(preselectedAgentId);
  const [category, setCategory] = useState('community');
  const [tier, setTier] = useState<Tier>('consumer');
  const [descriptionOverride, setDescriptionOverride] = useState('');
  const [contact, setContact] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.marketplaceComposeFromLocal) {
      setError('此版本 AwarenessClaw 不支持分享,请升级到 0.4.0+');
      setLoading(false);
      return;
    }
    api
      .marketplaceComposeFromLocal(preselectedAgentId)
      .then((res: any) => {
        if (res?.success) {
          setComposed({
            markdown: res.markdown,
            description: res.description,
            tools: res.tools || [],
            name: res.name,
            emoji: res.emoji,
            files: res.files || [],
          });
          setDescriptionOverride(res.description);
        } else {
          setError(res?.error || '读取 agent workspace 失败');
        }
      })
      .catch((err: any) => setError(String(err?.message || err)))
      .finally(() => setLoading(false));
  }, [preselectedAgentId]);

  const handleSubmit = async () => {
    if (!composed) return;
    setError(null);
    setMessage(null);
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(slug)) {
      setError('Slug 必须是 3-64 位小写字母/数字/连字符,且以字母开头');
      return;
    }
    if (!descriptionOverride.trim()) {
      setError('请填写描述');
      return;
    }

    let finalMarkdown = composed.markdown;
    if (descriptionOverride.trim() !== composed.description) {
      finalMarkdown = composed.markdown.replace(
        /(\ndescription:\s*)("[^"]*"|'[^']*'|[^\n]+)(\n)/,
        (_m, p1, _old, p3) => `${p1}${yamlEscape(descriptionOverride.trim())}${p3}`
      );
    }

    setSubmitting(true);
    try {
      const api = (window as any).electronAPI;
      const res = await api.marketplaceSubmit({
        slug,
        name: composed.name,
        description: descriptionOverride.trim(),
        category,
        tier,
        emoji: composed.emoji || '🤖',
        markdown: finalMarkdown,
        author_contact: contact || undefined,
      });
      if (res?.success) {
        setMessage('已提交!我们审核后会告知你结果 🎉');
        setTimeout(() => {
          onSubmitted?.();
          onClose();
        }, 1500);
      } else {
        setError(res?.error || '提交失败');
      }
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto border border-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-slate-800 flex items-center justify-between">
          <h2 className="font-semibold text-slate-100">
            🔗 分享 Agent 到集市
            {composed && <span className="ml-2 text-slate-400 font-normal">— {composed.name}</span>}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-400">
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading && (
          <div className="p-12 flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
          </div>
        )}

        {!loading && error && !composed && (
          <div className="p-6">
            <div className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded p-3">{error}</div>
            <button onClick={onClose} className="mt-4 px-4 py-2 text-sm rounded border border-slate-700 text-slate-200">
              关闭
            </button>
          </div>
        )}

        {composed && (
          <div className="p-5 space-y-4">
            <p className="text-xs text-slate-500">
              已自动从 <span className="font-mono text-slate-400">~/.openclaw/workspace-{preselectedAgentId}</span> 读取 {composed.files.length} 个文件,合并成单一 markdown 供审核:<br/>
              <span className="font-mono text-[11px]">{composed.files.join(' · ')}</span>
            </p>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <label className="block">
                <span className="text-xs text-slate-400">Slug (URL 标识) *</span>
                <input
                  className="mt-1 w-full px-2 py-1.5 rounded border border-slate-700 bg-slate-800 text-slate-100"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  pattern="^[a-z][a-z0-9-]{2,63}$"
                />
              </label>
              <div className="flex items-center gap-2 pt-5">
                <span className="text-2xl">{composed.emoji || '🤖'}</span>
                <span className="text-sm text-slate-300">{composed.name}</span>
              </div>

              <label className="col-span-2 block">
                <span className="text-xs text-slate-400">描述(让别人知道这个 agent 能干嘛)*</span>
                <textarea
                  className="mt-1 w-full px-2 py-1.5 rounded border border-slate-700 bg-slate-800 text-slate-100"
                  value={descriptionOverride}
                  onChange={(e) => setDescriptionOverride(e.target.value)}
                  rows={3}
                />
              </label>

              <label className="block">
                <span className="text-xs text-slate-400">分类</span>
                <input
                  className="mt-1 w-full px-2 py-1.5 rounded border border-slate-700 bg-slate-800 text-slate-100"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-xs text-slate-400">Tier</span>
                <select
                  className="mt-1 w-full px-2 py-1.5 rounded border border-slate-700 bg-slate-800 text-slate-100"
                  value={tier}
                  onChange={(e) => setTier(e.target.value as Tier)}
                >
                  <option value="consumer">consumer (日常)</option>
                  <option value="prosumer">prosumer (专业)</option>
                  <option value="engineering">engineering (工程)</option>
                </select>
              </label>

              <label className="col-span-2 block">
                <span className="text-xs text-slate-400">联系方式(可选,审核通过后我们告知你)</span>
                <input
                  className="mt-1 w-full px-2 py-1.5 rounded border border-slate-700 bg-slate-800 text-slate-100"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder="邮箱 / X / GitHub 用户名"
                />
              </label>

              {composed.tools.length > 0 && (
                <div className="col-span-2">
                  <span className="text-xs text-slate-400">自动提取的工具权限:</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {composed.tools.map((t) => (
                      <span key={t} className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <details className="col-span-2 rounded border border-slate-700 p-2 text-xs">
                <summary className="cursor-pointer text-slate-500">预览提交的 markdown 内容</summary>
                <pre className="mt-2 text-[10px] bg-slate-950 border border-slate-800 rounded p-2 font-mono overflow-auto max-h-64 text-slate-300">
                  {composed.markdown}
                </pre>
              </details>
            </div>

            {error && <div className="text-xs text-red-400">{error}</div>}
            {message && <div className="text-xs text-emerald-400">{message}</div>}

            <div className="flex gap-2 justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm rounded border border-slate-700 text-slate-200"
              >
                取消
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="px-4 py-2 text-sm rounded bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-60"
              >
                {submitting ? '提交中...' : '提交审核'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
