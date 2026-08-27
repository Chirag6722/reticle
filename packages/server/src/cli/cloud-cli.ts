/**
 * Cloud subcommands for the `reticle` CLI — the user/agent door to the hosted service, folded into the ONE
 * tool (was the standalone `reticle-cloud` bootstrap script). These are THIN clients over the `/v1` API:
 * the moat is the server, not these verbs, and OSS reticle already ships the cloud-sync client — this just
 * surfaces it. Creds live under `~/.reticle`: `session.json` (human token from `reticle login`) and
 * `credentials.json` (per-project api keys from `reticle link`). The non-secret repo binding + sync policy
 * is `<repo>/.reticle/cloud.json`. Auth for a command = `RETICLE_CLOUD_KEY` env (agent) OR the login token.
 */
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { NodePlatform } from '../platform.js';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createNodeFileSystem } from '../project/fs-port.js';
import { CLOUD_LINK_FILE, credentialSlot, resolveProjectCloud } from '../cloud/cloud-config.js';
import { cloudFetch } from '../cloud/cloud-sync.js';
import { describeSync, runSyncCycle } from '../cloud/sync-cycle.js';
import { diskSink, diskSource, readCloudIssues, readCloudState } from '../cloud/sync-disk.js';

/**
 * Where `reticle login` dials when nothing says otherwise: the hosted service.
 *
 * This is the same origin as the dashboard — the API serves the built console — so there is one
 * host for a user to know and one for us to configure.
 *
 * It used to be `http://localhost:8890`, which is correct for exactly one audience: whoever is
 * developing the service itself. Every other user — the entire point of publishing the package —
 * typed `reticle login` and got a connection refused against a port on their own machine, which
 * reads as "the cloud is down", not "you are dialling the wrong host". Developing against a local
 * API is now what needs saying out loud, via RETICLE_CLOUD_URL, because that is the rarer case.
 */
const DEFAULT_URL = 'https://app.reticle.sh';
const RETICLE_DIR = '.reticle';
const SESSION_FILE = 'session.json';
/**
 * One session file per host, so more than one environment can be logged in at once.
 *
 * `session.json` stays what it always was — the ACTIVE login, and the thing a bare command with no
 * override resolves through. This directory is what makes staging and production hold at the same
 * time instead of clobbering each other, which is the whole reason a single file was not enough.
 */
const SESSIONS_DIR = 'sessions';
const CREDENTIALS_FILE = 'credentials.json';

const DEFAULT_PROJECT_ID = 'default';

const CLOUD_COMMANDS: ReadonlySet<string> = new Set([
  'login',
  'logout',
  'whoami',
  'link',
  'project',
  'config',
  'push',
  'sync',
  'runs',
  'regression',
  'share',
]);
export const isCloudCommand = (cmd: string | undefined): boolean =>
  cmd !== undefined && CLOUD_COMMANDS.has(cmd);

const home = (): string => join(homedir(), RETICLE_DIR);
/** `reticle sync --watch` — keep cycling instead of exiting. */
const WATCH_FLAG = '--watch';

/**
 * How often `--watch` cycles.
 *
 * A minute is chosen against what a cycle COSTS, not against how fresh anybody needs the dashboard:
 * an unchanged session sends one small GET and nothing else, so a minute is cheap enough that nobody
 * turns it off — and a sync people turn off is the only kind that actually loses data.
 */
const DEFAULT_SYNC_INTERVAL_MS = 60_000;

const err = (msg: string): void => {
  process.stderr.write(`reticle: ${msg}\n`);
};
/** A next-step nudge on stderr (humans read it; agents parse stdout JSON and ignore this). */
const hint = (msg: string): void => {
  process.stderr.write(`→ ${msg}\n`);
};
const emit = (obj: unknown): void => {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
};

/** Read + parse a JSON file, or null when missing/malformed (never throws). */
const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};

/** Parse `--flag value` pairs out of an argv tail. */
const flags = (argv: readonly string[]): Record<string, string> => {
  const f: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a !== undefined && a.startsWith('--') && i + 1 < argv.length) {
      const v = argv[i + 1];
      if (v !== undefined) f[a.slice(2)] = v;
      i += 1;
    }
  }
  return f;
};

const SessionSchema = z.object({ url: z.string(), token: z.string(), orgName: z.string() });
type Session = z.infer<typeof SessionSchema>;

/** Trailing slashes are not identity: `https://x/` and `https://x` are one host. */
const normalizeUrl = (url: string): string => url.replace(/\/+$/, '');

