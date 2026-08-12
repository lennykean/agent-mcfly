import type { DataView } from '../lib/timeline';

export function DataPane({ data, animate }: { data?: DataView; animate: boolean }) {
  if (!data) return <div className="emptyHint">tabular tool results will show here</div>;
  return (
    <div key={data.touchedAt} className={`dataPane ${animate ? 'fresh' : ''}`}>
      <div className="dataTitle">{data.title}</div>
      <div className="dataScroll">
        <table>
          <thead><tr>{data.table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>
            {data.table.rows.map((row, i) => (
              <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
