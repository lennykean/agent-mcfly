import { useEffect, useState } from 'react';
import { Splitter } from './Splitter';
import type { DataView } from '../lib/timeline';

// The DATA tab: title, the query that produced it (resizable via the same
// splitter as every other pane, two lines by default), then the table — or a
// red error plus the raw output when the result is not tabular. Renders from
// the call on, before any result exists.
export function DataPane({ data, animate }: { data?: DataView; animate: boolean }) {
  const [queryH, setQueryH] = useState(() => Number(localStorage.getItem('mcfly.dataQueryH')) || 42);
  useEffect(() => { localStorage.setItem('mcfly.dataQueryH', String(queryH)); }, [queryH]);
  if (!data) return <div className="emptyHint">tabular tool results will show here</div>;
  return (
    <div key={data.touchedAt} className={`dataPane ${animate ? 'fresh' : ''}`}>
      <div className="dataTitle">{data.title}</div>
      {data.query && (
        <>
          <pre className="dataQuery" style={{ height: queryH }}>{data.query}</pre>
          <Splitter dir="row" onDrag={(dy) => setQueryH((h) => Math.max(25, Math.min(400, h + dy)))} />
        </>
      )}
      {data.table ? (
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
      ) : data.error ? (
        <div className="dataScroll">
          <div className="dataError">could not render results to a table</div>
          {data.raw && <pre className="dataRaw">{data.raw}</pre>}
        </div>
      ) : (
        <div className="emptyHint">running…</div>
      )}
    </div>
  );
}
