import { atom, computed } from 'nanostores';
import Cookies from 'js-cookie';
import { logStore } from '~/lib/stores/logs';
import { GitLabApiService } from '~/lib/services/gitlabApiService';
import { calculateStatsSummary } from '~/utils/gitlabStats';
import type { GitLabConnection, GitLabStats } from '~/types/GitLab';

// Auto-connect using environment variable
const envToken = import.meta.env?.VITE_GITLAB_ACCESS_TOKEN;

const gitlabConnectionAtom = atom<GitLabConnection>({
  user: null,
  token: envToken || '',
  tokenType: 'personal-access-token',
});

const gitlabUrlAtom = atom('https://gitlab.com');

// Initialize connection from localStorage on startup
function initializeConnection() {
  try {
    const savedConnection = localStorage.getItem('gitlab_connection');

    if (savedConnection) {
      const parsed = JSON.parse(savedConnection);
      parsed.tokenType = 'personal-access-token';

      if (parsed.gitlabUrl) {
        gitlabUrlAtom.set(parsed.gitlabUrl);
      }

      // Only set if we have a valid user
      if (parsed.user) {
        gitlabConnectionAtom.set(parsed);
      }
    }
  } catch (error) {
    console.error('Error initializing GitLab connection:', error);
    localStorage.removeItem('gitlab_connection');
  }
}

// Initialize on module load (client-side only)
if (typeof window !== 'undefined') {
  initializeConnection();
}

// Computed store for checking if connected
export const isGitLabConnected = computed(gitlabConnectionAtom, (connection) => !!connection.user);

// Computed store for current connection
export const gitlabConnection = computed(gitlabConnectionAtom, (connection) => connection);

// Computed store for current user
export const gitlabUser = computed(gitlabConnectionAtom, (connection) => connection.user);

// Computed store for current stats
export const gitlabStats = computed(gitlabConnectionAtom, (connection) => connection.stats);

// Computed store for current URL
export const gitlabUrl = computed(gitlabUrlAtom, (url) => url);

class GitLabConnectionStore {
  async connect(token: string, gitlabUrl = 'https://gitlab.com') {
    try {
      const apiService = new GitLabApiService(token, gitlabUrl);

      // Test connection by fetching user
      const user = await apiService.getUser();

      // Update state
      gitlabConnectionAtom.set({
        user,
        token,
        tokenType: 'personal-access-token',
        gitlabUrl,
      });

      // Set cookies for client-side access
      Cookies.set('gitlabUsername', user.username);
      Cookies.set('gitlabToken', token);
      Cookies.set('git:gitlab.com', JSON.stringify({ username: user.username, password: token }));
      Cookies.set('gitlabUrl', gitlabUrl);

      // Store connection details in localStorage
      localStorage.setItem(
        'gitlab_connection',
        JSON.stringify({
          user,
          token,
          tokenType: 'personal-access-token',
          gitlabUrl,
        }),
      );

      logStore.logInfo('Connected to GitLab', {
        type: 'system',
        message: `Connected to GitLab as ${user.username}`,
      });

      return { success: true };
    } catch (error) {
      console.error('Failed to connect to GitLab:', error);

      logStore.logError(`GitLab authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`, {
        type: 'system',
        message: 'GitLab authentication failed',
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async fetchStats(_forceRefresh = false) {
    const connection = gitlabConnectionAtom.get();

    if (!connection.user || !connection.token) {
      throw new Error('Not connected to GitLab');
    }

    try {
      const apiService = new GitLabApiService(connection.token, connection.gitlabUrl || 'https://gitlab.com');

      // Fetch user data
      const userData = await apiService.getUser();

      // Fetch projects
      const projects = await apiService.getProjects();

      // Fetch events
      const events = await apiService.getEvents();

      // Fetch groups
      const groups = await apiService.getGroups();

      // Fetch snippets
      const snippets = await apiService.getSnippets();

      // Calculate stats
      const stats: GitLabStats = calculateStatsSummary(projects, events, groups, snippets, userData);

      // Update connection with stats
      gitlabConnectionAtom.set({
        ...connection,
        stats,
      });

      // Update localStorage
      const updatedConnection = { ...connection, stats };
      localStorage.setItem('gitlab_connection', JSON.stringify(updatedConnection));

      return { success: true, stats };
    } catch (error) {
      console.error('Error fetching GitLab stats:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  disconnect() {
    // Remove cookies
    Cookies.remove('gitlabToken');
    Cookies.remove('gitlabUsername');
    Cookies.remove('git:gitlab.com');
    Cookies.remove('gitlabUrl');

    // Clear localStorage
    localStorage.removeItem('gitlab_connection');

    // Reset state
    gitlabConnectionAtom.set({
      user: null,
      token: '',
      tokenType: 'personal-access-token',
    });

    logStore.logInfo('Disconnected from GitLab', {
      type: 'system',
      message: 'Disconnected from GitLab',
    });
  }

  loadSavedConnection() {
    try {
      const savedConnection = localStorage.getItem('gitlab_connection');

      if (savedConnection) {
        const parsed = JSON.parse(savedConnection);
        parsed.tokenType = 'personal-access-token';

        // Set GitLab URL if saved
        if (parsed.gitlabUrl) {
          gitlabUrlAtom.set(parsed.gitlabUrl);
        }

        // Set connection
        gitlabConnectionAtom.set(parsed);

        return parsed;
      }
    } catch (error) {
      console.error('Error parsing saved GitLab connection:', error);
      localStorage.removeItem('gitlab_connection');
    }

    return null;
  }

  setGitLabUrl(url: string) {
    gitlabUrlAtom.set(url);
  }

  setToken(token: string) {
    gitlabConnectionAtom.set({
      ...gitlabConnectionAtom.get(),
      token,
    });
  }

  /**
   * bolt.diy auto-connected to GitLab using a personal access token baked into
   * the build (`VITE_GITLAB_ACCESS_TOKEN`), which suited a locally-run,
   * single-user app.
   *
   * Rayu Studio cannot do that: a build-time token would be compiled into the
   * client bundle and readable by every visitor. GitLab credentials live
   * encrypted in rayu-backend (`studio_connections`) and are attached
   * server-side, so there is nothing here to auto-connect with — the user
   * connects GitLab once in Studio settings instead.
   *
   * The original implementation is removed rather than left behind a
   * never-taken branch. It also logged the first 10 characters of the token to
   * the console on failure, which should not survive into a hosted product.
   */
  async autoConnect(): Promise<{ success: false; error: string }> {
    return {
      success: false,
      error: 'Connect GitLab in Studio settings — Rayu does not use a build-time token.',
    };
  }
}

export const gitlabConnectionStore = new GitLabConnectionStore();

// Export hooks for React components
export function useGitLabConnection() {
  return {
    connection: gitlabConnection,
    isConnected: isGitLabConnected,
    user: gitlabUser,
    stats: gitlabStats,
    gitlabUrl,
    connect: gitlabConnectionStore.connect.bind(gitlabConnectionStore),
    disconnect: gitlabConnectionStore.disconnect.bind(gitlabConnectionStore),
    fetchStats: gitlabConnectionStore.fetchStats.bind(gitlabConnectionStore),
    loadSavedConnection: gitlabConnectionStore.loadSavedConnection.bind(gitlabConnectionStore),
    setGitLabUrl: gitlabConnectionStore.setGitLabUrl.bind(gitlabConnectionStore),
    setToken: gitlabConnectionStore.setToken.bind(gitlabConnectionStore),
    autoConnect: gitlabConnectionStore.autoConnect.bind(gitlabConnectionStore),
  };
}
