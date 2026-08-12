import type { AgentNode } from '../hooks/useReplay';

export function AgentTree({
  agents, viewKey, onSelect,
}: {
  agents: AgentNode[]; viewKey: string; onSelect: (key: string) => void;
}) {
  const children = (parent: string | null) => agents.filter((a) => a.parentKey === parent);

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

  return <div className="agentTree">{children(null).map((n) => renderNode(n, 0))}</div>;
}
