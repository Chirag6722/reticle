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

/** The site's own landing page. Mintlify serves it at `/` implicitly, so it is never in the nav. */
const HOME = 'index.mdx';

const docsIndex = () => readFileSync(join(DOCS, INDEX), 'utf8');

const markdownPages = () =>
  readdirSync(DOCS)
    .filter((f) => f.endsWith('.md') || f.endsWith('.mdx'))
    .filter((f) => f !== INDEX && f !== HOME);

/** The file behind a nav slug, which may be authored as either `.md` or `.mdx`. */
const pageFile = (slug: string): string | null => {
  for (const ext of ['.md', '.mdx']) {
    const path = join(DOCS, `${slug}${ext}`);
    if (existsSync(path)) return path;
  }
  return null;
};

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
    const missing = publishedSlugs().filter((page) => null === pageFile(page));

    expect(
      missing,
      `docs.json publishes pages with no file behind them — each is a 404 on the docs site: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every markdown page under docs/ is published by docs.json', () => {
    const published = new Set(publishedSlugs());
    const orphans = markdownPages()
      .map((file) => file.replace(/\.mdx?$/, ''))
      .filter((slug) => !published.has(slug));

    expect(
      orphans,
      `These docs are not in any docs.json tab, so they are unreachable from the site navigation: ${orphans.join(', ')}. ` +
        `Add each to the tab it belongs in — Guides, Reference, or Contributing.`,
    ).toEqual([]);
  });

  it('MDX components appear only in .mdx pages', () => {
    // Whether Mintlify renders JSX inside a plain `.md` file is not something this repo has
    // verified, and the failure mode if it does not is silent: the component renders as literal
    // text in the middle of a paragraph. Keep components where they are known to work.
    const COMPONENT =
      /<(Note|Tip|Warning|Info|Card|CardGroup|Columns|Accordion|AccordionGroup|Steps|Step|Frame|Tabs|Tab)\b/;
    const offenders = markdownPages()
      .filter((file) => file.endsWith('.md'))
      .filter((file) => COMPONENT.test(readFileSync(join(DOCS, file), 'utf8')));

    expect(
      offenders,
      `These .md pages use MDX components. Either rename the page to .mdx, or use plain markdown ` +
        `(a blockquote reads fine and cannot fail): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('no page draws a diagram out of box-drawing characters', () => {
    // Box-drawing and arrow glyphs. ASCII diagrams were ruled out for the published docs: they
    // wrap badly on narrow screens, are unreadable to a screen reader, and read as unfinished.
    // Mermaid renders natively on Mintlify and is the replacement.
    const ART = /[─-╿▲▼◄►]/;
    const offenders = markdownPages().filter((file) =>
      ART.test(readFileSync(join(DOCS, file), 'utf8')),
    );

    expect(
      offenders,
      `These pages contain box-drawing characters. Use a \`\`\`mermaid block instead — it renders as a ` +
        `real diagram: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('every internal link resolves to a page or an image that exists', () => {
    const slugs = new Set(markdownPages().map((file) => file.replace(/\.mdx?$/, '')));
    const broken: string[] = [];

    for (const file of markdownPages()) {
      const source = readFileSync(join(DOCS, file), 'utf8');
      const links = [
        ...source.matchAll(/href="(\/[^"#]*)"/g),
        ...source.matchAll(/\]\((\/[^)#]*)\)/g),
      ].map((match) => match[1] ?? '');

      for (const link of new Set(links)) {
        if (link.startsWith('/images/')) {
          if (!existsSync(join(DOCS, link))) broken.push(`${file} -> ${link} (missing image)`);
          continue;
        }
        const slug = link.replace(/^\/|\/$/g, '');
        if ('' !== slug && !slugs.has(slug)) broken.push(`${file} -> ${link} (no such page)`);
      }
    }

    expect(
      broken,
      `These links 404 on the published site. A dead link in docs is silent — nothing throws, the ` +
        `page renders, and the reader hits a wall: ${broken.join('; ')}`,
    ).toEqual([]);
  });

  it('every published page carries frontmatter and no duplicate H1', () => {
    const broken = publishedSlugs()
      .map((slug) => ({ slug, file: pageFile(slug) }))
      .filter((page): page is { slug: string; file: string } => null !== page.file)
      .map(({ slug, file }) => {
        // Windows checkouts carry CRLF, which makes every `^---$` and `startsWith('---\n')`
        // below miss and reports all 24 pages as unfrontmattered. Normalise before parsing.
        const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
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
