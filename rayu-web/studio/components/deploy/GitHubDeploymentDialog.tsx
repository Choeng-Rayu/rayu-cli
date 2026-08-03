import { backend } from '~/lib/rayu/backendClient';
import { BACKEND } from '~/lib/rayu/endpoints';
import * as Dialog from '@radix-ui/react-dialog';
import { useState, useEffect } from 'react';
import { toast } from 'react-toastify';
import { motion } from 'framer-motion';
import { classNames } from '~/utils/classNames';
import { getLocalStorage } from '~/lib/persistence/localStorage';
import type { GitHubUserResponse, GitHubRepoInfo } from '~/types/GitHub';
import { logStore } from '~/lib/stores/logs';
import { chatId } from '~/lib/persistence/useChatHistory';
import { useStore } from '@nanostores/react';
import { GitHubAuthDialog } from '~/components/@settings/tabs/github/components/GitHubAuthDialog';
import { SearchInput, EmptyState, StatusIndicator, Badge } from '~/components/ui';

interface GitHubDeploymentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectName: string;
  files: Record<string, string>;
}

export function GitHubDeploymentDialog({ isOpen, onClose, projectName, files }: GitHubDeploymentDialogProps) {
  const [repoName, setRepoName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [user, setUser] = useState<GitHubUserResponse | null>(null);
  const [recentRepos, setRecentRepos] = useState<GitHubRepoInfo[]>([]);
  const [filteredRepos, setFilteredRepos] = useState<GitHubRepoInfo[]>([]);
  const [repoSearchQuery, setRepoSearchQuery] = useState('');
  const [isFetchingRepos, setIsFetchingRepos] = useState(false);
  const [showSuccessDialog, setShowSuccessDialog] = useState(false);
  const [createdRepoUrl, setCreatedRepoUrl] = useState('');
  const [pushedFiles, setPushedFiles] = useState<{ path: string; size: number }[]>([]);
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const currentChatId = useStore(chatId);

  /*
   * Load GitHub connection on mount
   * Helper function to sanitize repository name
   */
  const sanitizeRepoName = (name: string): string => {
    return (
      name
        .toLowerCase()
        // Replace spaces and underscores with hyphens
        .replace(/[\s_]+/g, '-')
        // Remove special characters except hyphens and alphanumeric
        .replace(/[^a-z0-9-]/g, '')
        // Remove multiple consecutive hyphens
        .replace(/-+/g, '-')
        // Remove leading/trailing hyphens
        .replace(/^-+|-+$/g, '')
        // Ensure it's not empty and has reasonable length
        .substring(0, 100) || 'my-project'
    );
  };

  useEffect(() => {
    if (isOpen) {
      const connection = getLocalStorage('github_connection');

      // Set a default repository name based on the project name with proper sanitization
      setRepoName(sanitizeRepoName(projectName));

      if (connection?.user && connection?.token) {
        setUser(connection.user);

        // Only fetch if we have both user and token
        if (connection.token.trim()) {
          fetchRecentRepos(connection.token);
        }
      }
    }
  }, [isOpen, projectName]);

  // Filter repositories based on search query
  useEffect(() => {
    if (recentRepos.length === 0) {
      setFilteredRepos([]);
      return;
    }

    if (!repoSearchQuery.trim()) {
      setFilteredRepos(recentRepos);
      return;
    }

    const query = repoSearchQuery.toLowerCase().trim();
    const filtered = recentRepos.filter(
      (repo) =>
        repo.name.toLowerCase().includes(query) ||
        (repo.description && repo.description.toLowerCase().includes(query)) ||
        (repo.language && repo.language.toLowerCase().includes(query)),
    );

    setFilteredRepos(filtered);
  }, [recentRepos, repoSearchQuery]);

  const fetchRecentRepos = async (token: string) => {
    if (!token) {
      logStore.logError('No GitHub token available');
      toast.error('GitHub authentication required');

      return;
    }

    try {
      setIsFetchingRepos(true);

      // Fetch ALL repos by paginating through all pages
      let allRepos: GitHubRepoInfo[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const requestUrl = `https://api.github.com/user/repos?sort=updated&per_page=100&page=${page}&affiliation=owner,organization_member`;
        const response = await fetch(requestUrl, {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            Authorization: `Bearer ${token.trim()}`,
          },
        });

        if (!response.ok) {
          let errorData: { message?: string } = {};

          try {
            errorData = await response.json();
          } catch {
            errorData = { message: 'Could not parse error response' };
          }

          if (response.status === 401) {
            toast.error('GitHub token expired. Please reconnect your account.');

            // Clear invalid token
            const connection = getLocalStorage('github_connection');

            if (connection) {
              localStorage.removeItem('github_connection');
              setUser(null);
            }
          } else if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
            // Rate limit exceeded
            const resetTime = response.headers.get('x-ratelimit-reset');
            const resetDate = resetTime ? new Date(parseInt(resetTime) * 1000).toLocaleTimeString() : 'soon';
            toast.error(`GitHub API rate limit exceeded. Limit resets at ${resetDate}`);
          } else {
            logStore.logError('Failed to fetch GitHub repositories', {
              status: response.status,
              statusText: response.statusText,
              error: errorData,
            });
            toast.error(`Failed to fetch repositories: ${errorData.message || response.statusText}`);
          }

          return;
        }

        try {
          const repos = (await response.json()) as GitHubRepoInfo[];
          allRepos = allRepos.concat(repos);

          if (repos.length < 100) {
            hasMore = false;
          } else {
            page += 1;
          }
        } catch (parseError) {
          logStore.logError('Failed to parse GitHub repositories response', { parseError });
          toast.error('Failed to parse repository data');
          setRecentRepos([]);

          return;
        }
      }

      setRecentRepos(allRepos);
    } catch (error) {
      logStore.logError('Failed to fetch GitHub repositories', { error });
      toast.error('Failed to fetch recent repositories');
    } finally {
      setIsFetchingRepos(false);
    }
  };

  // Function to create a new repository or push to an existing one
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const connection = getLocalStorage('github_connection');

    if (!connection?.token || !connection?.user) {
      toast.error('Please connect your GitHub account in Settings > Connections first');
      return;
    }

    if (!repoName.trim()) {
      toast.error('Repository name is required');
      return;
    }

    // Validate repository name
    const sanitizedName = sanitizeRepoName(repoName);

    if (!sanitizedName || sanitizedName.length < 1) {
      toast.error('Repository name must contain at least one alphanumeric character');
      return;
    }

    if (sanitizedName.length > 100) {
      toast.error('Repository name is too long (maximum 100 characters)');
      return;
    }

    // Update the repo name field with the sanitized version if it was changed
    if (sanitizedName !== repoName) {
      setRepoName(sanitizedName);
      toast.info(`Repository name sanitized to: ${sanitizedName}`);
    }

    setIsLoading(true);

    try {
      /*
       * bolt.diy drove @octokit/rest from the browser here with the user's
       * personal access token: check/create the repo, build a tree, create a
       * commit, move the ref. Rayu Studio keeps GitHub credentials encrypted in
       * rayu-backend, so the file map is posted and the git plumbing happens
       * server-side (POST /api/studio/scm/github/push).
       */
      const sanitizedRepoName = sanitizeRepoName(repoName);

      /*
       * Preserve bolt's overwrite confirmation. The push endpoint is
       * create-or-update, so without asking first an existing repository would be
       * modified silently. `recentRepos` is already loaded for the picker.
       */
      const alreadyExists = recentRepos.some((r) => r.name === sanitizedRepoName);

      if (alreadyExists) {
        const confirmed = window.confirm(
          `Repository "${sanitizedRepoName}" already exists. Update it? This will add or modify files in the repository.`,
        );

        if (!confirmed) {
          setIsLoading(false);
          return;
        }
      }

      const fileEntries = Object.entries(files);

      const pushResult = await backend.post<{
        owner: string;
        repo: string;
        branch: string;
        htmlUrl: string;
        created: boolean;
      }>(BACKEND.githubPush, {
        repo: sanitizedRepoName,
        files,
        commitMessage: `Deploy ${projectName} from Rayu Studio`,
        private: isPrivate,
      });

      setCreatedRepoUrl(pushResult.htmlUrl);
      setPushedFiles(
        fileEntries.map(([path, content]) => ({
          path,
          size: new TextEncoder().encode(content).length,
        })),
      );

      // Save the repository information for this chat. Values come from the push
      // result so they reflect what the backend actually created.
      localStorage.setItem(
        `github-repo-${currentChatId}`,
        JSON.stringify({
          owner: pushResult.owner,
          name: pushResult.repo,
          url: pushResult.htmlUrl,
        }),
      );

      // Show success dialog
      setShowSuccessDialog(true);
    } catch (error) {
      console.error('Error pushing to GitHub:', error);

      // Attempt to extract more specific error information
      let errorMessage = 'Failed to push to GitHub';
      let isRetryable = false;

      if (error instanceof Error) {
        const errorMsg = error.message.toLowerCase();

        if (errorMsg.includes('network') || errorMsg.includes('fetch failed') || errorMsg.includes('connection')) {
          errorMessage = 'Network error. Please check your internet connection and try again.';
          isRetryable = true;
        } else if (errorMsg.includes('401') || errorMsg.includes('unauthorized')) {
          errorMessage = 'GitHub authentication failed. Please check your access token in Settings > Connections.';
        } else if (errorMsg.includes('403') || errorMsg.includes('forbidden')) {
          errorMessage =
            'Access denied. Your GitHub token may not have sufficient permissions to create/modify repositories.';
        } else if (errorMsg.includes('404') || errorMsg.includes('not found')) {
          errorMessage = 'Repository or resource not found. Please check the repository name and your permissions.';
        } else if (errorMsg.includes('422') || errorMsg.includes('validation failed')) {
          if (errorMsg.includes('name already exists')) {
            errorMessage =
              'A repository with this name already exists in your account. Please choose a different name.';
          } else {
            errorMessage = 'Repository validation failed. Please check the repository name and settings.';
          }
        } else if (errorMsg.includes('rate limit') || errorMsg.includes('429')) {
          errorMessage = 'GitHub API rate limit exceeded. Please wait a moment and try again.';
          isRetryable = true;
        } else if (errorMsg.includes('timeout')) {
          errorMessage = 'Request timed out. Please check your connection and try again.';
          isRetryable = true;
        } else {
          errorMessage = `GitHub error: ${error.message}`;
        }
      } else if (typeof error === 'object' && error !== null) {
        // Octokit errors
        if ('message' in error) {
          errorMessage = `GitHub API error: ${error.message as string}`;
        }

        // GitHub API errors
        if ('documentation_url' in error) {
          console.log('GitHub API documentation:', error.documentation_url);
        }
      }

      // Show error with retry suggestion if applicable
      const finalMessage = isRetryable ? `${errorMessage} Click to retry.` : errorMessage;
      toast.error(finalMessage);

      // Log detailed error for debugging
      console.error('Detailed GitHub deployment error:', {
        error,
        repoName: sanitizeRepoName(repoName),
        user: connection?.user?.login,
        isRetryable,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setRepoName('');
    setIsPrivate(false);
    setShowSuccessDialog(false);
    setCreatedRepoUrl('');
    onClose();
  };

  const handleAuthDialogClose = () => {
    setShowAuthDialog(false);

    // Refresh user data after auth
    const connection = getLocalStorage('github_connection');

    if (connection?.user && connection?.token) {
      setUser(connection.user);
      fetchRecentRepos(connection.token);
    }
  };

  // Success Dialog
  if (showSuccessDialog) {
    return (
      <Dialog.Root open={isOpen} onOpenChange={(open) => !open && handleClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[9999]" />
          <div className="fixed inset-0 flex items-center justify-center z-[9999]">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="w-[90vw] md:w-[600px] max-h-[85vh] overflow-y-auto"
            >
              <Dialog.Content
                className="bg-white dark:bg-bolt-elements-background-depth-1 rounded-lg border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark shadow-xl"
                aria-describedby="success-dialog-description"
              >
                <Dialog.Title className="sr-only">Successfully pushed to GitHub</Dialog.Title>
                <div className="p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center text-green-500">
                        <div className="i-ph:check-circle w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="text-lg font-medium text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark">
                          Successfully pushed to GitHub
                        </h3>
                        <p
                          id="success-dialog-description"
                          className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark"
                        >
                          Your code is now available on GitHub
                        </p>
                      </div>
                    </div>
                    <Dialog.Close asChild>
                      <button
                        onClick={handleClose}
                        className="p-2 rounded-lg transition-all duration-200 ease-in-out bg-transparent text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary dark:text-bolt-elements-textTertiary-dark dark:hover:text-bolt-elements-textPrimary-dark hover:bg-bolt-elements-background-depth-2 dark:hover:bg-bolt-elements-background-depth-3 focus:outline-none focus:ring-2 focus:ring-bolt-elements-borderColor dark:focus:ring-bolt-elements-borderColor-dark"
                      >
                        <span className="i-ph:x block w-5 h-5" aria-hidden="true" />
                        <span className="sr-only">Close dialog</span>
                      </button>
                    </Dialog.Close>
                  </div>

                  <div className="bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 rounded-lg p-4 text-left border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark">
                    <p className="text-sm font-medium text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark mb-2 flex items-center gap-2">
                      <span className="i-ph:github-logo w-4 h-4 text-purple-500" />
                      Repository URL
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-sm bg-bolt-elements-background-depth-1 dark:bg-bolt-elements-background-depth-4 px-3 py-2 rounded border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark font-mono">
                        {createdRepoUrl}
                      </code>
                      <motion.button
                        onClick={() => {
                          navigator.clipboard.writeText(createdRepoUrl);
                          toast.success('URL copied to clipboard');
                        }}
                        className="p-2 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary dark:text-bolt-elements-textSecondary-dark dark:hover:text-bolt-elements-textPrimary-dark bg-bolt-elements-background-depth-1 dark:bg-bolt-elements-background-depth-4 rounded-lg border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark"
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                      >
                        <div className="i-ph:copy w-4 h-4" />
                      </motion.button>
                    </div>
                  </div>

                  <div className="bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 rounded-lg p-4 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark">
                    <p className="text-sm font-medium text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark mb-2 flex items-center gap-2">
                      <span className="i-ph:files w-4 h-4 text-purple-500" />
                      Pushed Files ({pushedFiles.length})
                    </p>
                    <div className="max-h-[200px] overflow-y-auto custom-scrollbar pr-2">
                      {pushedFiles.slice(0, 100).map((file) => (
                        <div
                          key={file.path}
                          className="flex items-center justify-between py-1.5 text-sm text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark border-b border-bolt-elements-borderColor/30 dark:border-bolt-elements-borderColor-dark/30 last:border-0"
                        >
                          <span className="font-mono truncate flex-1 text-xs">{file.path}</span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-bolt-elements-background-depth-3 dark:bg-bolt-elements-background-depth-4 text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark ml-2">
                            {(file.size / 1024).toFixed(1)} KB
                          </span>
                        </div>
                      ))}
                      {pushedFiles.length > 100 && (
                        <div className="py-2 text-center text-xs text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark">
                          +{pushedFiles.length - 100} more files
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <motion.a
                      href={createdRepoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 rounded-lg bg-purple-500 text-white hover:bg-purple-600 text-sm inline-flex items-center gap-2"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      <div className="i-ph:github-logo w-4 h-4" />
                      View Repository
                    </motion.a>
                    <motion.button
                      onClick={() => {
                        navigator.clipboard.writeText(createdRepoUrl);
                        toast.success('URL copied to clipboard');
                      }}
                      className="px-4 py-2 rounded-lg bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark hover:bg-bolt-elements-background-depth-3 dark:hover:bg-bolt-elements-background-depth-4 text-sm inline-flex items-center gap-2 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      <div className="i-ph:copy w-4 h-4" />
                      Copy URL
                    </motion.button>
                    <motion.button
                      onClick={handleClose}
                      className="px-4 py-2 rounded-lg bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark hover:bg-bolt-elements-background-depth-3 dark:hover:bg-bolt-elements-background-depth-4 text-sm border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      Close
                    </motion.button>
                  </div>
                </div>
              </Dialog.Content>
            </motion.div>
          </div>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  if (!user) {
    return (
      <Dialog.Root open={isOpen} onOpenChange={(open) => !open && handleClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[9999]" />
          <div className="fixed inset-0 flex items-center justify-center z-[9999]">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="w-[90vw] md:w-[500px]"
            >
              <Dialog.Content
                className="bg-white dark:bg-bolt-elements-background-depth-1 rounded-lg p-6 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark shadow-xl"
                aria-describedby="connection-required-description"
              >
                <Dialog.Title className="sr-only">GitHub Connection Required</Dialog.Title>
                <div className="relative text-center space-y-4">
                  <Dialog.Close asChild>
                    <button
                      onClick={handleClose}
                      className="absolute right-0 top-0 p-2 rounded-lg transition-all duration-200 ease-in-out bg-transparent text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary dark:text-bolt-elements-textTertiary-dark dark:hover:text-bolt-elements-textPrimary-dark hover:bg-bolt-elements-background-depth-2 dark:hover:bg-bolt-elements-background-depth-3 focus:outline-none focus:ring-2 focus:ring-bolt-elements-borderColor dark:focus:ring-bolt-elements-borderColor-dark"
                    >
                      <span className="i-ph:x block w-5 h-5" aria-hidden="true" />
                      <span className="sr-only">Close dialog</span>
                    </button>
                  </Dialog.Close>
                  <motion.div
                    initial={{ scale: 0.8 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: 0.1 }}
                    className="mx-auto w-16 h-16 rounded-xl bg-bolt-elements-background-depth-3 flex items-center justify-center text-purple-500"
                  >
                    <div className="i-ph:github-logo w-8 h-8" />
                  </motion.div>
                  <h3 className="text-lg font-medium text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark">
                    GitHub Connection Required
                  </h3>
                  <p
                    id="connection-required-description"
                    className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark max-w-md mx-auto"
                  >
                    To deploy your code to GitHub, you need to connect your GitHub account first.
                  </p>
                  <div className="pt-2 flex justify-center gap-3">
                    <motion.button
                      className="px-4 py-2 rounded-lg bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark text-sm hover:bg-bolt-elements-background-depth-3 dark:hover:bg-bolt-elements-background-depth-4 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={handleClose}
                    >
                      Close
                    </motion.button>
                    <motion.button
                      onClick={() => setShowAuthDialog(true)}
                      className="px-4 py-2 rounded-lg bg-purple-500 text-white text-sm hover:bg-purple-600 inline-flex items-center gap-2"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      <div className="i-ph:github-logo w-4 h-4" />
                      Connect GitHub Account
                    </motion.button>
                  </div>
                </div>
              </Dialog.Content>
            </motion.div>
          </div>
        </Dialog.Portal>

        {/* GitHub Auth Dialog */}
        <GitHubAuthDialog isOpen={showAuthDialog} onClose={handleAuthDialogClose} />
      </Dialog.Root>
    );
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[9999]" />
        <div className="fixed inset-0 flex items-center justify-center z-[9999]">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="w-[90vw] md:w-[500px]"
          >
            <Dialog.Content
              className="bg-white dark:bg-bolt-elements-background-depth-1 rounded-lg border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark shadow-xl"
              aria-describedby="push-dialog-description"
            >
              <div className="p-6">
                <div className="flex items-center gap-4 mb-6">
                  <motion.div
                    initial={{ scale: 0.8 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: 0.1 }}
                    className="w-10 h-10 rounded-xl bg-bolt-elements-background-depth-3 flex items-center justify-center text-purple-500"
                  >
                    <div className="i-ph:github-logo w-5 h-5" />
                  </motion.div>
                  <div>
                    <Dialog.Title className="text-lg font-medium text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark">
                      Deploy to GitHub
                    </Dialog.Title>
                    <p
                      id="push-dialog-description"
                      className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark"
                    >
                      Deploy your code to a new or existing GitHub repository
                    </p>
                  </div>
                  <Dialog.Close asChild>
                    <button
                      onClick={handleClose}
                      className="ml-auto p-2 rounded-lg transition-all duration-200 ease-in-out bg-transparent text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary dark:text-bolt-elements-textTertiary-dark dark:hover:text-bolt-elements-textPrimary-dark hover:bg-bolt-elements-background-depth-2 dark:hover:bg-bolt-elements-background-depth-3 focus:outline-none focus:ring-2 focus:ring-bolt-elements-borderColor dark:focus:ring-bolt-elements-borderColor-dark"
                    >
                      <span className="i-ph:x block w-5 h-5" aria-hidden="true" />
                      <span className="sr-only">Close dialog</span>
                    </button>
                  </Dialog.Close>
                </div>

                <div className="flex items-center gap-3 mb-6 p-4 bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 rounded-lg border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark">
                  <div className="relative">
                    <img src={user.avatar_url} alt={user.login} className="w-10 h-10 rounded-full" />
                    <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-purple-500 flex items-center justify-center text-white">
                      <div className="i-ph:github-logo w-3 h-3" />
                    </div>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark">
                      {user.name || user.login}
                    </p>
                    <p className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark">
                      @{user.login}
                    </p>
                  </div>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <label
                      htmlFor="repoName"
                      className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark"
                    >
                      Repository Name
                    </label>
                    <div className="relative">
                      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-bolt-elements-textTertiary dark:text-bolt-elements-textTertiary-dark">
                        <span className="i-ph:git-branch w-4 h-4" />
                      </div>
                      <input
                        id="repoName"
                        type="text"
                        value={repoName}
                        onChange={(e) => {
                          const value = e.target.value;
                          setRepoName(value);

                          // Show real-time feedback for invalid characters
                          const sanitized = sanitizeRepoName(value);

                          if (value && value !== sanitized) {
                            // Show preview of sanitized name without being too intrusive
                            e.target.setAttribute('data-sanitized', sanitized);
                          } else {
                            e.target.removeAttribute('data-sanitized');
                          }
                        }}
                        placeholder="my-awesome-project"
                        className="w-full pl-10 px-4 py-2 rounded-lg bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark placeholder-bolt-elements-textTertiary dark:placeholder-bolt-elements-textTertiary-dark focus:outline-none focus:ring-2 focus:ring-purple-500"
                        required
                        maxLength={100}
                        pattern="[a-zA-Z0-9\-_\s]+"
                        title="Repository name can contain letters, numbers, hyphens, underscores, and spaces"
                      />
                    </div>
                    {repoName && sanitizeRepoName(repoName) !== repoName && (
                      <p className="text-xs text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark mt-1">
                        Will be created as:{' '}
                        <span className="font-mono text-purple-600 dark:text-purple-400">
                          {sanitizeRepoName(repoName)}
                        </span>
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark">
                        Recent Repositories
                      </label>
                      <span className="text-xs text-bolt-elements-textTertiary dark:text-bolt-elements-textTertiary-dark">
                        {filteredRepos.length} of {recentRepos.length}
                      </span>
                    </div>

                    <div className="mb-2">
                      <SearchInput
                        placeholder="Search repositories..."
                        value={repoSearchQuery}
                        onChange={(e) => setRepoSearchQuery(e.target.value)}
                        onClear={() => setRepoSearchQuery('')}
                        className="bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark text-sm"
                      />
                    </div>

                    {recentRepos.length === 0 && !isFetchingRepos ? (
                      <EmptyState
                        icon="i-ph:github-logo"
                        title="No repositories found"
                        description="We couldn't find any repositories in your GitHub account."
                        variant="compact"
                      />
                    ) : (
                      <div className="space-y-2 max-h-[200px] overflow-y-auto pr-2 custom-scrollbar">
                        {filteredRepos.length === 0 && repoSearchQuery.trim() !== '' ? (
                          <EmptyState
                            icon="i-ph:magnifying-glass"
                            title="No matching repositories"
                            description="Try a different search term"
                            variant="compact"
                          />
                        ) : (
                          filteredRepos.map((repo) => (
                            <motion.button
                              key={repo.full_name}
                              type="button"
                              onClick={() => setRepoName(repo.name)}
                              className="w-full p-3 text-left rounded-lg bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 hover:bg-bolt-elements-background-depth-3 dark:hover:bg-bolt-elements-background-depth-4 transition-colors group border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark hover:border-purple-500/30"
                              whileHover={{ scale: 1.01 }}
                              whileTap={{ scale: 0.99 }}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <div className="i-ph:git-branch w-4 h-4 text-purple-500" />
                                  <span className="text-sm font-medium text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark group-hover:text-purple-500">
                                    {repo.name}
                                  </span>
                                </div>
                                {repo.private && (
                                  <Badge variant="primary" size="sm" icon="i-ph:lock w-3 h-3">
                                    Private
                                  </Badge>
                                )}
                              </div>
                              {repo.description && (
                                <p className="mt-1 text-xs text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark line-clamp-2">
                                  {repo.description}
                                </p>
                              )}
                              <div className="mt-2 flex items-center gap-2 flex-wrap">
                                {repo.language && (
                                  <Badge variant="subtle" size="sm" icon="i-ph:code w-3 h-3">
                                    {repo.language}
                                  </Badge>
                                )}
                                <Badge variant="subtle" size="sm" icon="i-ph:star w-3 h-3">
                                  {repo.stargazers_count.toLocaleString()}
                                </Badge>
                                <Badge variant="subtle" size="sm" icon="i-ph:git-fork w-3 h-3">
                                  {repo.forks_count.toLocaleString()}
                                </Badge>
                                <Badge variant="subtle" size="sm" icon="i-ph:clock w-3 h-3">
                                  {new Date(repo.updated_at).toLocaleDateString()}
                                </Badge>
                              </div>
                            </motion.button>
                          ))
                        )}
                      </div>
                    )}
                  </div>

                  {isFetchingRepos && (
                    <div className="flex items-center justify-center py-4">
                      <StatusIndicator status="loading" pulse={true} label="Loading repositories..." />
                    </div>
                  )}

                  <div className="p-3 bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 rounded-lg border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="private"
                        checked={isPrivate}
                        onChange={(e) => setIsPrivate(e.target.checked)}
                        className="rounded border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark text-purple-500 focus:ring-purple-500 dark:bg-bolt-elements-background-depth-3"
                      />
                      <label
                        htmlFor="private"
                        className="text-sm text-bolt-elements-textPrimary dark:text-bolt-elements-textPrimary-dark"
                      >
                        Make repository private
                      </label>
                    </div>
                    <p className="text-xs text-bolt-elements-textTertiary dark:text-bolt-elements-textTertiary-dark mt-2 ml-6">
                      Private repositories are only visible to you and people you share them with
                    </p>
                  </div>

                  <div className="pt-4 flex gap-2">
                    <motion.button
                      type="button"
                      onClick={handleClose}
                      className="px-4 py-2 rounded-lg bg-bolt-elements-background-depth-2 dark:bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary dark:text-bolt-elements-textSecondary-dark hover:bg-bolt-elements-background-depth-3 dark:hover:bg-bolt-elements-background-depth-4 text-sm border border-bolt-elements-borderColor dark:border-bolt-elements-borderColor-dark"
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      Cancel
                    </motion.button>
                    <motion.button
                      type="submit"
                      disabled={isLoading}
                      className={classNames(
                        'flex-1 px-4 py-2 bg-purple-500 text-white rounded-lg hover:bg-purple-600 text-sm inline-flex items-center justify-center gap-2',
                        isLoading ? 'opacity-50 cursor-not-allowed' : '',
                      )}
                      whileHover={!isLoading ? { scale: 1.02 } : {}}
                      whileTap={!isLoading ? { scale: 0.98 } : {}}
                    >
                      {isLoading ? (
                        <>
                          <div className="i-ph:spinner-gap animate-spin w-4 h-4" />
                          Deploying...
                        </>
                      ) : (
                        <>
                          <div className="i-ph:github-logo w-4 h-4" />
                          Deploy to GitHub
                        </>
                      )}
                    </motion.button>
                  </div>
                </form>
              </div>
            </Dialog.Content>
          </motion.div>
        </div>
      </Dialog.Portal>

      {/* GitHub Auth Dialog */}
      <GitHubAuthDialog isOpen={showAuthDialog} onClose={handleAuthDialogClose} />
    </Dialog.Root>
  );
}
