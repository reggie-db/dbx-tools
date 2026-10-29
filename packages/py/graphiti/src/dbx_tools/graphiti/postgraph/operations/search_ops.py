from __future__ import annotations

import json
import logging
from typing import Any

from graphiti_core.driver.operations.search_ops import SearchOperations
from graphiti_core.driver.query_executor import QueryExecutor
from graphiti_core.edges import EntityEdge
from graphiti_core.helpers import parse_db_date
from graphiti_core.nodes import CommunityNode, EntityNode, EpisodeType, EpisodicNode
from graphiti_core.search.search_filters import SearchFilters

logger = logging.getLogger(__name__)


class PGSearchOperations(SearchOperations):
    # --- Node search ---

    async def node_fulltext_search(
        self,
        executor: QueryExecutor,
        query: str,
        search_filter: SearchFilters,
        group_ids: list[str] | None = None,
        limit: int = 10,
    ) -> list[EntityNode]:
        ts_query = _build_ts_query(query)
        if not ts_query:
            return []

        client = executor.client
        conditions, params = _node_filter_conditions(search_filter, group_ids)
        params.append(ts_query)
        ts_idx = len(params)

        where = _where(conditions)
        and_kw = 'AND' if conditions else 'WHERE'

        sql = f"""
            SELECT realm, id, payload, created_at,
                   to_jsonb(t)->>'embedding' AS embedding_text,
                   ts_rank(search_vector, plainto_tsquery('simple', ${ts_idx})) AS score
            FROM "entity_nodes" t
            {where}
              {and_kw} search_vector @@ plainto_tsquery('simple', ${ts_idx})
            ORDER BY score DESC
            LIMIT {limit}
        """
        rows = await client._fetch(sql, *params)
        return [_parse_entity(r) for r in rows]

    async def node_similarity_search(
        self,
        executor: QueryExecutor,
        search_vector: list[float],
        search_filter: SearchFilters,
        group_ids: list[str] | None = None,
        limit: int = 10,
        min_score: float = 0.6,
    ) -> list[EntityNode]:
        client = executor.client
        results: list[tuple[float, EntityNode]] = []
        for realm in await _resolve_realms(client, 'entity_nodes', group_ids):
            hits = await client.vector_search(
                'entity_nodes',
                realm,
                search_vector,
                top_k=limit,
                distance_metric='cosine',
            )
            results.extend(_matching_node_hits(hits, search_filter, min_score))

        results.sort(key=lambda result: result[0], reverse=True)
        return [node for _, node in results[:limit]]

    async def node_bfs_search(
        self,
        executor: QueryExecutor,
        origin_uuids: list[str],
        search_filter: SearchFilters,
        max_depth: int,
        group_ids: list[str] | None = None,
        limit: int = 10,
    ) -> list[EntityNode]:
        if not origin_uuids or max_depth < 1:
            return []

        client = executor.client
        results: list[EntityNode] = []
        seen: set[str] = set()

        for origin_uuid in origin_uuids:
            origin = await _resolve_origin(client, origin_uuid, group_ids)
            if origin is None:
                continue
            realm, vertex_id = origin
            traversal = await _traverse_from_node(client, realm, vertex_id, max_depth)
            results.extend(
                await _nodes_from_traversal(
                    client,
                    realm,
                    traversal,
                    search_filter,
                    seen,
                    limit - len(results),
                )
            )
            if len(results) >= limit:
                break

        return results[:limit]

    # --- Edge search ---

    async def edge_fulltext_search(
        self,
        executor: QueryExecutor,
        query: str,
        search_filter: SearchFilters,
        group_ids: list[str] | None = None,
        limit: int = 10,
    ) -> list[EntityEdge]:
        ts_query = _build_ts_query(query)
        if not ts_query:
            return []

        client = executor.client
        conditions, params = _edge_filter_conditions(search_filter, group_ids)
        params.append(ts_query)
        ts_idx = len(params)

        where = _where(conditions)
        and_kw = 'AND' if conditions else 'WHERE'

        sql = f"""
            SELECT realm, id, from_id, to_id, relation_type, payload,
                   created_at, to_jsonb(t)->>'embedding' AS embedding_text,
                   ts_rank(search_vector, plainto_tsquery('simple', ${ts_idx})) AS score
            FROM "entity_edges" t
            {where}
              {and_kw} search_vector @@ plainto_tsquery('simple', ${ts_idx})
            ORDER BY score DESC
            LIMIT {limit}
        """
        rows = await client._fetch(sql, *params)
        return [_parse_edge(r) for r in rows]

    async def edge_similarity_search(
        self,
        executor: QueryExecutor,
        search_vector: list[float],
        source_node_uuid: str | None,
        target_node_uuid: str | None,
        search_filter: SearchFilters,
        group_ids: list[str] | None = None,
        limit: int = 10,
        min_score: float = 0.6,
    ) -> list[EntityEdge]:
        client = executor.client
        results: list[tuple[float, EntityEdge]] = []
        for realm in await _resolve_realms(client, 'entity_edges', group_ids):
            hits = await client.vector_search_edges(
                'entity_edges',
                realm,
                search_vector,
                top_k=limit,
                distance_metric='cosine',
            )
            results.extend(
                _matching_edge_hits(
                    hits,
                    source_node_uuid,
                    target_node_uuid,
                    search_filter,
                    min_score,
                )
            )

        results.sort(key=lambda result: result[0], reverse=True)
        return [edge for _, edge in results[:limit]]

    async def edge_bfs_search(
        self,
        executor: QueryExecutor,
        origin_uuids: list[str],
        max_depth: int,
        search_filter: SearchFilters,
        group_ids: list[str] | None = None,
        limit: int = 10,
    ) -> list[EntityEdge]:
        if not origin_uuids:
            return []

        client = executor.client
        results: list[EntityEdge] = []
        visited_edge_ids: set[int] = set()

        for origin_uuid in origin_uuids:
            origin = await _resolve_origin(client, origin_uuid, group_ids)
            if origin is None:
                continue
            realm, vertex_id = origin
            traversal = await _traverse_from_node(client, realm, vertex_id, max_depth)
            results.extend(
                await _edges_from_traversal(
                    client,
                    realm,
                    traversal,
                    search_filter,
                    visited_edge_ids,
                    limit - len(results),
                )
            )
            if len(results) >= limit:
                break

        return results[:limit]

    # --- Episode search ---

    async def episode_fulltext_search(
        self,
        executor: QueryExecutor,
        query: str,
        _search_filter: SearchFilters,
        group_ids: list[str] | None = None,
        limit: int = 10,
    ) -> list[EpisodicNode]:
        ts_query = _build_ts_query(query)
        if not ts_query:
            return []

        client = executor.client
        conditions: list[str] = []
        params: list[Any] = []

        if group_ids is not None:
            params.append(group_ids)
            conditions.append(f'realm = ANY(${len(params)})')

        params.append(ts_query)
        ts_idx = len(params)

        where = _where(conditions)
        and_kw = 'AND' if conditions else 'WHERE'

        sql = f"""
            SELECT realm, id, payload, created_at,
                   ts_rank(search_vector, plainto_tsquery('simple', ${ts_idx})) AS score
            FROM "episodic_nodes" t
            {where}
              {and_kw} search_vector @@ plainto_tsquery('simple', ${ts_idx})
            ORDER BY score DESC
            LIMIT {limit}
        """
        rows = await client._fetch(sql, *params)
        return [_parse_episode(r) for r in rows]

    # --- Community search ---

    async def community_fulltext_search(
        self,
        executor: QueryExecutor,
        query: str,
        group_ids: list[str] | None = None,
        limit: int = 10,
    ) -> list[CommunityNode]:
        ts_query = _build_ts_query(query)
        if not ts_query:
            return []

        client = executor.client
        conditions: list[str] = []
        params: list[Any] = []

        if group_ids is not None:
            params.append(group_ids)
            conditions.append(f'realm = ANY(${len(params)})')

        params.append(ts_query)
        ts_idx = len(params)

        where = _where(conditions)
        and_kw = 'AND' if conditions else 'WHERE'

        sql = f"""
            SELECT realm, id, payload, created_at,
                   to_jsonb(t)->>'embedding' AS embedding_text,
                   ts_rank(search_vector, plainto_tsquery('simple', ${ts_idx})) AS score
            FROM "community_nodes" t
            {where}
              {and_kw} search_vector @@ plainto_tsquery('simple', ${ts_idx})
            ORDER BY score DESC
            LIMIT {limit}
        """
        rows = await client._fetch(sql, *params)
        return [_parse_community(r) for r in rows]

    async def community_similarity_search(
        self,
        executor: QueryExecutor,
        search_vector: list[float],
        group_ids: list[str] | None = None,
        limit: int = 10,
        min_score: float = 0.6,
    ) -> list[CommunityNode]:
        client = executor.client

        results = []
        realms = group_ids or []
        if not realms:
            realm_rows = await client._fetch('SELECT DISTINCT realm FROM "community_nodes"')
            realms = [r['realm'] for r in realm_rows]

        for realm in realms:
            hits = await client.vector_search(
                'community_nodes',
                realm,
                search_vector,
                top_k=limit,
                distance_metric='cosine',
            )
            for vertex, distance in hits:
                score = 1.0 - distance
                if score > min_score:
                    results.append((score, _vertex_to_community(vertex)))

        results.sort(key=lambda x: x[0], reverse=True)
        return [n for _, n in results[:limit]]

    # --- Rerankers ---

    async def node_distance_reranker(
        self,
        executor: QueryExecutor,
        node_uuids: list[str],
        center_node_uuid: str,
        min_score: float = 0,
    ) -> list[EntityNode]:
        client = executor.client
        filtered_uuids = [u for u in node_uuids if u != center_node_uuid]
        center = await _resolve_origin(client, center_node_uuid, None)
        if center is None:
            return []
        realm, center_vertex_id = center
        scores = await _node_distance_scores(
            client,
            filtered_uuids,
            realm,
            center_vertex_id,
        )

        filtered_uuids.sort(key=lambda u: scores.get(u, float('inf')))

        if center_node_uuid in node_uuids:
            scores[center_node_uuid] = 0.1
            filtered_uuids = [center_node_uuid] + filtered_uuids

        reranked_uuids = [
            u for u in filtered_uuids if (1 / scores.get(u, float('inf'))) >= min_score
        ]

        if not reranked_uuids:
            return []
        return await _load_entities_by_uuid(client, reranked_uuids)

    async def episode_mentions_reranker(
        self,
        executor: QueryExecutor,
        node_uuids: list[str],
        min_score: float = 0,
    ) -> list[EntityNode]:
        if not node_uuids:
            return []

        client = executor.client
        scores: dict[str, float] = {}

        for uuid in node_uuids:
            vid_rows = await client._fetch(
                'SELECT realm, id FROM "entity_nodes" WHERE payload @> $1::jsonb',
                json.dumps({'uuid': uuid}),
            )
            if not vid_rows:
                scores[uuid] = float('inf')
                continue

            realm = vid_rows[0]['realm']
            vid = vid_rows[0]['id']
            count_rows = await client._fetch(
                'SELECT count(*) AS cnt FROM "episodic_edges" WHERE realm = $1 AND to_id = $2',
                realm,
                vid,
            )
            scores[uuid] = float(count_rows[0]['cnt']) if count_rows else float('inf')

        sorted_uuids = list(node_uuids)
        sorted_uuids.sort(key=lambda u: scores.get(u, float('inf')))

        reranked_uuids = [u for u in sorted_uuids if scores.get(u, 0) >= min_score]

        if not reranked_uuids:
            return []
        return await _load_entities_by_uuid(client, reranked_uuids)

    # --- Filter builders ---

    def build_node_search_filters(self, search_filters: SearchFilters) -> Any:
        conditions, params = _node_filter_conditions(search_filters, None)
        return {'filter_queries': conditions, 'filter_params': params}

    def build_edge_search_filters(self, search_filters: SearchFilters) -> Any:
        conditions, params = _edge_filter_conditions(search_filters, None)
        return {'filter_queries': conditions, 'filter_params': params}

    def build_fulltext_query(
        self,
        query: str,
        _group_ids: list[str] | None = None,
        max_query_length: int = 8000,
    ) -> str:
        return _build_ts_query(query, max_query_length)