/**
 * A filesystem-safe name for one host. `https://app.reticle.sh` → `app.reticle.sh`,
 * `http://localhost:8890` → `localhost_8890`. The scheme is dropped deliberately: nobody runs the
 * same host over both http and https and means two different accounts by it.
 */
const hostSlug = (url: string): string =>
  normalizeUrl(url)
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[^a-zA-Z0-9.-]/g, '_');

const sessionPath = (url: string): string => join(home(), SESSIONS_DIR, `${hostSlug(url)}.json`);

/** The ACTIVE session — the last host logged in to. What a bare command resolves its URL through. */
const readSession = async (): Promise<Session | null> => {
  const parsed = SessionSchema.safeParse(await readJson(join(home(), SESSION_FILE)));
  return parsed.success ? parsed.data : null;
};

/**
 * The session for ONE host, or null.
 *
 * This is the whole safety property, and it holds by construction rather than by a guard somebody
 * has to remember: a token is looked up BY the host it will be sent to, so there is no arrangement
 * of environment variables that fetches one host's credential for a request to another.
 *
 * Falls back to `session.json` when it names this host, so a machine that logged in before per-host
 * sessions existed keeps working and is not silently signed out by an upgrade.
 */
const readSessionFor = async (url: string): Promise<Session | null> => {
  const perHost = SessionSchema.safeParse(await readJson(sessionPath(url)));
  if (perHost.success) return perHost.data;
  const active = await readSession();
  return null !== active && normalizeUrl(active.url) === normalizeUrl(url) ? active : null;
};

const baseUrl = (session: { url: string } | null, explicit?: string): string => {
  // `--url` wins over the environment: it is typed for THIS command, it is visible in shell history,
  // and it cannot leak into a sibling process the way an exported variable does.
  if (explicit !== undefined && explicit.length > 0) return normalizeUrl(explicit);
  const env = process.env['RETICLE_CLOUD_URL'];
  if (env !== undefined && env.length > 0) return env.replace(/\/+$/, '');
  if (null !== session && session.url.length > 0) return session.url;
  // No hint here any more. This used to warn that it was falling back to localhost, which was worth
  // saying because that default was wrong for everyone except us. The default is now the hosted
  // service, so the fallback IS the intended path — and a warning printed on the correct path is
  // how people learn to ignore stderr, which is where the real problems are written.
  return DEFAULT_URL;
};

/**
 * How a key is named out loud: enough to match it against the dashboard, never enough to use.
 *
 * The same shape the console shows (`displayPrefix`), so the two surfaces name one key identically
 * and somebody can tell at a glance which row this repo is using.
 */
const KEY_HINT_CHARS = 16;
const keyHint = (key: string): string =>
  key.length <= KEY_HINT_CHARS ? key : `${key.slice(0, KEY_HINT_CHARS)}…`;

/**
 * The api key this machine already holds for a project ON THIS CLOUD, if any.
 *
 * Two shapes, matching the resolver: `{ key, url }` is what `link` writes now and is only returned
 * when the URL matches, and a bare string is the legacy shape with no URL to check. Without the URL
 * check this would happily reuse a production key for a self-hosted link, because `link` names
 * every project "default" and the two collide in one slot.
 */
const storedCredential = async (projectId: string, url: string): Promise<string | undefined> => {
  const raw = await readJson(join(home(), CREDENTIALS_FILE));
  if ('object' !== typeof raw || null === raw) return undefined;
  const store = raw as Record<string, unknown>;
  const composite = store[credentialSlot(url, projectId)];
  if ('string' === typeof composite && composite.length > 0) return composite;
  const found = store[projectId];
  if ('string' === typeof found) return found.length > 0 ? found : undefined;
  if ('object' !== typeof found || null === found) return undefined;
  const record = found as Record<string, unknown>;
  const key = record['key'];
  const forUrl = record['url'];
  if ('string' !== typeof key || 0 === key.length) return undefined;
  if ('string' === typeof forUrl && normalizeUrl(forUrl) !== normalizeUrl(url)) return undefined;
  return key;
};

/**
 * What a key is good for, or undefined when the cloud will not accept it.
 *
 * Never throws: a revoked key, a rotated one and an unreachable cloud are all "cannot reuse this",
 * and the caller's answer to every one of them is the same — mint a fresh one.
 */
const validateKey = async (
  url: string,
  key: string,
): Promise<z.infer<typeof WhoamiSchema> | undefined> => {
  try {
    return WhoamiSchema.parse(await api('GET', `${url}/v1/cloud/whoami`, key));
  } catch {
    return undefined;
  }
};

