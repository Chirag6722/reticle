import { describe, expect, it } from 'vitest';
import { describePage, PageFinding, readPage } from './page-probe.js';

const URL = 'http://localhost:5173/';

describe('what the page adds to the daemon account', () => {
  it('separates a page with the SDK from one without', () => {
    expect(readPage({ served: true, sdkInPage: false })).toBe(PageFinding.SDK_MISSING);
    expect(readPage({ served: true, sdkInPage: true })).toBe(PageFinding.SDK_PRESENT);
  });

  it('reports nothing answering as its own finding', () => {
    expect(readPage({ served: false, sdkInPage: false })).toBe(PageFinding.NOT_SERVED);
  });

  // A refused certificate means the server DID answer. Calling that "not served" sends someone to
  // start a dev server that is already running.
  it('ranks a refused certificate above "not served", because the server answered', () => {
    expect(readPage({ served: false, sdkInPage: false, tlsRefused: true })).toBe(
      PageFinding.TLS_REFUSED,
    );
  });
});

describe('the sentence each finding contributes', () => {
  // The most common failure in the product, so it must be the first thing said.
  it('leads with the stale bundle when the SDK is absent', () => {
    expect(describePage(PageFinding.SDK_MISSING, URL)).toContain(
      'before the build config was edited',
    );
  });

  it('says the app may be fine when only the certificate stopped us', () => {
    expect(describePage(PageFinding.TLS_REFUSED, URL)).toContain('may be perfectly fine');
  });

  it('names the early-return causes when the SDK is present and silent', () => {
    expect(describePage(PageFinding.SDK_PRESENT, URL)).toContain('localhost guard');
  });

  it('gives a different sentence for every finding', () => {
    const all = Object.values(PageFinding).map((f) => describePage(f, URL));
    expect(new Set(all).size).toBe(all.length);
  });

  it('always names the url, so the sentence stands alone in a log', () => {
    for (const f of Object.values(PageFinding)) expect(describePage(f, URL)).toContain(URL);
  });
});
