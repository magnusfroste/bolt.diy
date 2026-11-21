import { describe, expect, it } from 'vitest';
import { shipholmAppName } from './shipholm';
import { deployToShipholm, normalizeRepoUrl, type GitHubPort } from './shipholm-deploy';

function github(existing = false) {
  const pushed: string[] = [];
  const created: Array<{ name: string; isPrivate: boolean }> = [];

  const port: GitHubPort = {
    login: 'ada',
    token: 'gh',
    repositoryExists: async (name) => (existing ? { url: `https://github.com/ada/${name}` } : null),
    createRepository: async (name, isPrivate) => {
      created.push({ name, isPrivate });
      return { url: `https://github.com/ada/${name}` };
    },
    pushFiles: async (url, files) => {
      pushed.push(url, ...Object.keys(files));
      return [];
    },
  };

  return { port, pushed, created };
}

/** A Shipholm API stand-in: the app's status goes through the given states, one per poll. */
function shipholm(app: Record<string, unknown> | null, statuses: Array<Record<string, unknown>>) {
  const calls: Array<[string, Record<string, unknown>]> = [];

  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    calls.push([tool, args]);

    if (tool === 'get_app') {
      if (!app) {
        throw new Error("app 't1/shop' does not exist");
      }

      return app;
    }

    if (tool === 'app_status') {
      return statuses.length > 1 ? statuses.shift() : statuses[0];
    }

    return tool === 'create_app' ? { url: 'https://shop.shipholm.dev' } : {};
  };

  return { call: call as never, calls };
}

const LIVE = {
  url: 'https://shop.shipholm.dev',
  ready: true,
  build: { status: 'success', rebuild_requested: false },
};

const noSleep = async () => undefined;

describe('deployToShipholm', () => {
  it('creates the repository and the app, then waits for the first build', async () => {
    const gh = github();

    const sh = shipholm(null, [{ ready: false, build: {} }, { ready: false, build: { status: 'running' } }, LIVE]);

    const steps: string[] = [];

    const result = await deployToShipholm({
      app: 'shop',
      files: { 'package.json': '{}', 'src/main.tsx': '' },
      isPrivate: false,
      github: gh.port,
      call: sh.call,
      sleep: noSleep,
      onProgress: (p) => steps.push(p.step),
    });

    expect(result).toEqual({
      url: 'https://shop.shipholm.dev',
      repoUrl: 'https://github.com/ada/shop',
      created: true,
      installUrl: undefined,
    });
    expect(gh.created).toEqual([{ name: 'shop', isPrivate: false }]);
    expect(gh.pushed).toEqual(['https://github.com/ada/shop', 'package.json', 'src/main.tsx']);
    expect(sh.calls.find(([t]) => t === 'create_app')?.[1]).toEqual({
      app: 'shop',
      source_repo: 'https://github.com/ada/shop',
      scale_to_zero: true,
    });
    expect(steps).toEqual(['github', 'app', 'build', 'build', 'done']);
  });

  it('rebuilds an app built from the same repository and waits for that build', async () => {
    const gh = github(true);

    const sh = shipholm({ source: { repo: 'https://github.com/ada/shop' } }, [
      { ...LIVE, build: { status: 'success', rebuild_requested: true } }, // old build still serving
      LIVE,
    ]);

    await deployToShipholm({
      app: 'shop',
      files: {},
      isPrivate: false,
      github: gh.port,
      call: sh.call,
      sleep: noSleep,
    });

    expect(gh.created).toEqual([]);
    expect(sh.calls.map(([t]) => t)).toEqual(['get_app', 'rebuild_app', 'app_status', 'app_status']);
  });

  it('refuses to take over an app built from another repository', async () => {
    const sh = shipholm({ source: { repo: 'https://github.com/ada/other' } }, [LIVE]);

    await expect(
      deployToShipholm({ app: 'shop', files: {}, isPrivate: false, github: github().port, call: sh.call }),
    ).rejects.toThrow(/already have an app called "shop".*ada\/other/);
    expect(sh.calls.map(([t]) => t)).toEqual(['get_app']);
  });

  it('stops on a failed build with the platform hint', async () => {
    const sh = shipholm(null, [{ ready: false, build: { status: 'failure' }, hints: ['read build_log'] }]);

    await expect(
      deployToShipholm({ app: 'shop', files: {}, isPrivate: false, github: github().port, call: sh.call }),
    ).rejects.toThrow('The build on Shipholm failed. read build_log');
  });
});

describe('names', () => {
  it('turns project names into valid app names', () => {
    expect(shipholmAppName('My Cool_App.v2')).toBe('my-cool-app-v2');
    expect(shipholmAppName('123 Shop!')).toBe('shop');
    expect(shipholmAppName('---')).toBe('my-app');
    expect(shipholmAppName('a'.repeat(40) + '-x')).toHaveLength(30);
  });

  it('normalizes repository URLs', () => {
    expect(normalizeRepoUrl('https://github.com/ada/shop.git')).toBe('https://github.com/ada/shop');
    expect(normalizeRepoUrl('https://github.com/ada/shop/')).toBe('https://github.com/ada/shop');
  });
});
