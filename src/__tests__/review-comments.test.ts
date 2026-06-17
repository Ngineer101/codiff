import { expect, test } from 'vite-plus/test';
import type { ReviewComment } from '../lib/app-types.ts';
import {
  canDeleteReviewComment,
  canDeleteSubmittedPullRequestComment,
  getGitHubCommentDatabaseId,
  getReviewCommentsFromState,
  getVisibleReviewComments,
} from '../lib/review-comments.ts';
import type { RepositoryState } from '../types.ts';

const createReviewComment = (overrides: Partial<ReviewComment>): ReviewComment => ({
  body: 'A comment.',
  filePath: 'src/a.ts',
  id: 'github:1',
  lineNumber: 5,
  sectionId: 'src/a.ts:pull-request:1',
  side: 'additions',
  ...overrides,
});

const createPullRequestState = (): RepositoryState => ({
  branch: null,
  files: [
    {
      fingerprint: 'fingerprint',
      path: 'src/a.ts',
      sections: [
        {
          binary: false,
          id: 'src/a.ts:pull-request:1',
          kind: 'pull-request',
          patch: '',
        },
      ],
      status: 'modified',
    },
  ],
  generatedAt: 0,
  launchPath: '/repo',
  reviewComments: [
    {
      author: { login: 'reviewer' },
      body: 'Outdated comment.',
      filePath: 'src/a.ts',
      id: 'github:1',
      isOutdated: true,
      lineNumber: 5,
      side: 'additions',
    },
    {
      author: { login: 'reviewer' },
      body: 'Current comment.',
      filePath: 'src/a.ts',
      id: 'github:2',
      lineNumber: 6,
      side: 'additions',
    },
  ],
  root: '/repo',
  source: {
    type: 'pull-request',
    url: 'https://github.com/nkzw-tech/codiff/pull/1',
  },
});

test('getReviewCommentsFromState carries the outdated flag through to review comments', () => {
  const comments = getReviewCommentsFromState(createPullRequestState());

  expect(comments).toHaveLength(2);
  expect(comments.find((comment) => comment.id === 'github:1')?.isOutdated).toBe(true);
  expect(comments.find((comment) => comment.id === 'github:2')?.isOutdated).toBeUndefined();
});

test('getVisibleReviewComments hides outdated comments unless they are shown', () => {
  const comments = [
    createReviewComment({ id: 'github:1', isOutdated: true }),
    createReviewComment({ id: 'github:2' }),
  ];

  expect(getVisibleReviewComments(comments, false).map((comment) => comment.id)).toEqual([
    'github:2',
  ]);
  expect(getVisibleReviewComments(comments, true).map((comment) => comment.id)).toEqual([
    'github:1',
    'github:2',
  ]);
});

test('getVisibleReviewComments keeps user-authored comments that are never outdated', () => {
  const comments = [createReviewComment({ id: 'draft', isReadOnly: false })];

  expect(getVisibleReviewComments(comments, false)).toHaveLength(1);
});

test('getGitHubCommentDatabaseId extracts numeric ids from github comment ids', () => {
  expect(getGitHubCommentDatabaseId('github:123')).toBe('123');
  expect(getGitHubCommentDatabaseId('draft')).toBeNull();
});

test('canDeleteSubmittedPullRequestComment matches submitted GitHub comments on pull requests', () => {
  expect(
    canDeleteSubmittedPullRequestComment(
      createReviewComment({ id: 'github:9', isReadOnly: true }),
      true,
    ),
  ).toBe(true);
  expect(
    canDeleteSubmittedPullRequestComment(
      createReviewComment({ id: 'draft', isReadOnly: false }),
      true,
    ),
  ).toBe(false);
});

test('canDeleteReviewComment allows deleting local drafts and submitted GitHub comments', () => {
  expect(
    canDeleteReviewComment(createReviewComment({ id: 'draft', isReadOnly: false }), true),
  ).toBe(true);
  expect(
    canDeleteReviewComment(createReviewComment({ id: 'github:9', isReadOnly: true }), true),
  ).toBe(true);
  expect(
    canDeleteReviewComment(createReviewComment({ id: 'github:9', isReadOnly: true }), false),
  ).toBe(false);
});
