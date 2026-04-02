import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export function SettingsToggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`w-11 h-6 rounded-full transition-colors relative ${checked ? 'bg-brand-600' : 'bg-slate-700'}`}
    >
      <div
        className="w-5 h-5 rounded-full bg-white absolute top-0.5 transition-transform"
        style={{ transform: checked ? 'translateX(21px)' : 'translateX(1px)' }}
      />
    </button>
  );
}

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wider">{title}</h3>
      <div className="bg-slate-800/50 rounded-xl border border-slate-700/50 divide-y divide-slate-700/50">
        {children}
      </div>
    </div>
  );
}

export function SettingsRow({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between p-4">
      <div className="flex-1 mr-4">
        <div className="text-sm font-medium">{label}</div>
        {desc && <div className="text-xs text-slate-500 mt-0.5">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

export function SettingsModalShell({
  title,
  onClose,
  children,
  footer,
  maxWidthClass = 'max-w-2xl',
  maxHeightClass = 'max-h-[85vh]',
  paddingClass = 'p-5',
  zIndexClass = 'z-50',
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  maxWidthClass?: string;
  maxHeightClass?: string;
  paddingClass?: string;
  zIndexClass?: string;
}) {
  return (
    <div className={`fixed inset-0 bg-black/60 flex items-center justify-center ${zIndexClass} p-8`}>
      <div className={`bg-slate-900 border border-slate-700 rounded-2xl w-full ${maxWidthClass} ${maxHeightClass} overflow-hidden flex flex-col`}>
        <div className="flex items-center justify-between p-5 border-b border-slate-800">
          <div className="text-lg font-semibold">{title}</div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X size={20} />
          </button>
        </div>
        <div className={`flex-1 overflow-y-auto ${paddingClass}`}>
          {children}
        </div>
        {footer && <div className="border-t border-slate-800">{footer}</div>}
      </div>
    </div>
  );
}