/** Bearer for a command: an explicit api key (agent) wins, else the human login token. */
const bearer = (session: { token: string } | null): string | null => {
  const key = process.env['RETICLE_CLOUD_KEY'];
  if (key !== undefined && key.length > 0) return key;
  return session?.token ?? null;
};

/** One `/v1` call. Throws a friendly Error on a non-2xx so the command surfaces it and exits 1. */
const api = async (
  method: string,
  url: string,
  token: string | null,
  body?: unknown,
): Promise<unknown> => {
  const headers: Record<string, string> = {};
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method,
    headers,
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await cloudFetch(url, init);
  const text = await res.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`expected JSON from ${method} ${url} but got: ${text.slice(0, 120)}`);
    }
  }
  if (!res.ok) {
    const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(json);
    throw new Error(parsed.success ? parsed.data.error.message : `${res.status} ${res.statusText}`);
  }
  return json;
};

const LoginSchema = z.object({ token: z.string(), org: z.object({ name: z.string() }) });
const KeySchema = z.object({ projectId: z.string(), projectName: z.string(), key: z.string() });
const WhoamiSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  /**
   * Where this project's dashboard lives. Optional because an older cloud does not send it, and a
   * CLI that refused to link against one would break the thing it is supposed to connect.
   */
  dashboardUrl: z.string().optional(),
});
const CreatedProjectSchema = z.object({ projectId: z.string(), name: z.string() });
const ProjectsListSchema = z.object({
  projects: z.array(z.object({ projectId: z.string(), name: z.string() })),
});

/** Resolve a --project value that may be a slug id OR a display name into the canonical projectId. */
/**
 * The id for the project the caller named, creating it if it does not exist yet.
 *
 * It used to refuse — "create it with `reticle project create`" — which made naming a project a
 * two-command bookkeeping ritual for the COMMON case: a first repo, whose project has of course not
 * been created yet. That refusal is also the only reason the magic path existed: bare `link` binds
 * to a project called `Default` precisely so nobody has to meet this error.
 *
 * Creating is announced rather than silent. A tool that quietly invents a durable, billable object
 * is its own surprise, and the whole point of this change is that the automatic path SAYS what it
 * did.
 */
const resolveProjectId = async (url: string, token: string, wanted: string): Promise<string> => {
  const { projects } = ProjectsListSchema.parse(await api('GET', `${url}/v1/projects`, token));
  const lc = wanted.toLowerCase();
  const match = projects.find((p) => p.projectId === wanted || p.name.toLowerCase() === lc);
  if (match !== undefined) return match.projectId;
  const created = CreatedProjectSchema.parse(
    await api('POST', `${url}/v1/projects`, token, { name: wanted }),
  );
  hint(`created project "${wanted}" (${created.projectId}) — it did not exist yet`);
  return created.projectId;
};

/**
 * `reticle login --email <e> [--org <name>] [--code <123456>]` — sign in, cache the token under
 * ~/.reticle.
 *
 * TWO STEPS, because the cloud proves you own the inbox before it hands out a session: ask for a code,
 * then exchange it. (It used to take an email alone — which meant anyone who knew your address owned your
 * org.) `--org` is only consulted when the account is brand new; a returning user never needs it.
 *
 * Without `--code` we request one and stop, telling the user to re-run with it. The one exception is a
 * LOCAL cloud, whose dev mailer cannot actually deliver mail and so echoes the code back in its response
 * (`devCode`) — there we complete the login in a single command rather than asking a developer to read a
 * code out of a server log they may not even be tailing.
 */
const RequestCodeSchema = z.object({ devCode: z.string().optional() });

const DeviceStartSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  verificationUriComplete: z.string(),
  interval: z.number(),
  expiresAt: z.number(),
});
const DevicePollSchema = z.object({
  status: z.string(),
  token: z.string().optional(),
  org: z.object({ name: z.string() }).optional(),
});

/** Best-effort open the approval page in the default browser; the printed URL is the headless fallback. */
const openBrowser = (target: string): void => {
  const cmd =
    NodePlatform.MACOS === process.platform
      ? 'open'
      : NodePlatform.WINDOWS === process.platform
        ? 'cmd'
        : 'xdg-open';
  const args = NodePlatform.WINDOWS === process.platform ? ['/c', 'start', '', target] : [target];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* no opener available — the user opens the printed URL manually */
  }
};