# --- helpers ---


def _build_ts_query(query: str, max_length: int = 128) -> str:
    words = query.strip().split()[:max_length]
    terms = [w for w in words if w]
    if not terms:
        return ''
    return ' '.join(terms)


def _where(conditions: list[str]) -> str:
    if not conditions:
        return ''
    return 'WHERE ' + ' AND '.join(conditions)


async def _resolve_realms(client: Any, table: str, group_ids: list[str] | None) -> list[str]:
    if group_ids:
        return group_ids
    rows = await client._fetch(f'SELECT DISTINCT realm FROM "{table}"')
    return [row['realm'] for row in rows]


def _matching_node_hits(
    hits: list[tuple[Any, float]],
    search_filter: SearchFilters,
    min_score: float,
) -> list[tuple[float, EntityNode]]:
    results: list[tuple[float, EntityNode]] = []
    for vertex, distance in hits:
        score = 1.0 - distance
        if score <= min_score:
            continue
        node = _vertex_to_entity(vertex)
        if _matches_node_filter(node, search_filter):
            results.append((score, node))
    return results


def _matching_edge_hits(
    hits: list[tuple[Any, float]],
    source_node_uuid: str | None,
    target_node_uuid: str | None,
    search_filter: SearchFilters,
    min_score: float,
) -> list[tuple[float, EntityEdge]]:
    results: list[tuple[float, EntityEdge]] = []
    for edge_object, distance in hits:
        score = 1.0 - distance
        payload = edge_object.payload
        if score <= min_score:
            continue
        if source_node_uuid and payload.get('source_node_uuid') != source_node_uuid:
            continue
        if target_node_uuid and payload.get('target_node_uuid') != target_node_uuid:
            continue
        edge = _edge_from_pg_edge(edge_object)
        if _matches_edge_filter(edge, search_filter):
            results.append((score, edge))
    return results


