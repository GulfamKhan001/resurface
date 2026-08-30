import { pool } from "./db.ts";

// Search — the thing the project is named for, and the last thing built.
//
// The index has existed since migration 003; nothing ever queried it. That is
// worth stating plainly rather than quietly fixing: for five weeks this could
// ingest, extract, verify, trace and bill for work, and the one sentence on the
// tin — "makes it searchable" — was the only part with no code behind it. The
// infrastructure was more interesting to build than the feature, and that is
// exactly how a system ends up impressive and useless.

export interface Hit {
  title: string;
  detail: string;
  kind: string;
  trust: number;
  quote: string;
  sourceTitle: string | null;
  sourceKind: string;
  rank: number;
}

// websearch_to_tsquery, not plainto_tsquery: it understands quoted phrases and
// OR/-negation the way a person already expects from every other search box, and
// unlike to_tsquery it cannot be made to throw by a stray character. A search box
// that 500s on an apostrophe is not a search box.
//
// The ORDER BY expression is deliberately rank * trust rather than rank alone.
// A perfectly-matching item that failed grounding is worse than a loose match
// that was verified against the source — relevance without trust just ranks the
// confident fabrications first.
// The ranking lives in a subquery because Postgres will accept a bare output name
// in ORDER BY but not that name inside an EXPRESSION — `order by rank * trust`
// fails with "column rank does not exist". Repeating the whole ts_rank call in the
// ORDER BY would work and would also mean the tsvector gets built twice per row.
const SQL = `
  select * from (
    select i.title, i.detail, i.kind, i.trust, i.quote,
           a.title as source_title, a.source_kind,
           ts_rank(to_tsvector('english', i.title || ' ' || i.detail),
                   websearch_to_tsquery('english', $1)) as rank
      from items i
      join assets a on a.id = i.asset_id
     where to_tsvector('english', i.title || ' ' || i.detail)
           @@ websearch_to_tsquery('english', $1)
  ) h
   order by h.rank * greatest(h.trust, 0.01) desc, h.trust desc
   limit $2`;

export async function search(query: string, limit = 10): Promise<Hit[]> {
  const q = query.trim();
  if (!q) return [];
  const { rows } = await pool.query<{
    title: string; detail: string; kind: string; trust: string; quote: string;
    source_title: string | null; source_kind: string; rank: number;
  }>(SQL, [q, limit]);

  return rows.map((r) => ({
    title: r.title,
    detail: r.detail,
    kind: r.kind,
    trust: Number(r.trust),
    quote: r.quote,
    sourceTitle: r.source_title,
    sourceKind: r.source_kind,
    rank: r.rank,
  }));
}
