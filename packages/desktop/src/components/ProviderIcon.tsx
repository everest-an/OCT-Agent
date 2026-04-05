import type { LucideIcon } from 'lucide-react';
import {
  Brain,
  Building2,
  Cloud,
  Cpu,
  Flame,
  House,
  Moon,
  Plug,
  Rocket,
  Sparkles,
  Zap,
} from 'lucide-react';

type ProviderIconEntry = {
  icon: LucideIcon;
  className: string;
};

const PROVIDER_ICON_MAP: Record<string, ProviderIconEntry> = {
  'qwen-portal': { icon: Cloud, className: 'text-sky-400' },
  deepseek: { icon: Cpu, className: 'text-cyan-400' },
  openai: { icon: Sparkles, className: 'text-emerald-400' },
  anthropic: { icon: Brain, className: 'text-violet-400' },
  zhipu: { icon: Building2, className: 'text-rose-400' },
  moonshot: { icon: Moon, className: 'text-indigo-300' },
  volcengine: { icon: Flame, className: 'text-orange-400' },
  qianfan: { icon: Building2, className: 'text-blue-400' },
  minimax: { icon: Sparkles, className: 'text-fuchsia-400' },
  siliconflow: { icon: Rocket, className: 'text-lime-400' },
  groq: { icon: Zap, className: 'text-amber-300' },
  ollama: { icon: House, className: 'text-slate-300' },
};

export default function ProviderIcon({
  providerKey,
  size = 14,
  className = '',
}: {
  providerKey?: string;
  size?: number;
  className?: string;
}) {
  const entry = providerKey ? PROVIDER_ICON_MAP[providerKey] : undefined;
  const Icon = entry?.icon || Plug;
  const colorClass = entry?.className || 'text-slate-400';

  return <Icon size={size} className={`${colorClass} ${className}`.trim()} />;
}
