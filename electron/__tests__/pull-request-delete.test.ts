import { expect, test } from 'vite-plus/test';
import { parseGitHubCommentDatabaseId } from '../git-state/pull-request.cjs';

test('parseGitHubCommentDatabaseId extracts numeric GitHub review comment ids', () => {
  expect(parseGitHubCommentDatabaseId('github:123456')).toBe('123456');
  expect(parseGitHubCommentDatabaseId('draft')).toBeNull();
  expect(parseGitHubCommentDatabaseId('github:not-a-number')).toBeNull();
});