/** Persist a session token under ~/.reticle and print the next step. Shared by both login paths. */
const writeSession = async (url: string, token: string, orgName: string): Promise<void> => {
  await mkdir(join(home(), SESSIONS_DIR), { recursive: true });
  const body = `${JSON.stringify({ url: normalizeUrl(url), token, orgName }, null, 2)}\n`;
  // Both, on purpose. The per-host file is what lets another environment stay logged in; the active
  // file is what a bare command with no override resolves through, and keeping it means nothing
  // about the single-environment workflow changes.
  await writeFile(sessionPath(url), body);
  await writeFile(join(home(), SESSION_FILE), body);
  emit({ loggedIn: orgName, session: join(home(), SESSION_FILE) });
  hint(
    'next: `reticle link` to bind this repo to your Default project (or `reticle project create <name>` first)',
  );
};

/**
 * Browser device flow — the DEFAULT `reticle login` (like `gh auth login`): fetch a device + user code,
 * open the browser to approve, then poll until the user confirms. No email to type, no code to copy back.
 */
const cmdLoginDevice = async (explicitUrl?: string): Promise<number> => {
  const url = baseUrl(null, explicitUrl);
  const started = DeviceStartSchema.parse(
    await api('POST', `${url}/v1/auth/device/start`, null, {}),
  );
  hint(
    `Opening ${started.verificationUri} — confirm this code in the browser: ${started.userCode}`,
  );
  openBrowser(started.verificationUriComplete);
  const intervalMs = Math.max(1, started.interval) * 1000;
  for (;;) {
    await sleep(intervalMs);
    const poll = DevicePollSchema.parse(
      await api('POST', `${url}/v1/auth/device/token`, null, { deviceCode: started.deviceCode }),
    );
    if ('approved' === poll.status && poll.token !== undefined && poll.org !== undefined) {
      await writeSession(url, poll.token, poll.org.name);
      return 0;
    }
    if ('pending' === poll.status) {
      if (Date.now() > started.expiresAt) {
        err('device login expired — run `reticle login` again');
        return 1;
      }
      continue;
    }
    err(
      'denied' === poll.status
        ? 'device login was denied in the browser'
        : 'device login expired — run `reticle login` again',
    );
    return 1;
  }
};

/**
 * `reticle login` — browser device flow by default; `--email <e>` (or a positional email) keeps the
 * headless two-step code path for CI/servers where opening a browser makes no sense.
 */
const cmdLogin = async (argv: readonly string[]): Promise<number> => {
  const f = flags(argv);
  const positional = argv[0] !== undefined && !argv[0].startsWith('--') ? argv[0] : undefined;
  const email = f['email'] ?? positional;
  if (email === undefined) return cmdLoginDevice(f['url']);
  const org = f['org'];
  const url = baseUrl(null, f['url']);

  let code = f['code'];
  if (code === undefined) {
    const requested = RequestCodeSchema.parse(
      await api('POST', `${url}/v1/auth/request-code`, null, {
        email,
        ...(org !== undefined ? { orgName: org } : {}),
      }),
    );
    // A real cloud mails the code and never echoes it; a local one cannot mail, so it hands it back.
    if (requested.devCode === undefined) {
      emit({ codeSent: true, to: email });
      hint(`check your inbox, then: \`reticle login --email ${email} --code <the 6-digit code>\``);
      return 0;
    }
    code = requested.devCode;
  }

  const parsed = LoginSchema.parse(
    await api('POST', `${url}/v1/auth/login`, null, { email, code }),
  );
  await writeSession(url, parsed.token, parsed.org.name);
  return 0;
};

/** `reticle logout` — forget the cached session token (per-project keys under credentials.json stay). */
/**
 * `reticle logout` — sign out of ONE host, not of everywhere.
 *
 * Which host is the same question every other verb asks: `--url`, else the environment, else the
 * active session. Signing out of staging must leave production alone — a logout that quietly
 * cleared every environment would be discovered at the worst possible moment, mid-incident, on the
 * one you did not mean.
 */
const cmdLogout = async (argv: readonly string[] = []): Promise<number> => {
  const active = await readSession();
  const url = baseUrl(active, flags(argv)['url']);
  await rm(sessionPath(url), { force: true }).catch(() => undefined);
  // The active pointer only moves if it was pointing at the host just signed out of.
  if (null !== active && normalizeUrl(active.url) === url)
    await writeFile(join(home(), SESSION_FILE), '').catch(() => undefined);
  emit({ loggedOut: true, url });
  return 0;
};