async def _resolve_origin(
    client: Any,
    origin_uuid: str,
    group_ids: list[str] | None,
) -> tuple[str, str] | None:
    rows = await client._fetch(
        'SELECT realm, id FROM "entity_nodes" WHERE payload @> $1::jsonb',
        json.dumps({'uuid': origin_uuid}),
    )
    if not rows:
        return None
    realm = rows[0]['realm']
    if group_ids and realm not in group_ids:
        return None
    return realm, str(rows[0]['id'])


async def _traverse_from_node(
    client: Any,
    realm: str,
    vertex_id: str,
    max_depth: int,
) -> list[dict[str, Any]]:
    return await client.traverse(
        realm=realm,
        start_table='entity_nodes',
        start_id=vertex_id,
        edge_tables=['entity_edges'],
        max_depth=max_depth,
        direction='both',
    )


async def _node_from_traversal_step(
    client: Any,
    realm: str,
    step: dict[str, Any],
) -> EntityNode | None:
    if step['depth'] == 0:
        return None
    rows = await client._fetch(
        'SELECT realm, id, payload, created_at, '
        "to_jsonb(t)->>'embedding' AS embedding_text "
        'FROM "entity_nodes" t WHERE realm = $1 AND id = $2',
        realm,
        int(step['id']),
    )
    return _parse_entity(rows[0]) if rows else None


