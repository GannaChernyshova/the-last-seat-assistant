INSERT INTO workshops (
  id, title, description, starts_at, ends_at, tags, capacity, remaining_capacity
) VALUES
  (
    'ws-testing-agentic-workflows',
    'Testing Agentic Workflows Locally',
    'Test AI applications with mocked models, real tools, and deterministic network faults.',
    '2026-09-24T14:00:00Z',
    '2026-09-24T15:30:00Z',
    ARRAY['testing', 'AI applications', 'agents', 'local development'],
    12,
    1
  ),
  (
    'ws-mcp-from-zero',
    'MCP from Zero to Production',
    'Build and deploy a production-ready Model Context Protocol server.',
    '2026-09-24T10:00:00Z',
    '2026-09-24T11:30:00Z',
    ARRAY['MCP', 'tools', 'TypeScript'],
    30,
    18
  ),
  (
    'ws-evaluating-rag',
    'Evaluating RAG Beyond Vibes',
    'A practical lab for retrieval metrics, golden sets, and regression testing.',
    '2026-09-24T13:00:00Z',
    '2026-09-24T14:00:00Z',
    ARRAY['testing', 'RAG', 'evaluation'],
    20,
    6
  ),
  (
    'ws-agent-observability',
    'Agent Observability Under Pressure',
    'Trace multi-step AI systems and debug their production behavior.',
    '2026-09-24T16:00:00Z',
    '2026-09-24T17:00:00Z',
    ARRAY['AI applications', 'observability', 'agents'],
    15,
    0
  ),
  (
    'ws-postgres-concurrency',
    'PostgreSQL Concurrency Patterns',
    'Transactions, locks, idempotency, and safe inventory updates.',
    '2026-09-24T15:00:00Z',
    '2026-09-24T16:00:00Z',
    ARRAY['PostgreSQL', 'databases', 'concurrency'],
    24,
    9
  )
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  starts_at = EXCLUDED.starts_at,
  ends_at = EXCLUDED.ends_at,
  tags = EXCLUDED.tags,
  capacity = EXCLUDED.capacity,
  remaining_capacity = EXCLUDED.remaining_capacity;