/**
 * `reticle whoami` — the one call an agent (or a confused human) makes to know its state: who am I logged
 * in as, and is THIS repo attached to a cloud project (and with what sync policy / verify mode)?
 */
const cmdWhoami = async (): Promise<number> => {
  const session = await readSession();
  const fs = createNodeFileSystem();
  const cloud = await resolveProjectCloud(
    fs,
    join(process.cwd(), RETICLE_DIR),
    homedir(),
    process.env,
  );
  /*
   * The sync half of "what is my state". Without it the honest answer to "why does the dashboard
   * look old?" was to go and read a JSON file — and the two failure modes a person actually hits
   * (nothing has synced yet, and the last attempt errored) looked identical from out here.
   */
  const reticleRoot = join(process.cwd(), RETICLE_DIR);
  const state = readCloudState(reticleRoot);
  const decisions = Object.keys(readCloudIssues(reticleRoot).triage).length;
  emit({
    loggedInAs: session?.orgName ?? null,
    sync: {
      lastPushAt: state.lastPushAt ?? null,
      lastPullAt: state.lastPullAt ?? null,
      /** Present only when the machine is behind BECAUSE something failed, which is the useful case. */
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
      /** Decisions collected from the dashboard and readable locally. */
      decisionsHeld: decisions,
      neverSynced: state.lastPullAt === undefined,
    },
    repo: {
      attached: cloud.config !== null,
      projectId: cloud.projectId,
      url: cloud.config?.url ?? null,
      sync: cloud.policy,
      verify: cloud.verify,
    },
  });
  if (null === cloud.config) hint('this repo is not attached — run `reticle link`');
  return 0;
};

/** `reticle project ls` / `reticle project create <name>` — key- or session-authed. */
const cmdProject = async (argv: readonly string[]): Promise<number> => {
  const active = await readSession();
  const url = baseUrl(active);
  const session = await readSessionFor(url);
  const token = bearer(session);
  if (null === token) {
    // Name BOTH hosts when there is a session for a different one. "Run reticle login" on its own is
    // baffling to somebody who just did — the useful fact is that they logged in somewhere else.
    err(
      null !== active && normalizeUrl(active.url) !== url
        ? `signed in to ${normalizeUrl(active.url)}, but this command targets ${url} — run \`reticle login --url ${url}\`, or set RETICLE_CLOUD_KEY`
        : `not signed in to ${url} — run \`reticle login --url ${url}\`, or set RETICLE_CLOUD_KEY`,
    );
    return 2;
  }
  const sub = argv[0];
  if ('ls' === sub) {
    emit(await api('GET', `${url}/v1/projects`, token));
    return 0;
  }
  if ('create' === sub) {
    const name = argv.slice(1).join(' ').trim();
    if (0 === name.length) {
      err('usage: reticle project create <name>');
      return 2;
    }
    const created = CreatedProjectSchema.parse(
      await api('POST', `${url}/v1/projects`, token, { name }),
    );
    emit(created);
    hint(`next: \`reticle link --project ${created.projectId}\` to bind this repo`);
    return 0;
  }
  if ('rename' === sub) {
    const id = argv[1];
    const name = argv.slice(2).join(' ').trim();
    if (id === undefined || 0 === name.length) {
      err('usage: reticle project rename <projectId> <new name>');
      return 2;
    }
    emit(await api('PATCH', `${url}/v1/projects/${encodeURIComponent(id)}`, token, { name }));
    return 0;
  }
  if ('rm' === sub || 'delete' === sub) {
    const id = argv[1];
    if (id === undefined) {
      err('usage: reticle project rm <projectId>');
      return 2;
    }
    emit(await api('DELETE', `${url}/v1/projects/${encodeURIComponent(id)}`, token));
    return 0;
  }
  err('usage: reticle project <ls|create <name>|rename <id> <name>|rm <id>>');
  return 2;
};

/**
 * `reticle link [--project <id>]` — bind THIS repo to a cloud project. With a login token it MINTS a
 * project-scoped key (no pasting); with a pre-set RETICLE_CLOUD_KEY it resolves the key's project via
 * whoami. Writes the non-secret binding to <repo>/.reticle/cloud.json and the secret key to
 * ~/.reticle/credentials.json (keyed by projectId).
 */
