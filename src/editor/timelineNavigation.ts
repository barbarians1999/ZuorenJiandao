import type { ProjectDoc } from './types';

type NavigationDoc = Pick<ProjectDoc, 'timelines' | 'activeTimelineId'>;

function references(doc: NavigationDoc, parentId: string, childId: string): boolean {
  return doc.timelines.some((timeline) => timeline.id === parentId
    && timeline.items.some((item) => item.kind === 'sequence' && item.timelineId === childId));
}

/** Session navigation only: an actual parent edge is required for every breadcrumb. */
export function timelineNavigationPath(doc: NavigationDoc, previousPath: readonly string[]): string[] {
  const available = new Set(doc.timelines.filter((timeline) => !timeline.hidden).map((timeline) => timeline.id));
  const active = doc.activeTimelineId;
  if (!available.has(active)) return [];
  const previous: string[] = [];
  for (const id of previousPath) {
    if (!available.has(id) || previous.includes(id)
      || (previous.length && !references(doc, previous[previous.length - 1]!, id))) break;
    previous.push(id);
  }
  const alreadyVisited = previous.indexOf(active);
  if (alreadyVisited >= 0) return previous.slice(0, alreadyVisited + 1);
  if (previous.length && references(doc, previous[previous.length - 1]!, active)) return [...previous, active];

  // If the user opened a child directly, infer only an unambiguous parent.
  // A child shared by multiple drafts must not pretend one arbitrary draft owns it.
  const path = [active];
  for (;;) {
    const parents = doc.timelines.filter((timeline) => available.has(timeline.id)
      && references(doc, timeline.id, path[0]!));
    if (parents.length !== 1 || path.includes(parents[0]!.id)) return path;
    path.unshift(parents[0]!.id);
  }
}

export function hasSharedNestedDrafts(doc: NavigationDoc, timelineId: string): boolean {
  return doc.timelines.some((timeline) => timeline.id === timelineId
    && timeline.items.some((item) => item.kind === 'sequence'));
}
