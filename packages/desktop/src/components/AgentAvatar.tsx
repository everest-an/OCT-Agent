import { Bot } from 'lucide-react';
import logoUrl from '../assets/svg.png';

function isLikelyEmoji(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 16) return false;

  let hasNonAscii = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) > 127) {
      hasNonAscii = true;
      break;
    }
  }

  if (!hasNonAscii) return false;
  if (trimmed.includes('://') || trimmed.includes('/') || trimmed.includes('.')) return false;
  return true;
}

function normalizeEmojiCandidate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'default') return '';
  if (isLikelyEmoji(trimmed)) return trimmed;

  const leadingToken = trimmed.split(/\s+/)[0]?.replace(/[.,;:!?]+$/, '') || '';
  return isLikelyEmoji(leadingToken) ? leadingToken : '';
}

function frameSizeClass(size: number): string {
  if (size <= 12) return 'w-3 h-3';
  if (size <= 14) return 'w-3.5 h-3.5';
  if (size <= 16) return 'w-4 h-4';
  if (size <= 18) return 'w-[18px] h-[18px]';
  if (size <= 20) return 'w-5 h-5';
  return 'w-6 h-6';
}

function iconSize(size: number): number {
  if (size <= 12) return 8;
  if (size <= 14) return 9;
  if (size <= 16) return 10;
  if (size <= 18) return 11;
  if (size <= 20) return 12;
  return 14;
}

function emojiTextSizeClass(size: number): string {
  if (size <= 12) return 'text-[10px]';
  if (size <= 14) return 'text-xs';
  if (size <= 16) return 'text-sm';
  if (size <= 18) return 'text-base';
  return 'text-lg';
}

export default function AgentAvatar({
  name,
  emoji,
  size = 16,
  fallback = 'bot',
  className = '',
}: {
  name?: string;
  emoji?: string;
  size?: number;
  fallback?: 'bot' | 'logo';
  className?: string;
}) {
  const rawEmoji = String(emoji || '').trim();
  const normalizedEmoji = normalizeEmojiCandidate(rawEmoji);
  const normalizedName = String(name || '').trim();
  const frameClass = frameSizeClass(size);
  if (normalizedEmoji) {
    return (
      <span title={normalizedName || undefined} className={`inline-flex items-center justify-center overflow-hidden whitespace-nowrap ${frameClass} leading-none ${emojiTextSizeClass(size)} ${className}`.trim()}>
        {normalizedEmoji}
      </span>
    );
  }

  if (fallback === 'logo' || rawEmoji.toLowerCase() === 'default') {
    return (
      <img
        src={logoUrl}
        alt={`${normalizedName || 'Agent'} logo`}
        title={normalizedName || undefined}
        className={`${frameClass} rounded-md object-contain ${className}`.trim()}
      />
    );
  }

  return (
    <span title={normalizedName || undefined} className={`inline-flex items-center justify-center rounded-md bg-slate-800/70 text-slate-300 ${frameClass} ${className}`.trim()}>
      <Bot size={iconSize(size)} />
    </span>
  );
}