const cmdLink = async (argv: readonly string[]): Promise<number> => {
  const f = flags(argv);
  const url = baseUrl(await readSession(), f['url']);
  // Same rule as every other authed verb: the token is looked up by the host it will be sent to.
  const session = await readSessionFor(url);
  const envKey = process.env['RETICLE_CLOUD_KEY'];

  let projectId: string;
  let projectName: string;
  let key: string;
  /*
   * Where this project's dashboard lives. Asked of the cloud rather than derived from `url`: the API
   * origin and the console origin are different hosts in every deployment that is not a laptop, so a
   * link the CLI guessed would be wrong exactly where it matters.
   */
  let dashboardUrl: string | undefined;
  /** Whether the key was already on this machine — so the report can say so instead of "minted". */
  let reusedKey = false;
  // Tracked separately from the value: an OLDER cloud answers whoami without a dashboardUrl, and
  // keying the fallback off the value would ask the same question twice every time.
  let askedWhoami = false;
  if (envKey !== undefined && envKey.length > 0) {
    const who = WhoamiSchema.parse(await api('GET', `${url}/v1/cloud/whoami`, envKey));
    projectId = who.projectId;
    projectName = who.projectName;
    dashboardUrl = who.dashboardUrl;
    askedWhoami = true;
    key = envKey;
  } else if (session !== null) {
    // --project accepts a slug id OR a display name; default when omitted. Resolve to the canonical id.
    const wanted = f['project'];
    const targetId =
      wanted === undefined
        ? DEFAULT_PROJECT_ID
        : await resolveProjectId(url, session.token, wanted);
    /*
     * Reuse the key this machine already holds for the project, rather than minting another.
     *
     * `link` was idempotent about the BINDING and not about the KEY: two runs against one project
     * left two live `reticle-cli` keys on the account, each valid, neither identifiable to a repo.
     * Agents retry — that is what agents do — so it accumulates silently until somebody has a key
     * list they cannot reason about and revokes the wrong one. Measured: proving an unrelated fix
     * with two `link` runs created exactly that.
     *
     * Validated before trusting, because a stored key can have been revoked or rotated from the
     * dashboard and a stale credential must not strand the repo. The check is the whoami call the
     * mint path already makes for `dashboardUrl`, so the common path costs no extra round trip —
     * and a key that fails it is replaced rather than reported.
     */
    const existing = await storedCredential(targetId, url);
    const reusable = existing === undefined ? undefined : await validateKey(url, existing);
    if (existing !== undefined && reusable !== undefined) {
      projectId = reusable.projectId;
      projectName = reusable.projectName;
      dashboardUrl = reusable.dashboardUrl;
      askedWhoami = true;
      key = existing;
      reusedKey = true;
    } else {
      const minted = KeySchema.parse(
        await api('POST', `${url}/v1/keys`, session.token, {
          name: 'reticle-cli',
          projectId: targetId,
        }),
      );
      projectId = minted.projectId;
      projectName = minted.projectName;
      key = minted.key;
    }
  } else {
    err('run `reticle login` first, or set RETICLE_CLOUD_KEY to link with an existing key');
    return 2;
  }

  const reticleDir = join(process.cwd(), RETICLE_DIR);
  await mkdir(reticleDir, { recursive: true });
  const linkPath = join(reticleDir, CLOUD_LINK_FILE);
  const prev = await readJson(linkPath);
  const prevObj =
    'object' === typeof prev && prev !== null ? (prev as Record<string, unknown>) : {};
  // The minted-key path has not asked yet. Best-effort: a link that works is worth more than a link
  // that also has a link in it, and an older cloud simply does not send one.
  if (!askedWhoami) {
    try {
      dashboardUrl = WhoamiSchema.parse(
        await api('GET', `${url}/v1/cloud/whoami`, key),
      ).dashboardUrl;
    } catch {
      // Older cloud, or a transient failure. The HUD shows its list without a link.
    }
  }

  const cloudJson = {
    projectId,
    projectName,
    url,
    ...(dashboardUrl === undefined ? {} : { dashboardUrl }),
    sync: prevObj['sync'] ?? { runs: true, memory: true, flows: true },
    verify: prevObj['verify'] ?? 'local',
  };
  await writeFile(linkPath, `${JSON.stringify(cloudJson, null, 2)}\n`);

  await mkdir(home(), { recursive: true });
  const credPath = join(home(), CREDENTIALS_FILE);
  const creds = (await readJson(credPath)) ?? {};
  const credObj =
    'object' === typeof creds && creds !== null ? (creds as Record<string, unknown>) : {};
  /*
   * Stamped with the cloud it belongs to.
   *
   * The store was keyed by project id alone, and `link` names every project "default" — so a repo
   * on a self-hosted install and a repo on the hosted service shared one slot, last writer winning.
   * Measured on one machine: the production key was being handed to a localhost server. A key now
   * carries the URL that minted it, and the resolver refuses it anywhere else.
   */
  /*
   * Keyed by CLOUD and project, not project alone.
   *
   * `link` names every project "default", so a repo on a self-hosted install and a repo on the
   * hosted service both claimed the slot `default` and the last link won — measured on one machine,
   * with a production key then being handed to a localhost server. The composite slot lets both be
   * held at once; the stamped `url` inside makes a mismatched read refuse rather than dial.
   *
   * The bare `projectId` slot is written too, so a daemon running an OLDER build still finds this
   * credential. It is the ambiguous one and the resolver prefers the composite.
   */
  credObj[credentialSlot(url, projectId)] = key;
  credObj[projectId] = { key, url };
  await writeFile(credPath, `${JSON.stringify(credObj, null, 2)}\n`);

  emit({ linked: projectName, projectId, cloudJson: linkPath, credentials: credPath });
  /*
   * Say what just happened, in the vocabulary of somebody who has used other tools.
   *
   * `link` mints the key and stores it for you, which is the product's whole edge — and it is
   * invisible, which is its whole cost. A real report: somebody pasted a masked placeholder key
   * into a `.env` because their mental model said "I must make a key and put it somewhere". One had
   * already been minted and filed outside the repo. They did not need another step; they needed to
   * be told the step had happened.
   *
   * The key is identified the way the dashboard identifies it — a prefix, never the secret — so
   * this can be read aloud, pasted into an issue, or left in a terminal without leaking anything.
   */
  hint(`bound this repo to project "${projectName}"`);
  hint(
    reusedKey
      ? `reusing key ${keyHint(key)} — already stored in ${credPath}, not in your repo`
      : `minted key ${keyHint(key)} — stored in ${credPath}, not in your repo`,
  );
  hint('to change it: `reticle link --project <other>`; to inspect: `reticle whoami`');
  hint(
    'linked ✓ runs auto-push on `reticle verify`; `reticle push` sends existing local runs; `reticle whoami` shows state',
  );
  return 0;
};

