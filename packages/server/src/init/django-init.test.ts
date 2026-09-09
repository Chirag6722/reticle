/**
 * A Django project gets Django's answer, not a script tag it has nowhere to paste.
 *
 * `init` printed the generic static-page snippet on a Django repo and exited 1, so the reporter
 * hand-wrote DEBUG-only middleware and `.reticle.json` themselves before they could drive anything.
 * Their words: *"A Python/Django init path that injects the connect snippet into DEBUG-only HTML."*
 *
 * Django renders templates server-side: there is no JS build to import the SDK from, and no single
 * template to paste into — an app has many and may not have a base one. Middleware has exactly one
 * home, runs for every page, and is what that reporter independently arrived at.
 */
import { describe, expect, it } from 'vitest';
import { detectDjangoProject, djangoSetupMessage } from './non-js-project.js';
import { djangoMiddlewareSnippet } from './snippets.js';

const has =
  (...files: string[]) =>
  (file: string): boolean =>
    files.includes(file);

describe('recognising a Django project', () => {
  it('accepts manage.py beside a settings.py', () => {
    expect(detectDjangoProject(has('manage.py', 'settings.py'))).toBe(true);
  });

  it('accepts the ordinary layout, where settings.py is in the project package', () => {
    expect(detectDjangoProject(has('manage.py', 'mysite/settings.py'), ['mysite'])).toBe(true);
  });

  it('refuses a repo with no manage.py at all', () => {
    expect(detectDjangoProject(has('requirements.txt'))).toBe(false);
  });

  it('refuses a bare manage.py with no settings anywhere — it claims only what it knows', () => {
    expect(detectDjangoProject(has('manage.py'), ['docs'])).toBe(false);
  });
});

describe('the middleware it generates', () => {
  const snippet = djangoMiddlewareSnippet('{ port: 4400 }');

  it('is guarded on DEBUG, so it can never reach production', () => {
    expect(snippet).toContain('settings.DEBUG');
    expect(snippet).toContain('if not settings.DEBUG');
  });

  it('injects only into HTML, so a JSON response is not corrupted', () => {
    expect(snippet).toContain('text/html');
  });

  it('leaves a streaming response alone, which has no .content to rewrite', () => {
    expect(snippet).toContain('streaming');
  });

  it('carries the connect arguments it was given', () => {
    expect(snippet).toContain('reticle.connect({ port: 4400 })');
  });

  it('injects before </body>, so the SDK sees a parsed document', () => {
    expect(snippet).toContain('</body>');
  });

  it('corrects Content-Length, or the browser truncates the page it just grew', () => {
    expect(snippet).toContain('Content-Length');
  });

  it('says where to register it — a middleware nobody installs does nothing', () => {
    expect(snippet).toContain('MIDDLEWARE');
  });
});

describe('the message that introduces it', () => {
  it('names Django and says why a script tag was the wrong shape', () => {
    const message = djangoSetupMessage();
    expect(message).toContain('Django');
    expect(message).toContain('DEBUG');
  });

  it('still points a project with a JS front end at the better path', () => {
    expect(djangoSetupMessage()).toContain('--app');
  });
});