async def _nodes_from_traversal(
    client: Any,
    realm: str,
    traversal: list[dict[str, Any]],
    search_filter: SearchFilters,
    seen: set[str],
    limit: int,
) -> list[EntityNode]:
    results: list[EntityNode] = []
    for step in traversal:
        node = await _node_from_traversal_step(client, realm, step)
        if node is None or node.uuid in seen or not _matches_node_filter(node, search_filter):
            continue
        seen.add(node.uuid)
        results.append(node)
        if len(results) >= limit:
            break
    return results


async def _edges_from_traversal(
    client: Any,
    realm: str,
    traversal: list[dict[str, Any]],
    search_filter: SearchFilters,
    visited_edge_ids: set[int],
    limit: int,
) -> list[EntityEdge]:
    results: list[EntityEdge] = []
    for step in traversal:
        for edge_id in step.get('edge_ids') or []:
            if edge_id in visited_edge_ids:
                continue
            visited_edge_ids.add(edge_id)
            edge_object = await client.get_edge('entity_edges', realm, edge_id)
            if edge_object is None:
                continue
            edge = _edge_from_pg_edge(edge_object)
            if not _matches_edge_filter(edge, search_filter):
                continue
            results.append(edge)
            if len(results) >= limit:
                return results
    return results


async def _node_distance_scores(
    client: Any,
    node_uuids: list[str],
    realm: str,
    center_vertex_id: str,
) -> dict[str, float]:
    scores: dict[str, float] = {}
    for node_uuid in node_uuids:
        rows = await client._fetch(
            'SELECT id FROM "entity_nodes" WHERE realm = $1 AND payload @> $2::jsonb',
            realm,
            json.dumps({'uuid': node_uuid}),
        )
        if not rows:
            scores[node_uuid] = float('inf')
            continue
        edge_rows = await client._fetch(
            """
            SELECT 1 FROM "entity_edges"
            WHERE realm = $1
              AND ((from_id = $2 AND to_id = $3)
                OR (from_id = $3 AND to_id = $2))
            LIMIT 1
            """,
            realm,
            center_vertex_id,
            rows[0]['id'],
        )
        scores[node_uuid] = 1.0 if edge_rows else float('inf')
    return scores


