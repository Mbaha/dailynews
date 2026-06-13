'use client';
import { useState } from 'react';

type Tab = 'browse' | 'read' | 'ask';

const BrowseIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </svg>
);

const ReadIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="20" height="18" rx="2" />
    <line x1="7" y1="9" x2="17" y2="9" />
    <line x1="7" y1="13" x2="17" y2="13" />
    <line x1="7" y1="17" x2="13" y2="17" />
  </svg>
);

const AskIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

export function MobileTabShell({ children }: { children: React.ReactNode }) {
  const [tab, setTab] = useState<Tab>('read');
  return (
    <div className="mobileTabShell" data-tab={tab}>
      {children}
      <nav className="mobileTabBar" aria-label="Main sections">
        <button className={`mobileTab${tab === 'browse' ? ' active' : ''}`} onClick={() => setTab('browse')} aria-pressed={tab === 'browse'}>
          <BrowseIcon />
          <span>Browse</span>
        </button>
        <button className={`mobileTab${tab === 'read' ? ' active' : ''}`} onClick={() => setTab('read')} aria-pressed={tab === 'read'}>
          <ReadIcon />
          <span>Read</span>
        </button>
        <button className={`mobileTab${tab === 'ask' ? ' active' : ''}`} onClick={() => setTab('ask')} aria-pressed={tab === 'ask'}>
          <AskIcon />
          <span>Ask</span>
        </button>
      </nav>
    </div>
  );
}