/** `reticle config [--runs on|off] [--memory on|off] [--flows on|off] [--verify local|server]`. */
const cmdConfig = async (argv: readonly string[]): Promise<number> => {
  const f = flags(argv);
  const linkPath = join(process.cwd(), RETICLE_DIR, CLOUD_LINK_FILE);
  const raw = await readJson(linkPath);
  if (null === raw || typeof raw !== 'object') {
    err('no .reticle/cloud.json here — run `reticle link` first');
    return 2;
  }
  const cfg = raw as Record<string, unknown>;
  const sync =
    'object' === typeof cfg['sync'] && cfg['sync'] !== null
      ? (cfg['sync'] as Record<string, boolean>)
      : { runs: true, memory: true, flows: true };
  const onoff = (v: string | undefined): boolean | undefined =>
    'on' === v ? true : 'off' === v ? false : undefined;
  for (const k of ['runs', 'memory', 'flows'] as const) {
    if (f[k] === undefined) continue;
    const b = onoff(f[k]);
    if (b === undefined) {
      err(`--${k} must be on|off`);
      return 2;
    }
    sync[k] = b;
  }
  cfg['sync'] = sync;
  if (f['verify'] !== undefined) {
    if (f['verify'] !== 'local' && f['verify'] !== 'server') {
      err('--verify must be local|server');
      return 2;
    }
    cfg['verify'] = f['verify'];
  }
  await writeFile(linkPath, `${JSON.stringify(cfg, null, 2)}\n`);
  emit({ updated: linkPath, sync: cfg['sync'], verify: cfg['verify'] });
  return 0;
};

/**
 * `reticle sync [--watch]` — one full cycle: send the difference, collect what came back.
 *
 * This replaced a `push` that re-uploaded every run artifact on every invocation. That was fine with
 * three runs and absurd with three hundred, and it only ever went one way — so a bug somebody
 * resolved on the dashboard stayed open on the laptop forever.
 *
 * The sync POLICY is applied here rather than inside the protocol: a project that has turned runs or
 * flows off simply presents a source with nothing in it, and the cycle does not need to know why.
 */
