import { Bot } from 'lucide-react';

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
  emoji,
  size = 16,
  className = '',
}: {
  emoji?: string;
  size?: number;
  className?: string;
}) {
  const normalizedEmoji = String(emoji || '').trim();
  const frameClass = frameSizeClass(size);
  if (normalizedEmoji) {
    return (
      <span className={`inline-flex items-center justify-center ${frameClass} leading-none ${emojiTextSizeClass(size)} ${className}`.trim()}>
        {normalizedEmoji}
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center justify-center rounded-md bg-slate-800/70 text-slate-300 ${frameClass} ${className}`.trim()}>
      <Bot size={iconSize(size)} />
    </span>
  );
}
