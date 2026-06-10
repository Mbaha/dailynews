import { ReactNode } from 'react';

export function ReaderShell({ children }: { children: ReactNode }) {
  return <main className="app">{children}</main>;
}