const cmdSync = async (argv: readonly string[]): Promise<number> => {
  const fs = createNodeFileSystem();
  const reticleRoot = join(process.cwd(), RETICLE_DIR);
  const cloud = await resolveProjectCloud(fs, reticleRoot, homedir(), process.env);
  if (null === cloud.config) {
    err('cloud not attached here — run `reticle link` (or set RETICLE_CLOUD_URL/KEY)');
    return 1;
  }
  const config = cloud.config;
  const full = diskSource(reticleRoot);
  const source = {
    runs: (): ReturnType<typeof full.runs> => (cloud.policy.runs ? full.runs() : []),
    flows: (): readonly unknown[] => (cloud.policy.flows ? full.flows() : []),
    // `memory` is the project's cross-run history and the derived records that summarise it.
    derived: (kind: Parameters<typeof full.derived>[0]): unknown =>
      cloud.policy.memory ? full.derived(kind) : undefined,
  };

  const once = async (): Promise<number> => {
    const report = await runSyncCycle({
      config,
      source,
      sink: diskSink(reticleRoot),
      state: readCloudState(reticleRoot),
      now: () => Date.now(),
      request: async (url, init) => {
        const res = await fetch(url, init);
        return { status: res.status, text: await res.text() };
      },
    });
    emit({
      ok: report.ok,
      project: cloud.projectId,
      sent: {
        runs: report.runsSent,
        flows: report.flowsSent,
        records: report.derivedSent,
        ...(report.runsRejected.length > 0 ? { rejected: report.runsRejected } : {}),
      },
      pulled: report.pulled,
      ...(report.morePending ? { morePending: true } : {}),
      ...(report.error === undefined ? {} : { error: report.error }),
    });
    hint(describeSync(report));
    return report.ok ? 0 : 1;
  };

  const watch = argv.includes(WATCH_FLAG);
  if (!watch) return once();

  const everyMs = Number(process.env['RETICLE_SYNC_INTERVAL_MS'] ?? DEFAULT_SYNC_INTERVAL_MS);
  hint(`watching ${reticleRoot} — syncing every ${String(Math.round(everyMs / 1000))}s`);
  for (;;) {
    await once();
    await sleep(everyMs);
  }
};

/** `reticle push` — the name people already type. One cycle, same as `reticle sync`. */
const cmdPush = async (): Promise<number> => cmdSync([]);

/** Resolve THIS repo's linked cloud (url + project-scoped key). Throws a friendly error if not attached. */
const repoCloud = async (): Promise<{ url: string; apiKey: string }> => {
  const fs = createNodeFileSystem();
  const cloud = await resolveProjectCloud(
    fs,
    join(process.cwd(), RETICLE_DIR),
    homedir(),
    process.env,
  );
  if (null === cloud.config)
    throw new Error('cloud not attached here — run `reticle link` (or set RETICLE_CLOUD_URL/KEY)');
  return cloud.config;
};

/** `reticle runs` — the linked project's recent run artifacts (the key scopes it server-side). */
const cmdRuns = async (): Promise<number> => {
  const { url, apiKey } = await repoCloud();
  emit(await api('GET', `${url}/v1/runs`, apiKey));
  return 0;
};

/** `reticle regression` — the CI gate: broken flows vs before. Exit 3 if any regressed (pipeline-friendly). */
const cmdRegression = async (): Promise<number> => {
  const { url, apiKey } = await repoCloud();
  const report = await api('GET', `${url}/v1/project/regression`, apiKey);
  emit(report);
  const parsed = z.object({ broken: z.array(z.unknown()) }).safeParse(report);
  return parsed.success && parsed.data.broken.length > 0 ? 3 : 0;
};

/** `reticle share <runId>` — mint a public proof link for one run. */
const cmdShare = async (argv: readonly string[]): Promise<number> => {
  const runId = argv[0];
  if (runId === undefined) {
    err('usage: reticle share <runId>');
    return 2;
  }
  const { url, apiKey } = await repoCloud();
  emit(await api('POST', `${url}/v1/runs/${encodeURIComponent(runId)}/share`, apiKey));
  return 0;
};

/** Dispatch a cloud subcommand. Returns the process exit code. */
export const runCloudCommand = async (argv: readonly string[]): Promise<number> => {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'login':
        return await cmdLogin(rest);
      case 'logout':
        return await cmdLogout(rest);
      case 'whoami':
        return await cmdWhoami();
      case 'project':
        return await cmdProject(rest);
      case 'link':
        return await cmdLink(rest);
      case 'config':
        return await cmdConfig(rest);
      case 'push':
        return await cmdPush();
      case 'sync':
        return await cmdSync(rest);
      case 'runs':
        return await cmdRuns();
      case 'regression':
        return await cmdRegression();
      case 'share':
        return await cmdShare(rest);
      default:
        err(`unknown cloud command '${cmd ?? ''}'`);
        return 2;
    }
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
};
