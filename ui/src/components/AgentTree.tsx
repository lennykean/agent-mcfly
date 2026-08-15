import { useRef } from 'react';
import { actionOf } from '../lib/keys';
import { rgba } from '../lib/palette';

// a node in the (possibly multi-root) agents tree; keys are opaque to this
// component — the App prefixes them with the owning workspace
export interface TreeAgent {
  key: string;
  parentKey: string | null;
  label: string;
  agentType?: string;
  color?: string; // the root's hue; rows get a tinted background
  root?: boolean; // a top-level agent (broadcast icon, closable)
  // a workspace GROUP row: pure grouping, informational — it cannot be
  // opened or selected, only collapsed
  kind?: 'workspace';
  pwd?: string; // the group row's project folder (terminal quick-launch)
}

// The agents list is its OWN panel, not a tab of the strip below it: plain
// arrows walk (soft select), left/right collapse/expand subagent subtrees at
// any depth, Enter switches views, and Up past the first row reaches the
// header action. Crossing into another panel still takes panelUp/panelDown.
export function AgentTree({
  agents, viewKey, collapsed, onToggle, onSelect, onCloseRoot, onOpenTerminal, onEscapeTop,
}: {
  agents: TreeAgent[]; viewKey: string;
  // collapse state is CONTROLLED: every mounted workbench renders this same
  // panel, so the folds live in the shell — one truth across root switches
  collapsed: ReadonlySet<string>; onToggle: (key: string) => void;
  onSelect: (key: string) => void;
  // when set, top-level rows offer a ✕ that closes their root workspace
  onCloseRoot?: (key: string) => void;
  // when set, workspace group rows offer a terminal icon: new shell there
  onOpenTerminal?: (key: string) => void;
  // ArrowUp from the first row moves to the AGENTS header action.
  onEscapeTop?: () => void;
}) {
  const children = (parent: string | null) => agents.filter((a) => a.parentKey === parent);
  const byKey = new Map(agents.map((a) => [a.key, a]));
  const toggle = onToggle;

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
    const action = actionOf(e, ['up', 'down', 'left', 'right', 'home', 'end', 'activate', 'dismiss']);
    if (!action) return;
    if (!rows.length) {
      if (action === 'up' && onEscapeTop) {
        e.preventDefault();
        e.stopPropagation();
        onEscapeTop();
      }
      return;
    }
    let i = Math.max(0, Math.min(cursor.current, rows.length - 1));
    const key = rows[i]?.dataset.key ?? '';
    const node = byKey.get(key);
    const kids = node ? children(node.key).length > 0 : false;
    switch (action) {
      case 'up':
        if (i === 0 && onEscapeTop) {
          e.preventDefault();
          e.stopPropagation();
          cursor.current = -1;
          paintBar();
          onEscapeTop();
          return;
        }
        i = Math.max(0, i - 1);
        break;
      case 'down': i = Math.min(rows.length - 1, cursor.current < 0 ? 0 : i + 1); break;
      case 'home': i = 0; break;
      case 'end': i = rows.length - 1; break;
      case 'activate': rows[i]?.click(); break;
      case 'left':
        // collapse an open subtree, else hop to the parent row
        if (kids && !collapsed.has(key)) toggle(key);
        else if (node?.parentKey) {
          const pi = rows.findIndex((r2) => r2.dataset.key === node.parentKey);
          if (pi >= 0) i = pi;
        }
        break;
      case 'right':
        // expand a closed subtree, else step into the first child
        if (kids && collapsed.has(key)) toggle(key);
        else if (kids) i = Math.min(rows.length - 1, i + 1);
        break;
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

  const renderNode = (node: TreeAgent, depth: number) => {
    const kids = children(node.key);
    const closed = collapsed.has(node.key);
    return (
      <div key={node.key}>
        <div
          className={`agentRow ${node.key === viewKey ? 'active' : ''} ${node.kind === 'workspace' ? 'wsGroupRow' : ''}`}
          style={{
            paddingLeft: 4 + depth * 14,
            background: node.color && node.key !== viewKey ? rgba(node.color, 0.14) : undefined,
          }}
          data-key={node.key}
          onClick={() => (node.kind === 'workspace' ? toggle(node.key) : onSelect(node.key))}
          title={node.label}
        >
          {kids.length > 0 ? (
            <span
              className={`codicon codicon-chevron-${closed ? 'right' : 'down'} agentChevron`}
              onClick={(e) => { e.stopPropagation(); toggle(node.key); }}
            />
          ) : <span className="agentChevron" />}
          <span className={`codicon ${node.kind === 'workspace' ? 'codicon-folder' : node.root ? 'codicon-broadcast' : 'codicon-hubot'} agentIcon`} />
          <span className="agentLabel">
            {node.agentType ? `[${node.agentType}] ` : ''}
            {node.label}
          </span>
          {onOpenTerminal && node.kind === 'workspace' && (
            <span
              className="codicon codicon-terminal wsTermBtn"
              title={`New terminal in ${node.label}`}
              onClick={(e) => { e.stopPropagation(); onOpenTerminal(node.key); }}
            />
          )}
          {onCloseRoot && node.root && (
            <span
              className="codicon codicon-close rootClose"
              title="Close this root workspace"
              onClick={(e) => { e.stopPropagation(); onCloseRoot(node.key); }}
            />
          )}
        </div>
        {!closed && kids.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="agentTree" ref={boxRef} tabIndex={-1} onKeyDown={onKeyDown} onMouseDown={onMouseDown}>
      <div className="expCursor" ref={barRef} style={{ display: 'none' }} />
      {children(null).map((n) => renderNode(n, 0))}
    </div>
  );
}
