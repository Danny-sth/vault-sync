import { describe, it, expect } from 'vitest';
import {
  hashPath,
  progressFilePath,
  buildEntry,
  serialize,
  parse,
  percent,
  PROGRESS_DIR,
  type ProgressEntry,
} from './PdfProgressStore';

describe('percent', () => {
  it('computes a rounded whole percent', () => {
    expect(percent(149, 339)).toBe(44);
    expect(percent(1, 339)).toBe(0);
    expect(percent(339, 339)).toBe(100);
  });

  it('is safe for zero/invalid totals', () => {
    expect(percent(5, 0)).toBe(0);
    expect(percent(5, -1)).toBe(0);
    expect(percent(5, NaN)).toBe(0);
  });

  it('clamps to 0..100', () => {
    expect(percent(400, 339)).toBe(100);
    expect(percent(-5, 339)).toBe(0);
  });
});

describe('hashPath', () => {
  it('is deterministic for the same input', () => {
    expect(hashPath('Books/War and Peace.pdf')).toBe(hashPath('Books/War and Peace.pdf'));
  });

  it('produces an 8-char hex string', () => {
    expect(hashPath('a')).toMatch(/^[0-9a-f]{8}$/);
    expect(hashPath('some/very/long/path with spaces and юникод.pdf')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('differs for different paths', () => {
    expect(hashPath('Books/a.pdf')).not.toBe(hashPath('Books/b.pdf'));
  });
});

describe('progressFilePath', () => {
  it('lives under the progress dir with a .json extension', () => {
    const p = progressFilePath('Books/x.pdf');
    expect(p.startsWith(`${PROGRESS_DIR}/`)).toBe(true);
    expect(p.endsWith('.json')).toBe(true);
  });

  it('is stable for the same book and unique per book', () => {
    expect(progressFilePath('Books/x.pdf')).toBe(progressFilePath('Books/x.pdf'));
    expect(progressFilePath('Books/x.pdf')).not.toBe(progressFilePath('Books/y.pdf'));
  });
});

describe('serialize / parse round-trip', () => {
  it('preserves a valid entry', () => {
    const entry = buildEntry('Books/x.pdf', 42, 339, 1700000000000);
    const back = parse(serialize(entry));
    expect(back).toEqual<ProgressEntry>(entry);
  });

  it('defaults total to 0 when absent or invalid', () => {
    expect(parse(JSON.stringify({ path: 'a.pdf', page: 5 }))?.total).toBe(0);
    expect(parse(JSON.stringify({ path: 'a.pdf', page: 5, total: -1 }))?.total).toBe(0);
    expect(parse(JSON.stringify({ path: 'a.pdf', page: 5, total: 1.5 }))?.total).toBe(0);
    expect(parse(JSON.stringify({ path: 'a.pdf', page: 5, total: 200 }))?.total).toBe(200);
  });
});

describe('parse rejects bad input', () => {
  it('returns null for invalid JSON', () => {
    expect(parse('{ not json')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parse('42')).toBeNull();
    expect(parse('null')).toBeNull();
    expect(parse('"str"')).toBeNull();
  });

  it('returns null when page is missing, zero, negative or non-integer', () => {
    expect(parse(JSON.stringify({ path: 'a.pdf' }))).toBeNull();
    expect(parse(JSON.stringify({ path: 'a.pdf', page: 0 }))).toBeNull();
    expect(parse(JSON.stringify({ path: 'a.pdf', page: -3 }))).toBeNull();
    expect(parse(JSON.stringify({ path: 'a.pdf', page: 1.5 }))).toBeNull();
  });

  it('returns null when path is missing or empty', () => {
    expect(parse(JSON.stringify({ page: 5 }))).toBeNull();
    expect(parse(JSON.stringify({ path: '', page: 5 }))).toBeNull();
  });

  it('defaults mtime to 0 when absent or non-numeric', () => {
    expect(parse(JSON.stringify({ path: 'a.pdf', page: 5 }))?.mtime).toBe(0);
    expect(parse(JSON.stringify({ path: 'a.pdf', page: 5, mtime: 'x' }))?.mtime).toBe(0);
  });
});
