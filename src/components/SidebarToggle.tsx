'use client';

import { useEffect, useState } from 'react';

export function SidebarToggle() {
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    const saved = localStorage.getItem('sidebarCollapsed');
    const isCollapsed = saved === null ? true : saved === '1';
    setCollapsed(isCollapsed);
    if (isCollapsed) document.documentElement.dataset.sidebar = 'collapsed';
    else delete document.documentElement.dataset.sidebar;
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
