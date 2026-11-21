/*
 * Deploy to Shipholm: the project goes to a GitHub repository (Shipholm builds from git, like
 * Vercel), then Shipholm creates the app – or rebuilds it – and we wait until it serves.
 *
 * Kept free of React and of the WebContainer so it can be tested on its own; the dialog passes
 * in the GitHub and Shipholm calls.
 */
import type { ShipholmAppStatus } from './shipholm';

export interface GitHubPort {
  login: string;
  token: string;
  repositoryExists(name: string, token: string): Promise<{ url: string } | null>;
  createRepository(name: string, isPrivate: boolean, token: string): Promise<{ url: string }>;
  pushFiles(
    url: string,
    files: Record<string, string>,
    token: string,
    onProgress?: (current: number, total: number) => void,
  ): Promise<unknown>;
}

export type ShipholmCall = <T = Record<string, unknown>>(tool: string, args?: Record<string, unknown>) => Promise<T>;

export type DeployStep = 'github' | 'app' | 'build' | 'done';

export interface DeployProgress {
  step: DeployStep;
  message: string;
  status?: ShipholmAppStatus;
}

export interface DeployResult {
  url: string | null;
  repoUrl: string;
  created: boolean;
  installUrl?: string;
}

export interface DeployOptions {
  app: string;
  files: Record<string, string>;
  isPrivate: boolean;
  github: GitHubPort;
  call: ShipholmCall;
  onProgress?: (p: DeployProgress) => void;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The repository URL Shipholm expects: https://github.com/<owner>/<repo>, nothing more. */
export function normalizeRepoUrl(url: string): string {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : url;
}

export async function deployToShipholm(o: DeployOptions): Promise<DeployResult> {
  const report = o.onProgress || (() => undefined);
  const sleep = o.sleep || wait;

  // 1. the source, in the customer's own GitHub account
  report({ step: 'github', message: `Pushing to github.com/${o.github.login}/${o.app}` });

  const repo =
    (await o.github.repositoryExists(o.app, o.github.token)) ||
    (await o.github.createRepository(o.app, o.isPrivate, o.github.token));

  const repoUrl = normalizeRepoUrl(repo.url);

  await o.github.pushFiles(repo.url, o.files, o.github.token, (current, total) =>
    report({ step: 'github', message: `Pushing files to GitHub (${current}/${total})` }),
  );

  // 2. the app on Shipholm: new, or a rebuild of the one built from this repository
  report({ step: 'app', message: 'Setting up the app on Shipholm' });

  let existing: { source?: { repo?: string } | null } | null = null;

  try {
    existing = await o.call('get_app', { app: o.app });
  } catch (error) {
    if (!/does not exist/i.test(String((error as Error).message))) {
      throw error;
    }
  }

  let created = false;
  let installUrl: string | undefined;

  if (existing) {
    const current = existing.source?.repo ? normalizeRepoUrl(existing.source.repo) : null;

    if (current !== repoUrl) {
      throw new Error(
        `You already have an app called "${o.app}" on Shipholm` +
          (current ? `, built from ${current}` : '') +
          '. Pick another name.',
      );
    }

    await o.call('rebuild_app', { app: o.app });
  } else {
    const res = await o.call<{ url?: string; action_required?: { install_url?: string } }>('create_app', {
      app: o.app,
      source_repo: repoUrl,
      scale_to_zero: true,
    });
    created = true;
    installUrl = res.action_required?.install_url;
  }

  // 3. wait for the build and the first healthy pod
  const started = Date.now();
  const timeout = o.timeoutMs ?? 20 * 60 * 1000;

  let status: ShipholmAppStatus | null = null;

  while (Date.now() - started < timeout) {
    status = await o.call<ShipholmAppStatus>('app_status', { app: o.app });

    // a rebuild request is cleared only when that build has finished
    const built = status.build?.status === 'success' && !status.build.rebuild_requested;

    if (status.ready && built) {
      report({ step: 'done', message: 'Live', status });
      return { url: status.url, repoUrl, created, installUrl };
    }

    if (status.build?.status === 'failure') {
      throw new Error(
        'The build on Shipholm failed. ' + (status.hints?.[0] || 'Open the build log in the Shipholm portal.'),
      );
    }

    report({
      step: 'build',
      message: status.build?.status === 'running' ? 'Building on Shipholm' : 'Waiting for the build to start',
      status,
    });
    await sleep(o.pollMs ?? 10_000);
  }

  throw new Error('The app is not ready yet – it keeps building on Shipholm; check it in the portal.');
}
