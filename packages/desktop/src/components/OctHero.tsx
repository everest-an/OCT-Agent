/**
 * OCT Agent hero section.
 * Used on empty state / first-load screens.
 */
import { useState } from 'react';
import logoUrl from '../assets/logo.svg';

// Attempt to import the hero image; gracefully fall back if it is not present.
let heroImageUrl: string | null = null;
try {
  // @ts-ignore dynamic import may fail if the optional asset is not present.
  heroImageUrl = new URL('../assets/oct-hero.png', import.meta.url).href;
} catch {
  heroImageUrl = null;
}

interface OctHeroProps {
  showMarquee?: boolean;
  subtitle?: string;
  size?: 'sm' | 'md' | 'lg';
}

const STATS = [
  'OCT Agent',
  '95.6% Recall@5',
  '0 LLM calls on recall',
  '8 parallel agents',
  'Persistent Memory',
  'Windows / macOS / Linux',
  '247K+ OpenClaw Stars',
  'OCT Agent',
  '95.6% Recall@5',
  '0 LLM calls on recall',
  '8 parallel agents',
  'Persistent Memory',
  'Windows / macOS / Linux',
  '247K+ OpenClaw Stars',
];

export default function OctHero({ showMarquee = true, subtitle, size = 'md' }: OctHeroProps) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);

  const sizeMap = {
    sm: { container: 'w-16 h-16', logo: 'w-10 h-10', heading: 'text-xl', sub: 'text-xs' },
    md: { container: 'w-28 h-28', logo: 'w-16 h-16', heading: 'text-3xl', sub: 'text-sm' },
    lg: { container: 'w-40 h-40', logo: 'w-24 h-24', heading: 'text-5xl', sub: 'text-base' },
  };
  const sz = sizeMap[size];

  return (
    <div className="flex flex-col items-center gap-4 select-none">
      <div className={`relative ${sz.container}`}>
        <div
          className="absolute inset-[-30%] rounded-full pointer-events-none"
          style={{
            background: 'radial-gradient(circle, rgb(184 126 255 / 0.25) 0%, rgb(123 95 255 / 0.15) 40%, transparent 70%)',
            animation: 'oct-glow-pulse 4s ease-in-out infinite',
          }}
        />

        <div className={`${sz.container} oct-jellyfish-frame relative z-10 flex items-center justify-center`}>
          {heroImageUrl && !imgError ? (
            <>
              <img
                src={heroImageUrl}
                alt="OCT Agent"
                className={`w-full h-full object-cover transition-opacity duration-700 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
                onLoad={() => setImgLoaded(true)}
                onError={() => setImgError(true)}
              />
              {!imgLoaded && (
                <div className="absolute inset-0 flex items-center justify-center oct-logo-wrap rounded-full">
                  <img src={logoUrl} alt="OCT" className={`${sz.logo} rounded-2xl object-cover`} />
                </div>
              )}
            </>
          ) : (
            <div className="w-full h-full oct-logo-wrap rounded-full flex items-center justify-center">
              <img src={logoUrl} alt="OCT Agent" className={`${sz.logo} rounded-2xl object-cover`} />
            </div>
          )}
        </div>
      </div>

      <div className="text-center">
        <h2 className={`${sz.heading} font-bold tracking-tight oct-brand-text leading-none`}>
          OCT Agent
        </h2>
        {subtitle && (
          <p className={`${sz.sub} text-slate-500 mt-1.5`}>{subtitle}</p>
        )}
      </div>

      {showMarquee && (
        <div className="oct-marquee-wrap w-full max-w-xs">
          <div className="oct-marquee-track gap-4">
            {STATS.map((stat, i) => (
              <span
                key={i}
                className="oct-stat-pill whitespace-nowrap flex-shrink-0"
              >
                {stat}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
