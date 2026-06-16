import YAML from 'yaml';
import { rewriteComposePort, sanitizeProject } from '../src/runtime.js';

describe('rewriteComposePort', () => {
  const compose = `services:
  db:
    image: postgres:15
    restart: always
    environment:
      POSTGRES_USER: test_user
      POSTGRES_DB: test_db
    ports:
      - "5432:5432"
    volumes:
      - type: tmpfs
        target: /var/lib/postgresql/data
`;

  it('remaps only the host port of the named service, preserving everything else', () => {
    const out = rewriteComposePort(compose, 'db', 5441, 5432);
    const parsed = YAML.parse(out);
    expect(parsed.services.db.ports).toEqual(['5441:5432']);
    expect(parsed.services.db.image).toBe('postgres:15');
    expect(parsed.services.db.environment.POSTGRES_DB).toBe('test_db');
    expect(parsed.services.db.volumes).toHaveLength(1);
  });

  it('replaces (does not append to) the existing ports list', () => {
    const out = rewriteComposePort(compose, 'db', 5500, 5432);
    expect(YAML.parse(out).services.db.ports).toEqual(['5500:5432']);
  });

  it('leaves the document unchanged when the service is absent', () => {
    const out = rewriteComposePort(compose, 'redis', 6400, 6379);
    expect(YAML.parse(out).services.db.ports).toEqual(['5432:5432']);
  });
});

describe('sanitizeProject', () => {
  it('lowercases and replaces characters illegal in compose project names', () => {
    expect(sanitizeProject('pangloss-20260616-ABcd-claude:sonnet')).toBe('pangloss-20260616-abcd-claude-sonnet');
  });

  it('strips leading non-alphanumeric characters', () => {
    expect(sanitizeProject('--weird/name')).toBe('weird-name');
  });

  it('never returns empty', () => {
    expect(sanitizeProject('/////')).toBe('pangloss');
  });
});
