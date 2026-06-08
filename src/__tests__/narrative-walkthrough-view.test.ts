import { expect, test } from 'vite-plus/test';
import {
  buildCommitModel,
  buildGenericCommitModel,
  buildOrderView,
  collectWalkthroughSegments,
  isWalkthroughCommittable,
  resolveOrder,
  resolveSegmentFile,
} from '../lib/narrative-walkthrough.ts';
import type { ChangedFile, NarrativeWalkthrough } from '../types.ts';

const walkthrough = (): NarrativeWalkthrough => ({
  agent: 'claude',
  chapters: [
    {
      blurb: 'The bug.',
      icon: 'bug',
      id: 'bug',
      stops: [
        {
          anchors: [
            {
              added: 1,
              anchor: {
                display: 'src/App.tsx:311',
                sectionId: 'src/App.tsx:staged',
                side: 'both',
              },
              deleted: 1,
              granularity: 'line',
              id: 's1',
              path: 'src/App.tsx',
              status: 'modified',
            },
          ],
          body: 'Bug.',
          id: 'stop-1',
          importance: 'critical',
          summary: 'The current file order drives navigation.',
          title: 'Bug',
        },
      ],
      title: 'The bug',
    },
    {
      blurb: 'The proof.',
      icon: 'flask',
      id: 'proof',
      stops: [
        {
          anchors: [
            {
              added: 14,
              anchor: { display: 'test.ts (new)' },
              deleted: 0,
              granularity: 'file',
              id: 's2',
              path: 'src/test.ts',
              status: 'added',
            },
          ],
          body: 'Test.',
          id: 'stop-2',
          importance: 'normal',
          summary: 'The regression test locks the navigation order.',
          title: 'Proof',
        },
      ],
      title: 'Proof',
    },
  ],
  focus: 'Focus.',
  generatedAt: '2026-06-05T00:00:00.000Z',
  kind: 'narrative',
  repo: { branch: 'main', root: '/repo' },
  source: { type: 'working-tree' },
  support: [
    {
      files: [
        {
          added: 312,
          anchor: { display: 'pnpm-lock.yaml' },
          deleted: 180,
          granularity: 'file',
          id: 'lock',
          path: 'pnpm-lock.yaml',
          status: 'modified',
        },
      ],
      id: 'lockfiles',
      note: 'Regenerated.',
      title: 'Lockfile',
    },
    {
      files: [
        {
          added: 5,
          anchor: { display: 'mirror.ts' },
          deleted: 0,
          granularity: 'file',
          id: 'mirror',
          path: 'mirror.ts',
          status: 'added',
        },
      ],
      id: 'mechanical',
      note: 'Mirror.',
      title: 'Mechanical',
    },
  ],
  title: 'Title',
  version: 3,
});

test('resolveOrder builds the UI adapter order', () => {
  const order = resolveOrder(walkthrough(), 'anything')!;

  expect(order.id).toBe('walkthrough');
  expect(order.phases.map((phase) => phase.id)).toEqual(['bug', 'proof']);
  expect(order.sequence.map((stop) => stop.segmentIds)).toEqual([['s1'], ['s2']]);
  expect(order.rest.map((item) => item.segmentId)).toEqual(['lock', 'mirror']);
});

test('buildOrderView indexes stops, fills phases, and resolves anchors', () => {
  const view = buildOrderView(walkthrough(), 'keys')!;

  expect(view.sequence.map((stop) => stop.index)).toEqual([0, 1]);
  expect(view.sequence[0].segment.path).toBe('src/App.tsx');
  expect(view.phases.map((phase) => phase.stops.map((stop) => stop.segmentId))).toEqual([
    ['s1'],
    ['s2'],
  ]);
  expect(view.totals).toEqual({ added: 15, deleted: 1 });
});

test('buildOrderView keeps multiple anchors under the same stop', () => {
  const base = walkthrough();
  const wt: NarrativeWalkthrough = {
    ...base,
    chapters: [
      {
        ...base.chapters[0],
        stops: [
          {
            ...base.chapters[0].stops[0],
            anchors: [base.chapters[0].stops[0].anchors[0], base.chapters[1].stops[0].anchors[0]],
            body: 'Bug and proof belong together.',
          },
        ],
      },
    ],
    support: base.support,
  };

  const view = buildOrderView(wt, 'keys')!;

  expect(view.sequence).toHaveLength(1);
  expect(view.sequence[0].segmentId).toBe('s1');
  expect(view.sequence[0].relatedSegments.map((segment) => segment.id)).toEqual(['s2']);
  expect(view.totals).toEqual({ added: 15, deleted: 1 });
});

test('buildOrderView groups support by title and totals it', () => {
  const view = buildOrderView(walkthrough(), 'keys')!;

  expect(view.restByReason.map((group) => group.reason)).toEqual(['Lockfile', 'Mechanical']);
  expect(view.restByReason[0].files[0].segment.path).toBe('pnpm-lock.yaml');
  expect(view.restTotals).toEqual({ added: 317, deleted: 180 });
});