async def _load_entities_by_uuid(client: Any, node_uuids: list[str]) -> list[EntityNode]:
    nodes: list[EntityNode] = []
    for node_uuid in node_uuids:
        rows = await client._fetch(
            'SELECT realm, id, payload, created_at, '
            "to_jsonb(t)->>'embedding' AS embedding_text "
            'FROM "entity_nodes" t WHERE payload @> $1::jsonb',
            json.dumps({'uuid': node_uuid}),
        )
        if rows:
            nodes.append(_parse_entity(rows[0]))
    return nodes


def _node_filter_conditions(
    search_filter: SearchFilters,
    group_ids: list[str] | None,
) -> tuple[list[str], list[Any]]:
    conditions: list[str] = []
    params: list[Any] = []

    if search_filter.node_labels is not None:
        params.append(search_filter.node_labels)
        conditions.append(f"payload->'labels' ?| ${len(params)}")

    if group_ids is not None:
        params.append(group_ids)
        conditions.append(f'realm = ANY(${len(params)})')

    return conditions, params


def _edge_filter_conditions(
    search_filter: SearchFilters,
    group_ids: list[str] | None,
) -> tuple[list[str], list[Any]]:
    conditions: list[str] = []
    params: list[Any] = []

    if search_filter.edge_types is not None:
        params.append(search_filter.edge_types)
        conditions.append(f"payload->>'name' = ANY(${len(params)})")

    if search_filter.edge_uuids is not None:
        params.append(search_filter.edge_uuids)
        conditions.append(f"payload->>'uuid' = ANY(${len(params)})")

    if group_ids is not None:
        params.append(group_ids)
        conditions.append(f'realm = ANY(${len(params)})')

    _add_date_filters(conditions, params, search_filter)

    return conditions, params


def _add_date_filters(
    conditions: list[str],
    params: list[Any],
    filters: SearchFilters,
) -> None:
    for field_name in ('valid_at', 'invalid_at', 'created_at', 'expired_at'):
        date_lists = getattr(filters, field_name, None)
        if date_lists is None:
            continue
        or_parts = [_date_filter_group(field_name, group, params) for group in date_lists]
        conditions.append('(' + ' OR '.join(or_parts) + ')')


def _date_filter_group(field_name: str, date_filters: list[Any], params: list[Any]) -> str:
    conditions = [_date_filter_condition(field_name, date_filter, params) for date_filter in date_filters]
    return '(' + ' AND '.join(conditions) + ')'


def _date_filter_condition(field_name: str, date_filter: Any, params: list[Any]) -> str:
    operator = date_filter.comparison_operator.value
    if operator in ('IS NULL', 'IS NOT NULL'):
        return f"((payload->>'{field_name}') {operator})"
    value = (
        date_filter.date.isoformat()
        if hasattr(date_filter.date, 'isoformat')
        else str(date_filter.date)
    )
    params.append(value)
    return (
        f"((payload->>'{field_name}')::timestamptz "
        f"{operator} ${len(params)}::timestamptz)"
    )


def _vertex_to_entity(v) -> EntityNode:
    p = v.payload
    labels = list(p.get('labels', []))
    group_id = v.realm
    dynamic_label = 'Entity_' + group_id.replace('-', '')
    if dynamic_label in labels:
        labels.remove(dynamic_label)
    return EntityNode(
        uuid=p['uuid'],
        name=p.get('name', ''),
        name_embedding=v.embedding,
        group_id=group_id,
        labels=labels,
        created_at=parse_db_date(p.get('created_at')) or v.created_at,
        summary=p.get('summary', ''),
        attributes=dict(p.get('attributes', {})),
    )


def _vertex_to_community(v) -> CommunityNode:
    p = v.payload
    return CommunityNode(
        uuid=p['uuid'],
        name=p.get('name', ''),
        group_id=v.realm,
        name_embedding=v.embedding,
        created_at=parse_db_date(p.get('created_at')) or v.created_at,
        summary=p.get('summary', ''),
    )


