/**
 * Shared emoji picker for agent identity.
 *
 * Used by both AgentWizard (create flow) and Agents edit-identity block so the
 * two surfaces stay in sync. Users can click a preset emoji from the grid OR
 * paste any character via the sibling input the parent renders — onChange fires
 * for both paths because the parent owns the string state.
 */
import { useI18n } from '../lib/i18n';

export const AGENT_EMOJIS: readonly string[] = [
  '🤖', '🧠', '🔬', '🎯', '📊', '💡', '🛡️', '🚀',
  '📝', '🔧', '🎨', '📚', '🐾', '💼', '⚡', '🌙',
  '🔥', '🐚', '🏠', '🦞', '👨‍💻', '🧪', '📡', '🎭',
];

export const DEFAULT_AGENT_EMOJI = AGENT_EMOJIS[0];

interface AgentEmojiPickerProps {
  value: string;
  onChange: (emoji: string) => void;
  label?: string;
  size?: 'sm' | 'md';
}

export default function AgentEmojiPicker({ value, onChange, label, size = 'md' }: AgentEmojiPickerProps) {
  const { t } = useI18n();
  const resolvedLabel = label ?? t('agents.pickEmoji', 'Pick an icon:');
  const cellClass = size === 'sm' ? 'w-7 h-7 text-base' : 'w-9 h-9 text-lg';

  return (
    <div>
      {resolvedLabel && (
        <p className="text-[11px] text-slate-500 mb-2">{resolvedLabel}</p>
      )}
      <div className="grid grid-cols-8 gap-1.5">
        {AGENT_EMOJIS.map((emoji) => {
          const selected = value === emoji;
          return (
            <button
              key={emoji}
              type="button"
              onClick={() => onChange(emoji)}
              className={`${cellClass} rounded-lg flex items-center justify-center transition-all ${
                selected
                  ? 'bg-brand-500/20 ring-2 ring-brand-500 scale-110'
                  : 'bg-slate-800/50 hover:bg-slate-700/70'
              }`}
              aria-label={emoji}
              aria-pressed={selected}
              title={emoji}
            >
              {emoji}
            </button>
          );
        })}
      </div>
    </div>
  );
}
