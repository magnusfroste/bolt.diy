import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import { githubDeploymentService } from './services/githubDeploymentService';
import { shipholmAppName, shipholmMe, shipholmTool, type ShipholmMe } from '~/lib/shipholm';
import { deployToShipholm, type DeployProgress, type DeployResult } from '~/lib/shipholm-deploy';
import { workbenchStore } from '~/lib/stores/workbench';
import { webcontainer } from '~/lib/webcontainer';
import { classNames } from '~/utils/classNames';
import { path } from '~/utils/path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '.next', '.turbo']);

/** The project's source files (what Shipholm builds from), without dependencies and build output. */
async function collectProjectFiles(): Promise<Record<string, string>> {
  const container = await webcontainer;
  const files: Record<string, string> = {};

  async function walk(dir: string, rel: string) {
    for (const entry of await container.fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = rel ? `${rel}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await walk(full, relative);
        }
      } else if (entry.isFile() && !entry.name.startsWith('.env') && !entry.name.endsWith('.log')) {
        try {
          files[relative] = await container.fs.readFile(full, 'utf-8');
        } catch {
          // unreadable (binary): skipped, like the GitHub deploy does
        }
      }
    }
  }

  await walk('/', '');

  return files;
}

const STEPS: Array<{ id: DeployProgress['step']; label: string }> = [
  { id: 'github', label: 'Push the source to GitHub' },
  { id: 'app', label: 'Create or update the app on Shipholm' },
  { id: 'build', label: 'Build and start' },
];

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function ShipholmDeployDialog({ isOpen, onClose }: Props) {
  const [me, setMe] = useState<ShipholmMe | null>(null);
  const [app, setApp] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [progress, setProgress] = useState<DeployProgress | null>(null);
  const [result, setResult] = useState<DeployResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const github = githubDeploymentService.getConnection();

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setError(null);
    setResult(null);
    setProgress(null);
    shipholmMe()
      .then(setMe)
      .catch(() => setMe({ enabled: false, signedIn: false, tenant: null, account: null }));

    const title = workbenchStore.firstArtifact?.title || 'my-app';
    setApp((current) => current || shipholmAppName(title));
  }, [isOpen]);

  const deploy = async () => {
    if (!github?.token || !github.user?.login) {
      return;
    }

    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const files = await collectProjectFiles();

      if (!Object.keys(files).length) {
        throw new Error('The project has no files yet.');
      }

      const done = await deployToShipholm({
        app,
        files,
        isPrivate,
        github: {
          login: github.user.login,
          token: github.token,
          repositoryExists: (name, token) => githubDeploymentService.repositoryExists(name, token),
          createRepository: (name, priv, token) => githubDeploymentService.createRepository(name, priv, token),
          pushFiles: (url, f, token, onProgress) => githubDeploymentService.pushFiles(url, f, token, onProgress),
        },
        call: shipholmTool,
        onProgress: setProgress,
      });
      setResult(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stepIndex = progress ? STEPS.findIndex((s) => s.id === progress.step) : -1;
  const validName = /^[a-z]([a-z0-9-]{0,28}[a-z0-9])?$/.test(app);

  let body: React.ReactNode;

  if (!me) {
    body = <p className="text-bolt-elements-textSecondary">Checking your Shipholm account…</p>;
  } else if (!me.enabled) {
    body = (
      <p className="text-bolt-elements-textSecondary">
        Deploying to Shipholm works on <a href="https://code.shipholm.com">code.shipholm.com</a>.
      </p>
    );
  } else if (!me.signedIn) {
    body = (
      <div className="space-y-4">
        <p className="text-bolt-elements-textSecondary">Sign in with your Shipholm account (GitHub) to deploy.</p>
        <a
          href="/auth/login"
          className="inline-block px-4 py-2 rounded-lg bg-accent-500 text-white hover:bg-accent-600 text-sm"
        >
          Sign in to Shipholm
        </a>
      </div>
    );
  } else if (!github?.token || !github.user?.login) {
    body = (
      <p className="text-bolt-elements-textSecondary">
        Shipholm builds your app from a GitHub repository. Connect GitHub first: Settings → Connections → GitHub.
      </p>
    );
  } else if (result) {
    body = (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-green-500">
          <div className="i-ph:check-circle text-2xl" />
          <span className="font-medium">Your app is live</span>
        </div>
        {result.url && (
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-accent-500 hover:underline break-all"
          >
            {result.url}
          </a>
        )}
        <p className="text-sm text-bolt-elements-textSecondary">
          Source:{' '}
          <a href={result.repoUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {result.repoUrl.replace('https://', '')}
          </a>
          . Every push to it deploys again; deploying from here does the same.
        </p>
        {result.installUrl && (
          <p className="text-sm text-bolt-elements-textSecondary">
            Tip:{' '}
            <a href={result.installUrl} target="_blank" rel="noopener noreferrer" className="text-accent-500">
              install the Shipholm GitHub App
            </a>{' '}
            on the repository for instant builds on push and private repositories.
          </p>
        )}
      </div>
    );
  } else {
    body = (
      <div className="space-y-4">
        <p className="text-sm text-bolt-elements-textSecondary">
          Signed in as {me.account?.github_login || me.tenant}
          {me.account?.plan ? ` · ${me.account.plan} plan` : ''}.{' '}
          <a href="/auth/logout" className="hover:underline">
            Sign out
          </a>
        </p>
        <label className="block text-sm text-bolt-elements-textPrimary">
          App name
          <input
            value={app}
            disabled={busy}
            onChange={(e) => setApp(e.target.value.toLowerCase())}
            className="mt-1 w-full px-3 py-2 rounded-lg bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor text-bolt-elements-textPrimary"
          />
          <span className="text-xs text-bolt-elements-textTertiary">
            Repository github.com/{github.user.login}/{app || '…'} · address {app || '…'}.shipholm.dev (or -01 when
            taken)
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm text-bolt-elements-textSecondary">
          <input type="checkbox" checked={isPrivate} disabled={busy} onChange={(e) => setIsPrivate(e.target.checked)} />
          Private repository (Shipholm then needs its GitHub App on it – you get a link)
        </label>
        {progress && (
          <ol className="space-y-1 text-sm">
            {STEPS.map((s, i) => (
              <li
                key={s.id}
                className={classNames(
                  'flex items-center gap-2',
                  i < stepIndex ? 'text-green-500' : i === stepIndex ? 'text-bolt-elements-textPrimary' : 'opacity-50',
                )}
              >
                <span
                  className={
                    i < stepIndex
                      ? 'i-ph:check'
                      : i === stepIndex && busy
                        ? 'i-svg-spinners:90-ring-with-bg'
                        : 'i-ph:circle'
                  }
                />
                {i === stepIndex ? progress.message : s.label}
              </li>
            ))}
          </ol>
        )}
        {error && <p className="text-sm text-red-500 break-words">{error}</p>}
        <button
          onClick={deploy}
          disabled={busy || !validName}
          className="px-4 py-2 rounded-lg bg-accent-500 text-white hover:bg-accent-600 text-sm disabled:opacity-50"
        >
          {busy ? 'Deploying…' : 'Deploy'}
        </button>
        {busy && (
          <p className="text-xs text-bolt-elements-textTertiary">
            The first build takes a few minutes. You can close this window; the app keeps building on Shipholm.
          </p>
        )}
      </div>
    );
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-bolt-elements-background-depth-1 rounded-lg shadow-xl z-50 w-[calc(100%-32px)] max-w-lg p-6 space-y-4">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-bolt-elements-textPrimary">
              Deploy to Shipholm
            </Dialog.Title>
            <Dialog.Close className="i-ph:x text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary" />
          </div>
          <Dialog.Description className="sr-only">Deploy this project to Shipholm</Dialog.Description>
          {body}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
