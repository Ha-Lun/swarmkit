// Tiny inline stroke icons (16-24 viewBox), currentColor, no icon library.
import { useId } from 'react';
import type { ReactNode } from 'react';
import type { NodeKind } from '../shared/types';
import type { ToolKey } from './format';

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 14, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** SwarmKit brand mark: hexagon in the violet->teal gradient, optional wordmark. */
export function Logo({ size = 22, withWordmark = false }: IconProps & { withWordmark?: boolean }) {
  // Gradient id must be unique per mounted instance.
  const gid = `swk-grad-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <span className="logo">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gid} x1="4" y1="5" x2="27" y2="28" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#d9ccff" />
            <stop offset="1" stopColor="#2ee6c8" />
          </linearGradient>
        </defs>
        <path d="M16 2l12 7v14l-12 7-12-7V9z" fill={`url(#${gid})`} />
        <path d="M16 8.5l6.5 3.75v7.5L16 23.5l-6.5-3.75v-7.5L16 8.5z" fill="rgba(5,6,10,0.45)" />
      </svg>
      {withWordmark && (
        <span className="logo-word" style={{ fontSize: Math.max(13, Math.round(size * 0.82)) }}>
          SwarmKit
        </span>
      )}
    </span>
  );
}

export const HomeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 11l8-7 8 7" />
    <path d="M6 9.5V20h12V9.5" />
  </Svg>
);

export const MenuIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const ZoomInIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3M11 8v6M8 11h6" />
  </Svg>
);

export const ZoomOutIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3M8 11h6" />
  </Svg>
);

export const FitIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
  </Svg>
);

export const ChevronIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);

export const WarnIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5L21.5 20h-19L12 3.5Z" />
    <path d="M12 10v4.5M12 17.4h.01" />
  </Svg>
);

export const TerminalIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 17l6-6-6-6" />
    <path d="M12 19h8" />
  </Svg>
);

export const KeyIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="4.5" />
    <path d="M11.5 11.5L21 2M15.5 7.5l3 3" />
  </Svg>
);

export const UpIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Svg>
);

export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h3.6L11 8h8A1.5 1.5 0 0 1 20.5 9.5V18A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18V7Z" />
  </Svg>
);

// --- node kinds ---

export const MainIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9L12 3Z" />
    <path d="M19 17.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z" />
  </Svg>
);

export const SubagentIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="5" r="2.4" />
    <circle cx="18" cy="5" r="2.4" />
    <circle cx="12" cy="19" r="2.4" />
    <path d="M6 7.6V10a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V7.6" />
  </Svg>
);

export const WorkerIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="13" height="13" rx="2.5" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    <path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3" />
  </Svg>
);

export function kindIcon(kind: NodeKind, size = 14) {
  if (kind === 'subagent') return <SubagentIcon size={size} />;
  if (kind === 'worker') return <WorkerIcon size={size} />;
  return <MainIcon size={size} />;
}

// --- tool glyphs ---

const ReadGlyph = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
  </Svg>
);

const EditGlyph = (p: IconProps) => (
  <Svg {...p}>
    <path d="M17 3.5a2.6 2.6 0 1 1 3.7 3.7L7.6 20.3 2.5 21.7l1.4-5.1L17 3.5Z" />
  </Svg>
);

const SearchGlyph = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </Svg>
);

const WebGlyph = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </Svg>
);

const AgentGlyph = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="3.6" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.85" />
    <path d="M16.5 3.6a3.6 3.6 0 0 1 0 6.8" />
  </Svg>
);

const OtherGlyph = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="M3.3 7l8.7 5 8.7-5M12 22V12" />
  </Svg>
);

export function toolIcon(key: ToolKey, size = 12) {
  switch (key) {
    case 'read':
      return <ReadGlyph size={size} />;
    case 'edit':
      return <EditGlyph size={size} />;
    case 'bash':
      return <TerminalIcon size={size} />;
    case 'search':
      return <SearchGlyph size={size} />;
    case 'web':
      return <WebGlyph size={size} />;
    case 'agent':
      return <AgentGlyph size={size} />;
    default:
      return <OtherGlyph size={size} />;
  }
}
