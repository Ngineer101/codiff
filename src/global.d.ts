import type {
  CodiffPreferences,
  DiffSection,
  DiffSectionContentRequest,
  GitIdentity,
  RepositoryHistory,
  RepositoryState,
  ReviewSource,
} from './types.ts';

declare global {
  interface Window {
    codiff: {
      getDiffSectionContent: (request: DiffSectionContentRequest) => Promise<DiffSection>;
      getGitIdentity: () => Promise<GitIdentity>;
      getPreferences: () => Promise<CodiffPreferences>;
      getRepositoryHistory: (limit?: number) => Promise<RepositoryHistory>;
      getRepositoryState: (source?: ReviewSource) => Promise<RepositoryState>;
      onFindInDiffs: (callback: () => void) => () => void;
      onPreferencesChanged: (callback: (preferences: CodiffPreferences) => void) => () => void;
      onRepositoryChanged: (callback: (change: { root: string }) => void) => () => void;
      showInFolder: (path: string) => Promise<void>;
    };
  }
}