def _parse_entity(row: dict) -> EntityNode:
    p = row['payload'] if isinstance(row['payload'], dict) else json.loads(row['payload'])
    labels = list(p.get('labels', []))
    group_id = row['realm']
    dynamic_label = 'Entity_' + group_id.replace('-', '')
    if dynamic_label in labels:
        labels.remove(dynamic_label)

    emb = None
    if row.get('embedding_text'):
        emb = [float(x) for x in row['embedding_text'].strip('[]').split(',') if x.strip()]

    return EntityNode(
        uuid=p['uuid'],
        name=p.get('name', ''),
        name_embedding=emb,
        group_id=group_id,
        labels=labels,
        created_at=parse_db_date(p.get('created_at')) or row.get('created_at'),
        summary=p.get('summary', ''),
        attributes=dict(p.get('attributes', {})),
    )


def _parse_edge(row: dict) -> EntityEdge:
    p = row['payload'] if isinstance(row['payload'], dict) else json.loads(row['payload'])

    emb = None
    if row.get('embedding_text'):
        emb = [float(x) for x in row['embedding_text'].strip('[]').split(',') if x.strip()]

    return EntityEdge(
        uuid=p['uuid'],
        source_node_uuid=p['source_node_uuid'],
        target_node_uuid=p['target_node_uuid'],
        fact=p.get('fact', ''),
        fact_embedding=emb,
        name=p.get('name', ''),
        group_id=row['realm'],
        episodes=list(p.get('episodes', [])),
        created_at=parse_db_date(p.get('created_at')) or row.get('created_at'),
        expired_at=parse_db_date(p.get('expired_at')),
        valid_at=parse_db_date(p.get('valid_at')),
        invalid_at=parse_db_date(p.get('invalid_at')),
        reference_time=parse_db_date(p.get('reference_time')),
        attributes=dict(p.get('attributes', {})),
    )


def _edge_from_pg_edge(edge_obj) -> EntityEdge:
    p = edge_obj.payload
    return EntityEdge(
        uuid=p['uuid'],
        source_node_uuid=p['source_node_uuid'],
        target_node_uuid=p['target_node_uuid'],
        fact=p.get('fact', ''),
        fact_embedding=edge_obj.embedding,
        name=p.get('name', ''),
        group_id=edge_obj.realm,
        episodes=list(p.get('episodes', [])),
        created_at=parse_db_date(p.get('created_at')) or edge_obj.created_at,
        expired_at=parse_db_date(p.get('expired_at')),
        valid_at=parse_db_date(p.get('valid_at')),
        invalid_at=parse_db_date(p.get('invalid_at')),
        reference_time=parse_db_date(p.get('reference_time')),
        attributes=dict(p.get('attributes', {})),
    )


def _parse_episode(row: dict) -> EpisodicNode:
    p = row['payload'] if isinstance(row['payload'], dict) else json.loads(row['payload'])
    created_at = parse_db_date(p.get('created_at')) or row.get('created_at')
    valid_at = parse_db_date(p.get('valid_at'))

    if created_at is None:
        raise ValueError(f'created_at cannot be None for episode {p.get("uuid", "unknown")}')
    if valid_at is None:
        raise ValueError(f'valid_at cannot be None for episode {p.get("uuid", "unknown")}')

    return EpisodicNode(
        content=p.get('content', ''),
        created_at=created_at,
        valid_at=valid_at,
        uuid=p['uuid'],
        group_id=row['realm'],
        source=EpisodeType.from_str(p.get('source', 'text')),
        name=p.get('name', ''),
        source_description=p.get('source_description', ''),
        entity_edges=list(p.get('entity_edges', [])),
    )


def _parse_community(row: dict) -> CommunityNode:
    p = row['payload'] if isinstance(row['payload'], dict) else json.loads(row['payload'])
    emb = None
    if row.get('embedding_text'):
        emb = [float(x) for x in row['embedding_text'].strip('[]').split(',') if x.strip()]

    return CommunityNode(
        uuid=p['uuid'],
        name=p.get('name', ''),
        group_id=row['realm'],
        name_embedding=emb,
        created_at=parse_db_date(p.get('created_at')) or row.get('created_at'),
        summary=p.get('summary', ''),
    )


def _matches_node_filter(node: EntityNode, sf: SearchFilters) -> bool:
    return not (sf.node_labels is not None and not set(sf.node_labels) & set(node.labels))


def _matches_edge_filter(edge: EntityEdge, sf: SearchFilters) -> bool:
    if sf.edge_types is not None and edge.name not in sf.edge_types:
        return False
    return not (sf.edge_uuids is not None and edge.uuid not in sf.edge_uuids)