test('buildCommitModel collapses chapters plus support into commit groups', () => {
  const view = buildOrderView(walkthrough(), 'keys')!;
  const model = buildCommitModel(view);

  expect(model.groups.map((group) => [group.title, group.isRest])).toEqual([
    ['The bug', false],
    ['Proof', false],
    ['Support', true],
  ]);
  expect(model.groups[2].files.map((file) => file.path)).toEqual(['pnpm-lock.yaml', 'mirror.ts']);
  expect(model.files.map((file) => file.path)).toEqual([
    'src/App.tsx',
    'src/test.ts',
    'pnpm-lock.yaml',
    'mirror.ts',
  ]);
});

test('buildCommitModel carries per-file change-type tags and notes onto rows', () => {
  const base = walkthrough();
  const withTags: NarrativeWalkthrough = {
    ...base,
    chapters: base.chapters.map((chapter) => ({
      ...chapter,
      stops: chapter.stops.map((stop) => ({
        ...stop,
        anchors: stop.anchors.map((anchor) =>
          anchor.id === 's1'
            ? { ...anchor, changeType: 'fix', commitNote: 'reorder the hunks' }
            : anchor.id === 's2'
              ? { ...anchor, changeType: 'test', commitNote: 'lock the regression' }
              : anchor,
        ),
      })),
    })),
    support: base.support.map((group) => ({
      ...group,
      files: group.files.map((file) =>
        file.id === 'lock' ? { ...file, changeType: 'lockfile' } : file,
      ),
    })),
  };
  const byPath = new Map(
    buildCommitModel(buildOrderView(withTags, 'keys')!).files.map((file) => [file.path, file]),
  );

  expect(byPath.get('src/App.tsx')).toMatchObject({ changeType: 'fix', note: 'reorder the hunks' });
  expect(byPath.get('src/test.ts')).toMatchObject({
    changeType: 'test',
    note: 'lock the regression',
  });
  expect(byPath.get('pnpm-lock.yaml')?.changeType).toBe('lockfile');
});

test('buildCommitModel appends live tree files missing from the walkthrough', () => {
  const files: ReadonlyArray<ChangedFile> = [
    {
      fingerprint: 'a',
      path: 'src/App.tsx',
      sections: [
        {
          binary: false,
          id: 'src/App.tsx:staged',
          kind: 'staged',
          patch: '@@ -1 +1 @@\n-a\n+b\n',
        },
      ],
      status: 'modified',
    },
    {
      fingerprint: 'missing',
      path: 'src/missed.ts',
      sections: [
        {
          binary: false,
          id: 'src/missed.ts:staged',
          kind: 'staged',
          patch: '@@ -1,0 +1,2 @@\n+one\n+two\n',
        },
      ],
      status: 'added',
    },
  ];

  const model = buildCommitModel(buildOrderView(walkthrough(), 'keys')!, files);
  const missing = model.files.find((file) => file.path === 'src/missed.ts');

  expect(missing).toMatchObject({
    added: 2,
    deleted: 0,
    note: 'Not included in the generated walkthrough.',
  });
  expect(model.groups.at(-1)).toMatchObject({
    id: '__missing',
    title: 'Other changes',
  });
});

test('buildGenericCommitModel creates a commit group from live tree files', () => {
  const model = buildGenericCommitModel([
    {
      fingerprint: 'plain',
      path: 'src/plain.ts',
      sections: [
        {
          binary: false,
          id: 'src/plain.ts:unstaged',
          kind: 'unstaged',
          patch: [
            'diff --git a/src/plain.ts b/src/plain.ts',
            '--- a/src/plain.ts',
            '+++ b/src/plain.ts',
            '@@ -1 +1,2 @@',
            '-old',
            '+new',
            '+more',
          ].join('\n'),
        },
      ],
      status: 'modified',
    },
  ]);

  expect(model.groups).toHaveLength(1);
  expect(model.groups[0]).toMatchObject({
    id: '__changed',
    title: 'Changed files',
  });
  expect(model.files[0]).toMatchObject({
    added: 2,
    deleted: 1,
    path: 'src/plain.ts',
  });
});

test('working-tree walkthroughs are committable even without commit seed text', () => {
  const wt: NarrativeWalkthrough = {
    ...walkthrough(),
    commit: undefined,
    source: { type: 'working-tree' },
  };
  const committedReview: NarrativeWalkthrough = {
    ...walkthrough(),
    commit: {},
    source: { ref: 'HEAD', type: 'commit' },
  };

  expect(isWalkthroughCommittable(wt)).toBe(true);
  expect(isWalkthroughCommittable(committedReview)).toBe(false);
});

test('resolveSegmentFile prefers the anchor section then the first visible one', () => {
  const files: ReadonlyArray<ChangedFile> = [
    {
      fingerprint: 'a',
      path: 'src/App.tsx',
      sections: [
        {
          binary: false,
          id: 'src/App.tsx:unstaged',
          kind: 'unstaged',
          patch: '@@ -1 +1 @@\n-a\n+b\n',
        },
        { binary: false, id: 'src/App.tsx:staged', kind: 'staged', patch: '@@ -1 +1 @@\n-a\n+b\n' },
      ],
      status: 'modified',
    },
  ];
  const segments = collectWalkthroughSegments(walkthrough());
  const segment = segments.find((s) => s.id === 's1')!;

  const resolved = resolveSegmentFile(segment, files, false);
  expect(resolved?.section.id).toBe('src/App.tsx:staged');

  const missing = segments.find((s) => s.id === 's2')!;
  expect(resolveSegmentFile(missing, files, false)).toBeNull();
});
