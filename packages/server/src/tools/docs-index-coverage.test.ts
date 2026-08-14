import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const DOCS = join(REPO, 'docs');

/**
 * `docs/` serves two audiences — users and contributors — and for a long time nothing recorded which
 * was which. Twenty-five files sat in one flat directory, six of them invisible to the docs site, and
 * the only way to find out where a page belonged was to open it.
 *
 * `docs/README.md` is the index that fixes that, and `docs/docs.json` is what the published site
 * actually reads. An index is worth exactly as much as its accuracy, and one maintained by discipline
 * is wrong within two months — so the rule is a red build rather than a convention, the same way
 * `integration-coverage.test.ts` holds `apps/`.
 *
 * Every direction below is a silent failure if it goes unchecked:
 *   - a page nobody indexed is a page no contributor finds;
 *   - a page missing from `docs.json` is one no user can reach;
 *   - a page `docs.json` lists but that does not exist is a 404 on the published site;
 *   - a page without frontmatter renders with its slug as the title and no search description.
 */

const INDEX = 'README.md';

const docsIndex = () => readFileSync(join(DOCS, INDEX), 'utf8');

const markdownPages = () =>
  readdirSync(DOCS)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => f !== INDEX);

/** Slugs `docs.json` publishes, flattened out of the tab -> group -> pages nesting. */
const publishedSlugs = (): string[] => {
  const config: unknown = JSON.parse(readFileSync(join(DOCS, 'docs.json'), 'utf8'));
  const slugs: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (null === node || 'object' !== typeof node) return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.pages)) {
      for (const page of record.pages) {
        if ('string' === typeof page) slugs.push(page);
        else walk(page);
      }
    }
    Object.values(record).forEach(walk);
  };
  walk(config);
  return slugs;
};

describe('docs/README.md indexes every doc', () => {
  it('every markdown page under docs/ is linked from the index', () => {
    const index = docsIndex();
    const unlisted = markdownPages().filter((page) => !index.includes(`(${page})`));

    expect(
      unlisted,
      `These docs exist but are not in docs/README.md, so nobody will find them: ${unlisted.join(', ')}. ` +
        `Add each to the user table or the contributor table — the point of the index is that the ` +
        `two audiences are told apart.`,
    ).toEqual([]);
  });
});

describe('docs/docs.json publishes every doc', () => {
  it('every page docs.json publishes actually exists', () => {
    const missing = publishedSlugs().filter((page) => !existsSync(join(DOCS, `${page}.md`)));

    expect(
      missing,
      `docs.json publishes pages with no file behind them — each is a 404 on the docs site: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every markdown page under docs/ is published by docs.json', () => {
    const published = new Set(publishedSlugs());
    const orphans = markdownPages()
      .map((file) => file.replace(/\.md$/, ''))
      .filter((slug) => !published.has(slug));

    expect(
      orphans,
      `These docs are not in any docs.json tab, so they are unreachable from the site navigation: ${orphans.join(', ')}. ` +
        `Add each to the tab it belongs in — Guides, Reference, or Contributing.`,
    ).toEqual([]);
  });

  it('every published page carries frontmatter and no duplicate H1', () => {
    const broken = publishedSlugs()
      .filter((slug) => existsSync(join(DOCS, `${slug}.md`)))
      .map((slug) => {
        // Windows checkouts carry CRLF, which makes every `^---$` and `startsWith('---\n')`
        // below miss and reports all 24 pages as unfrontmattered. Normalise before parsing.
        const source = readFileSync(join(DOCS, `${slug}.md`), 'utf8').replace(/\r\n/g, '\n');
        const [, frontmatter = '', body = ''] = source.split(/^---$/m);
        if (!source.startsWith('---\n')) return `${slug}: no frontmatter block`;
        if (!/^title:\s*\S/m.test(frontmatter)) return `${slug}: frontmatter has no title`;
        if (!/^description:\s*\S/m.test(frontmatter))
          return `${slug}: frontmatter has no description`;
        // A `# ` inside a fenced block is a shell comment, not a heading.
        const prose = body.replace(/^```[\s\S]*?^```/gm, '');
        if (/^# /m.test(prose)) return `${slug}: body still has an H1, which renders twice`;
        return null;
      })
      .filter((problem): problem is string => null !== problem);

    expect(
      broken,
      `Mintlify renders the frontmatter title as the page heading and the description as the search ` +
        `snippet, so a page without them ships with its slug as its name: ${broken.join('; ')}`,
    ).toEqual([]);
  });
});
