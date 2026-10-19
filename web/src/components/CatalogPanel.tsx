import { useState } from 'react';
import { searchCatalog } from '../api';
export function CatalogResults({ result }: { result: Awaited<ReturnType<typeof searchCatalog>> }) {
  return <div><p>Retrieved {result.retrievedAt}</p>{result.products.length === 0 ? <p>No catalog matches.</p> : <ul>{result.products.map((p, i) => <li key={`${p.id}-${i}`}><strong>{p.title}</strong>{p.description && <p>{p.description}</p>}</li>)}</ul>}</div>;
}
export function CatalogPanel() {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof searchCatalog>>>();
  return <details className="catalog-panel"><summary>Current catalog reference (optional)</summary>
    <p>Current product context only. This does not prove a historical purchase, delivery, condition or disputed transaction. Results are not added to evidence or recommendations.</p>
    <p>Live lookup is disabled pending free-only account verification and a replacement key. Enter only a public product name or model, never customer or transaction details.</p>
    <form onSubmit={async event => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); setResult(undefined); try { setResult(await searchCatalog(query)); } catch (e) { setError(e instanceof Error ? e.message : 'Catalog unavailable.'); } finally { setBusy(false); } }}>
      <label>Public product name or model <input value={query} onChange={e => setQuery(e.target.value)} minLength={2} maxLength={160} required /></label>
      <button disabled={busy || query.trim().length < 2}>{busy ? 'Searching…' : 'Search catalog'}</button>
    </form><p role="status">{error}</p>{result && <CatalogResults result={result} />}
  </details>;
}
