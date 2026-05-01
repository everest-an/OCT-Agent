import { MessageCircle, Database, Cable, Puzzle, Settings, Workflow, Bot, Cpu } from 'lucide-react';
import logoUrl from '../assets/svg.png';
import { useI18n } from '../lib/i18n';

export type Page = 'chat' | 'memory' | 'channels' | 'models' | 'skills' | 'automation' | 'agents' | 'settings';

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

const navItems: { id: Page; icon: typeof MessageCircle; i18nKey: string; englishLabel?: string }[] = [
  { id: 'chat', icon: MessageCircle, i18nKey: 'nav.chat' },
  { id: 'memory', icon: Database, i18nKey: 'nav.memory' },
  { id: 'channels', icon: Cable, i18nKey: 'nav.channels', englishLabel: 'Connect' },
  { id: 'models', icon: Cpu, i18nKey: 'nav.models' },
  { id: 'skills', icon: Puzzle, i18nKey: 'nav.skills' },
  { id: 'automation', icon: Workflow, i18nKey: 'nav.automation', englishLabel: 'Auto' },
  { id: 'agents', icon: Bot, i18nKey: 'nav.agents' },
  { id: 'settings', icon: Settings, i18nKey: 'nav.settings' },
];

export default function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const { t } = useI18n();

  return (
    <aside className="sidebar-glass w-20 flex-shrink-0 flex flex-col items-center pt-8 pb-6 gap-0.5">
      <div className="logo-mark mb-3 flex h-10 w-10 items-center justify-center">
        <img src={logoUrl} alt="OCT Agent" className="h-full w-full rounded-[0.8rem] object-cover" />
      </div>

      <div className="mb-5 flex flex-col items-center gap-0.5">
        <span className="text-[13px] font-semibold tracking-[0.12em] uppercase oct-brand-text leading-none">OCT</span>
      </div>

      {navItems.map(({ id, icon: Icon, i18nKey, englishLabel }) => {
        const isActive = currentPage === id;
        const translatedLabel = t(i18nKey);
        const displayLabel = englishLabel && (translatedLabel === 'Channels' || translatedLabel === 'Automation')
          ? englishLabel
          : translatedLabel;
        return (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={`
              titlebar-no-drag relative w-[60px] h-14 rounded-2xl
              flex flex-col items-center justify-center gap-[3px]
              transition-all duration-200 text-[10px] font-medium tracking-normal
              ${isActive
                ? 'text-[#6D5DF6] dark:text-[#B87EFF]'
                : 'text-slate-500 hover:text-slate-900 hover:bg-black/[0.04] dark:hover:text-slate-200 dark:hover:bg-white/[0.05]'
              }
            `}
            title={translatedLabel}
          >
            {isActive && <span className="nav-active-pill" />}

            <Icon
              size={20}
              strokeWidth={isActive ? 2 : 1.65}
              className="relative z-10 transition-[stroke-width] duration-200"
            />
            <span className="relative z-10 max-w-[54px] truncate leading-none">{displayLabel}</span>
          </button>
        );
      })}

      <div className="mt-auto pt-4 text-[10px] font-medium tracking-[0.08em] text-slate-400 dark:text-slate-500">
        Awareness
      </div>
    </aside>
  );
}
