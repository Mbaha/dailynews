'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

type SearchResult = {
  chunk_id: string;
  issue_id: string;
  issue_date: string;
  file_name: string;
  page_number: number;
  snippet: string;
  source_kind?: 'element' | 'chunk';
  element_type?: string;
  title?: string | null;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function safeSnippet(value: string, preserveHighlights: boolean) {
  const escaped = escapeHtml(value);
  if (!preserveHighlights) return `${escaped.slice(0, 420)}…`;
  return escaped.replaceAll('&lt;b&gt;', '<b>').replaceAll('&lt;/b&gt;', '</b>');
}

export function SearchPanel({ issueId }: { issueId: string | null }) {
  const [scope, setScope] = useState<'archive' | 'current'>('archive');
  const [mode, setMode] = useState<'hybrid' | 'keyword' | 'semantic'>('hybrid');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setResults([]);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setLoading(true);
    const params = new URLSearchParams({ q: query, scope });
    if (issueId) params.set('issueId', issueId);
    const endpoint = mode === 'hybrid' ? '/api/hybrid-search' : mode === 'semantic' ? '/api/semantic-search' : '/api/search';
    const response = await fetch(`${endpoint}?${params}`);
    const data = await response.json();
    setResults(data.results ?? []);
    setLoading(false);
  }

  return (
    <div className="searchPanel" ref={containerRef}>
      <div className="topbar">
        <div className="scopeSwitch" aria-label="Search scope">
          <button type="button" className={scope === 'archive' ? 'active' : ''} onClick={() => setScope('archive')}>Archive</button>
          <button type="button" className={scope === 'current' ? 'active' : ''} onClick={() => setScope('current')} disabled={!issueId}>Current paper</button>
        </div>
        <div className="miniSwitch searchMode">
          <button type="button" className={mode === 'hybrid' ? 'active' : ''} onClick={() => setMode('hybrid')}>Hybrid</button>
          <button type="button" className={mode === 'keyword' ? 'active' : ''} onClick={() => setMode('keyword')}>Keyword</button>
          <button type="button" className={mode === 'semantic' ? 'active' : ''} onClick={() => setMode('semantic')}>Semantic</button>
        </div>
        <form className="searchBox" onSubmit={submit}>
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); if (!e.target.value.trim()) setResults([]); }}
            placeholder="Search the archive — diamonds, kgotla, sport, tenders…"
          />
          <button type="submit">{loading ? 'Searching…' : 'Search'}</button>
        </form>
      </div>

      {results.length > 0 && (
        <section className="searchResults">
          <div className="resultsHeader">
            <span>{results.length} {mode} matches</span>
            <button className="resultsClose" type="button" onClick={() => setResults([])} aria-label="Close results">×</button>
          </div>
          {results.map((result) => (
            <a className="resultItem" key={result.chunk_id} href={`/?issue=${result.issue_id}&page=${result.page_number}`}>
              <div>
                <strong>{result.issue_date} · page {result.page_number}{result.element_type && result.element_type !== 'chunk' ? ` · ${result.element_type}` : ''}</strong>
                <span>{result.title ? `${result.title} · ` : ''}{result.file_name}</span>
              </div>
              <p dangerouslySetInnerHTML={{ __html: safeSnippet(result.snippet, mode !== 'semantic') }} />
            </a>
          ))}
        </section>
      )}
    </div>
  );
}
