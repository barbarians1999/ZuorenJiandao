// Isolated benchmark page: normal App routing/persistence/editor, not a Player-only host.
import { createProject, docFromTimeline } from '../src/persist/projectStore';

if (!import.meta.env.DEV || !new URLSearchParams(location.search).has('long-video-benchmark')) {
  throw new Error('Full editor benchmark requires explicit DEV opt-in');
}
localStorage.setItem('cc.locale', 'zh');
if (!location.hash.startsWith('#/editor/')) {
  const meta = await createProject('Long video benchmark (isolated)', docFromTimeline({
    fps: 30, width: 1920, height: 1080, selectedId: null, items: [],
  }));
  location.hash = `#/editor/${meta.id}`;
}
await import('../src/main');
