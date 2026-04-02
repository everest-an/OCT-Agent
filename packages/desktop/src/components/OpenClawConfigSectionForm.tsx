import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import PasswordInput from './PasswordInput';
import type { DynamicConfigSection } from '../lib/openclaw-capabilities';

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
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

export default function OpenClawConfigSectionForm({
  sections,
  values,
  onChange,
}: {
  sections: DynamicConfigSection[];
  values: Record<string, any>;
  onChange: (path: string, nextValue: any) => void;
}) {
  const inputClass = 'w-full px-3 py-2.5 bg-slate-900 border border-slate-600 rounded-lg text-sm focus:outline-none focus:border-brand-500 transition-colors';
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sections.map((section) => [section.key, Boolean(section.defaultExpanded)])),
  );

  const getSummary = (section: DynamicConfigSection) => {
    if (section.key === 'search') {
      const provider = values?.['tools.web.search.provider'];
      const enabled = values?.['tools.web.search.enabled'];
      const apiKey = values?.['tools.web.search.apiKey'];
      return [
        enabled === false ? 'disabled' : 'enabled',
        provider ? `provider: ${provider}` : 'provider: default',
        apiKey ? 'credential set' : 'using default credential source',
      ].join(' · ');
    }

    if (section.key === 'fetch') {
      const enabled = values?.['tools.web.fetch.enabled'];
      const customized = section.fields.filter((field) => values?.[field.path] !== undefined && values?.[field.path] !== '').length;
      return [
        enabled === false ? 'disabled' : 'enabled',
        customized > 0 ? `${customized} custom values` : 'all defaults',
        'usually no action needed',
      ].join(' · ');
    }

    return 'Uses OpenClaw defaults unless overridden below';
  };

  return (
    <div className="space-y-4">
      {sections.map((section) => {
        let lastGroup: string | undefined;
        const primaryFields = section.fields.filter((field) => field.prominence !== 'advanced');
        const advancedFields = section.fields.filter((field) => field.prominence === 'advanced');
        const visibleFields = expandedSections[section.key] ? section.fields : primaryFields;
        const showAdvancedToggle = advancedFields.length > 0;
        const isExpanded = expandedSections[section.key];

        return (
          <div key={section.key} className="rounded-xl border border-slate-700/50 bg-slate-800/40">
            <div className="px-4 py-3 border-b border-slate-700/50 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-slate-100">{section.title}</div>
                  {section.description && <div className="text-xs text-slate-500 mt-1">{section.description}</div>}
                </div>
                {showAdvancedToggle && (
                  <button
                    onClick={() => setExpandedSections((prev) => ({ ...prev, [section.key]: !prev[section.key] }))}
                    className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 transition-colors whitespace-nowrap"
                  >
                    {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {isExpanded ? 'Hide advanced' : `Show advanced (${advancedFields.length})`}
                  </button>
                )}
              </div>
              <div className="text-[11px] text-slate-500">{getSummary(section)}</div>
            </div>

            <div className="divide-y divide-slate-700/50">
              {!isExpanded && visibleFields.length === 0 ? (
                <div className="px-4 py-3 text-xs text-slate-500">
                  Hidden by default to keep this page short. Open advanced only if you need to fine-tune this behavior.
                </div>
              ) : null}
              {visibleFields.map((field) => {
                const currentValue = values?.[field.path];
                const showGroup = field.group && field.group !== lastGroup;
                lastGroup = field.group;
                const defaultLabel = field.defaultValue !== undefined ? String(field.defaultValue) : 'OpenClaw default';

                return (
                  <div key={field.key} className="px-4 py-3 space-y-2">
                    {showGroup && <div className="text-xs font-medium uppercase tracking-wider text-slate-500">{field.group}</div>}
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="text-sm font-medium text-slate-100">{field.label}</div>
                        {field.description && <div className="text-xs text-slate-500 mt-1">{field.description}</div>}
                      </div>
                      <div className="w-[220px] max-w-full">
                        {field.type === 'boolean' ? (
                          <div className="flex justify-end">
                            <Toggle checked={Boolean(currentValue)} onChange={(nextValue) => onChange(field.path, nextValue)} />
                          </div>
                        ) : field.type === 'select' ? (
                          <select
                            value={typeof currentValue === 'string' ? currentValue : ''}
                            onChange={(event) => onChange(field.path, event.target.value)}
                            className={inputClass}
                          >
                            <option value="">Use default ({defaultLabel})</option>
                            {(field.options || []).map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        ) : field.type === 'number' ? (
                          <input
                            type="number"
                            value={typeof currentValue === 'number' ? String(currentValue) : ''}
                            placeholder={defaultLabel}
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            onChange={(event) => {
                              const nextValue = event.target.value;
                              onChange(field.path, nextValue === '' ? undefined : Number(nextValue));
                            }}
                            className={inputClass}
                          />
                        ) : field.type === 'password' ? (
                          <PasswordInput
                            value={typeof currentValue === 'string' ? currentValue : ''}
                            onChange={(event) => onChange(field.path, event.target.value)}
                            placeholder={field.defaultValue !== undefined ? `Default: ${defaultLabel}` : 'Use default secret source'}
                            className={inputClass}
                          />
                        ) : (
                          <input
                            type="text"
                            value={typeof currentValue === 'string' ? currentValue : ''}
                            placeholder={field.defaultValue !== undefined ? `Default: ${defaultLabel}` : 'Use OpenClaw default'}
                            onChange={(event) => onChange(field.path, event.target.value)}
                            className={inputClass}
                          />
                        )}
                        {currentValue === undefined || currentValue === '' ? (
                          <div className="mt-1 text-[10px] text-slate-600">Default in effect: {defaultLabel}</div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}