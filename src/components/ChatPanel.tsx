'use client';

import { FormEvent, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const mdComponents: Components = {
  h1: ({ children }) => <div className="chatH">{children}</div>,
  h2: ({ children }) => <div className="chatH">{children}</div>,
  h3: ({ children }) => <div className="chatH">{children}</div>,
  h4: ({ children }) => <div className="chatH chatHSub">{children}</div>,
  h5: ({ children }) => <div className="chatH chatHSub">{children}</div>,
  h6: ({ children }) => <div className="chatH chatHSub">{children}</div>,
  table: ({ children }) => <div className="chatTableWrap"><table className="chatTable">{children}</table></div>,
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => <th>{children}</th>,
  td: ({ children }) => <td>{children}</td>,
};

type Source = {
  n: number;
  issue_id: string;
  issue_date: string;
  file_name: string;
  page_number: number;
  source_kind?: 'element' | 'chunk';
  element_type?: string;
  title?: string | null;
};

function formatDate(iso: string): string {
  const [year, month, day] = iso.split('T')[0].split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(day)} ${months[Number(month) - 1]} ${year}`;
}

type AnalyseStep = { tool: string; description: string };

export function ChatPanel({ issueId }: { issueId: string | null }) {
  const router = useRouter();
  const [mode, setMode] = useState<'chat' | 'analyse'>('chat');
  const [scope, setScope] = useState<'archive' | 'current'>('archive');
  const [question, setQuestion] = useState(() =>
    typeof window !== 'undefined' ? (sessionStorage.getItem('chatDraft') ?? '') : ''
  );
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<Source[]>([]);
  const [steps, setSteps] = useState<AnalyseStep[]>([]);
  const [loading, setLoading] = useState(false);
  const [answerModel, setAnswerModel] = useState<'anthropic' | 'ollama' | null>(null);
  const [copiedAnswer, setCopiedAnswer] = useState(false);
  const [copiedQuestion, setCopiedQuestion] = useState(false);

  const copyAnswer = useCallback(() => {
    navigator.clipboard.writeText(answer);
    setCopiedAnswer(true);
    setTimeout(() => setCopiedAnswer(false), 1800);
  }, [answer]);

  const copyQuestion = useCallback(() => {
    navigator.clipboard.writeText(question);
    setCopiedQuestion(true);
    setTimeout(() => setCopiedQuestion(false), 1800);
  }, [question]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (question.trim().length < 3) return;
    sessionStorage.removeItem('chatDraft');
    setLoading(true);
    setAnswer('');
    setSources([]);
    setSteps([]);
    setAnswerModel(null);

    if (mode === 'analyse') {
      const response = await fetch('/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question })
      });
      const data = await response.json();
      setAnswer(data.answer ?? data.error ?? 'No answer returned.');
      if (Array.isArray(data.steps)) setSteps(data.steps);
      setLoading(false);
      return;
    }

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, scope, issueId })
    });

    if (response.headers.get('content-type')?.includes('application/json')) {
      const data = await response.json();
      setAnswer(data.answer ?? data.error ?? 'No answer returned.');
      setLoading(false);
      return;
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let metaBuf = '';
    let metaDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (!metaDone) {
        metaBuf += chunk;
        const nl = metaBuf.indexOf('\n');
        if (nl !== -1) {
          try {
            const meta = JSON.parse(metaBuf.slice(0, nl));
            if (Array.isArray(meta.sources)) setSources(meta.sources);
            if (meta.model === 'ollama') setAnswerModel('ollama');
            else setAnswerModel('anthropic');
          } catch {}
          metaDone = true;
          const remainder = metaBuf.slice(nl + 1);
          if (remainder) setAnswer(remainder);
        }
      } else {
        setAnswer((prev) => prev + chunk);
      }
    }

    setLoading(false);
  }

  const placeholder = mode === 'analyse'
    ? 'e.g. How many farm worker classified ads appeared in 2024, and how many are repeats?'
    : 'Ask about the full archive…';

  const buttonLabel = loading
    ? (mode === 'analyse' ? 'Analysing…' : 'Thinking…')
    : (mode === 'analyse' ? 'Analyse' : 'Ask dikgang');

  return (
    <section className="chatCard">
      <h3>Archive chat</h3>
      <div className="chatModeRow">
        <div className="miniSwitch">
          <button className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')} type="button">Chat</button>
          <button className={mode === 'analyse' ? 'active' : ''} onClick={() => setMode('analyse')} type="button">Analyse</button>
        </div>
        {mode === 'chat' && (
          <div className="miniSwitch">
            <button className={scope === 'archive' ? 'active' : ''} onClick={() => setScope('archive')} type="button">Archive</button>
            <button className={scope === 'current' ? 'active' : ''} onClick={() => setScope('current')} type="button" disabled={!issueId}>Current</button>
          </div>
        )}
      </div>
      {answer ? (
        <div className="chatEmpty">
          <div className="chatAnswerHeader">
            <button className="chatCopyBtn" onClick={copyAnswer} type="button">
              {copiedAnswer ? '✓ Copied' : 'Copy response'}
            </button>
            {answerModel === 'ollama' && (
              <span className="chatModelBadge" title="Anthropic unavailable — answered by local model">local model</span>
            )}
          </div>
          <Markdown components={mdComponents} remarkPlugins={[remarkGfm]}>{answer}</Markdown>
          {steps.length > 0 && (
            <div className="chatSteps">
              {steps.map((s, i) => (
                <span key={i} className="chatStepChip">{s.tool === 'sql' ? '⌗' : '⊙'} {s.description}</span>
              ))}
            </div>
          )}
          {sources.length > 0 && (
            <div className="chatSourceLinks">
              {sources.map((s) => (
                <button key={s.n} className="chatSourceChip" onClick={() => router.push(`/?issue=${s.issue_id}&page=${s.page_number}`)}>
                  <strong>[{s.n}]</strong> {formatDate(s.issue_date)} · p{s.page_number}
                  {s.element_type && s.element_type !== 'chunk' ? ` · ${s.element_type}` : ''}
                  {s.title ? ` · ${s.title.slice(0, 48)}${s.title.length > 48 ? '…' : ''}` : ''}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="muted">{mode === 'analyse' ? 'Ask a counting, trending, or pattern question across the full archive.' : 'Ask a question about this issue or the full archive.'}</p>
      )}
      <form onSubmit={submit}>
        <div className="chatTextareaWrap">
          <textarea
            value={question}
            onChange={(e) => { setQuestion(e.target.value); sessionStorage.setItem('chatDraft', e.target.value); }}
            placeholder={placeholder}
          />
          {question.trim().length > 0 && (
            <button className="chatCopyInline" onClick={copyQuestion} type="button">
              {copiedQuestion ? '✓' : 'Copy'}
            </button>
          )}
        </div>
        <button>{buttonLabel}</button>
      </form>
    </section>
  );
}
