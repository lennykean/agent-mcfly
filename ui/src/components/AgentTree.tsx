import { useRef } from 'react';
import { actionOf } from '../lib/keys';
import type { AgentNode } from '../hooks/useReplay';

// The agents list is its OWN panel, not a tab of the strip below it: plain
// arrows walk (soft select) and Enter switches views, but no arrow leaves
// the panel — crossing panels takes the panelUp/panelDown chord, handled by
// the sidebar above this component.
export function AgentTree({
  agents, viewKey, onSelect,
}: {
  agents: AgentNode[]; viewKey: string; onSelect: (key: string) => void;
}) {
  const children = (parent: string | null) => agents.filter((a) => a.parentKey === parent);

  const boxRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const cursor = useRef(-1);
  const rowsNow = () => [...(boxRef.current?.querySelectorAll('.agentRow') ?? [])] as HTMLElement[];
  const paintBar = () => {
    const bar = barRef.current;
    const row = rowsNow()[cursor.current];
    if (!bar) return;
    if (!row) { bar.style.display = 'none'; return; }
    bar.style.display = 'block';
    bar.style.top = `${row.offsetTop}px`;
    bar.style.height = `${row.offsetHeight}px`;
    row.scrollIntoView({ block: 'nearest' });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const rows = rowsNow();
    if (!rows.length) return;
    const action = actionOf(e, ['up', 'down', 'home', 'end', 'activate', 'dismiss']);
    if (!action) return;
    let i = Math.max(0, Math.min(cursor.current, rows.length - 1));
    switch (action) {
      case 'up': i = Math.max(0, i - 1); break;
      case 'down': i = Math.min(rows.length - 1, cursor.current < 0 ? 0 : i + 1); break;
      case 'home': i = 0; break;
      case 'end': i = rows.length - 1; break;
      case 'activate': rows[i]?.click(); break;
      case 'dismiss': (e.target as HTMLElement).blur(); cursor.current = -1; paintBar(); break;
    }
    e.preventDefault();
    e.stopPropagation();
    if (action !== 'dismiss') {
      cursor.current = i;
      requestAnimationFrame(paintBar);
    }
  };
  const onMouseDown = (e: React.MouseEvent) => {
    const row = (e.target as Element).closest?.('.agentRow') as HTMLElement | null;
    if (!row) return;
    // preventDefault: the browser's default would move focus to <body>
    e.preventDefault();
    const idx = rowsNow().indexOf(row);
    if (idx >= 0) cursor.current = idx;
    // focus AFTER the mousedown sequence (Chromium reverts an in-handler focus)
    requestAnimationFrame(() => {
      boxRef.current?.focus();
      paintBar();
    });
  };

  const renderNode = (node: AgentNode, depth: number) => (
    <div key={node.key}>
      <div
        className={`agentRow ${node.key === viewKey ? 'active' : ''}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => onSelect(node.key)}
        title={node.label}
      >
        <span className={`codicon ${node.parentKey === null ? 'codicon-broadcast' : 'codicon-hubot'} agentIcon`} />
        {node.agentType ? `[${node.agentType}] ` : ''}
        {node.label}
      </div>
      {children(node.key).map((c) => renderNode(c, depth + 1))}
    </div>
  );

  return (
    <div className="agentTree" ref={boxRef} tabIndex={-1} onKeyDown={onKeyDown} onMouseDown={onMouseDown}>
      <div className="expCursor" ref={barRef} style={{ display: 'none' }} />
      {children(null).map((n) => renderNode(n, 0))}
    </div>
  );
}
