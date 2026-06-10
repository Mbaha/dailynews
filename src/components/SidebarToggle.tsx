'use client';

import { useEffect, useState } from 'react';

export function SidebarToggle() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('sidebarCollapsed') === '1';
    setCollapsed(saved);
    if (saved) document.documentElement.dataset.sidebar = 'collapsed';
  }, []);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    if (next) {
      document.documentElement.dataset.sidebar = 'collapsed';
      localStorage.setItem('sidebarCollapsed', '1');
    } else {
      delete document.documentElement.dataset.sidebar;
      localStorage.setItem('sidebarCollapsed', '0');
    }
  }

  return (
    <button
      className="sidebarToggleBtn"
      onClick={toggle}
      aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
      title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
    >
      {collapsed ? '›' : '‹'}
    </button>
  );
}
