import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioAsset } from '../audio/library';
import {
  SOUND_EFFECTS,
  SOUND_GROUP_TONE,
  SOUND_GROUPS,
  formatSoundDuration,
  peaksToPath,
  resamplePeaks,
  soundEffectSrc,
  type SoundEffect,
} from '../audio/soundLibrary';
import { Icon } from '../components/icons';
import { tData, useT } from '../i18n/locale';
import { setLibraryDrag } from './drag';
import { useFixedVirtualGrid } from '../hooks/useFixedVirtualGrid';
import { readSoundCollections, rememberSoundUse, writeSoundCollections, SOUND_COLLECTIONS_EVENT } from '../audio/soundCollections';
import { filterSoundResults, matchesSoundQuery, SOUND_FILTERS } from '../audio/soundResults';
import './sound-browser.css';

// Sound-library tab:
// search ("Search sounds") + chips [popular, …groups] + list rows:
// [group-color glyph / play] [name] [waveform] [duration] [+ add]

const WAVE_W = 100;
const WAVE_H = 32;
const WAVE_BINS = 48;

interface SoundBrowserProps {
  fps: number;
  onAdd: (asset: AudioAsset) => boolean | void;
  onAuditionStart?: () => void;
}

function matchesQuery(s: SoundEffect, q: string): boolean {
  return matchesSoundQuery(s, q, tData(s.name));
}

function toAsset(s: SoundEffect, fps: number): AudioAsset {
  return {
    id: `sfx_${s.id}`,
    name: s.name,
    category: 'sfx',
    src: soundEffectSrc(s.id),
    durationInFrames: Math.max(1, Math.round(s.seconds * fps)),
  };
}

export const SoundBrowser = memo(function SoundBrowser({ fps, onAdd, onAuditionStart }: SoundBrowserProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<string>(SOUND_FILTERS.all);
  const [collections, setCollections] = useState(readSoundCollections);
  const [auditionError, setAuditionError] = useState<string | null>(null);
  const [preferenceError, setPreferenceError] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const playingIdRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef(0);

  const stopAudition = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    audioRef.current = null;
    playingIdRef.current = null;
    setPlayingId(null);
    setProgress(0);
  }, []);

  useEffect(() => () => stopAudition(), [stopAudition]);

  useEffect(() => {
    const refresh = () => setCollections(readSoundCollections());
    window.addEventListener(SOUND_COLLECTIONS_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(SOUND_COLLECTIONS_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const tick = useCallback(() => {
    const a = audioRef.current;
    if (!a || a.paused || !a.duration) return;
    setProgress(a.currentTime / a.duration);
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const audition = useCallback((sound: SoundEffect) => {
    if (playingIdRef.current === sound.id) {
      stopAudition();
      return;
    }
    stopAudition();
    setAuditionError(null);
    onAuditionStart?.();
    const audio = new Audio(soundEffectSrc(sound.id));
    audio.preload = 'auto';
    audioRef.current = audio;
    playingIdRef.current = sound.id;
    setPlayingId(sound.id);
    setProgress(0);
    audio.onended = () => { if (audioRef.current === audio) stopAudition(); };
    const fail = () => {
      if (audioRef.current !== audio) return;
      stopAudition();
      setAuditionError(t('无法试听「{name}」，请检查本地音效文件。', { name: tData(sound.name) }));
    };
    audio.onerror = fail;
    void audio.play().then(() => {
      if (audioRef.current === audio) rafRef.current = requestAnimationFrame(tick);
    }).catch(fail);
  }, [stopAudition, tick, onAuditionStart, t]);

  const list = useMemo(() => {
    const q = query.trim();
    const matches = SOUND_EFFECTS.filter((s) => matchesQuery(s, q));
    return filterSoundResults(matches, chip, collections);
  }, [chip, query, collections, t]);

  const pinnedIndexes = useMemo(() => {
    const pinnedIds = new Set([playingId, focusedId, draggedId].filter((id): id is string => id != null));
    const indexes: number[] = [];
    list.forEach((sound, index) => {
      if (pinnedIds.has(sound.id)) indexes.push(index);
    });
    return indexes;
  }, [draggedId, focusedId, list, playingId]);
  const virtualList = useFixedVirtualGrid({
    itemCount: list.length,
    cardWidth: 1,
    rowHeight: 64,
    rowGap: 4,
    overscanRows: 2,
    fixedColumnCount: 1,
    pinnedIndexes,
  });
  const addSound = useCallback((sound: SoundEffect) => {
    stopAudition();
    if (onAdd(toAsset(sound, fps)) !== false) {
      rememberSoundUse(sound.id);
      setCollections(readSoundCollections());
    }
  }, [fps, onAdd, stopAudition]);
  const toggleFavorite = useCallback((sound: SoundEffect) => {
    const latest = readSoundCollections();
    const next = { ...latest, favorites: latest.favorites.includes(sound.id)
      ? latest.favorites.filter((id) => id !== sound.id) : [...latest.favorites, sound.id] };
    setCollections(next);
    setPreferenceError(!writeSoundCollections(next));
  }, []);

  return (
    <div className="cc-sound-browser">
      <label className="cc-sound-search" htmlFor="cc-sound-library-search">
        <Icon name="search" size={13} />
        <input
          id="cc-sound-library-search"
          type="search"
          placeholder={t('搜索音效')}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setChip(SOUND_FILTERS.all); }}
          autoComplete="off"
          spellCheck={false}
        />
        {query ? (
          <button type="button" className="cc-sound-search-clear" onClick={() => setQuery('')} aria-label={t('清除')}>
            <Icon name="x" size={12} />
          </button>
        ) : null}
      </label>

      <div className="cc-sound-chips" role="tablist" aria-label={t('音效分组')}>
        {([
          [SOUND_FILTERS.all, '全部'], [SOUND_FILTERS.popular, '热门'],
          [SOUND_FILTERS.favorites, '收藏'], [SOUND_FILTERS.recent, '最近使用'],
        ] as const).map(([id, label]) => <button
          key={id}
          type="button"
          role="tab"
          aria-selected={chip === id}
          className={`cc-sound-chip${chip === id ? ' selected' : ''}`}
          onClick={() => setChip(id)}
        >
          {t(label)}
        </button>)}
        {SOUND_GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            role="tab"
            aria-selected={chip === g.id}
            className={`cc-sound-chip${chip === g.id ? ' selected' : ''}`}
            onClick={() => setChip(g.id)}
          >
            {t(g.name)}
          </button>
        ))}
      </div>

      {auditionError && <div className="cc-sound-feedback" role="alert">{auditionError}</div>}
      {preferenceError && <div className="cc-sound-feedback" role="status">{t('收藏仅在本次打开时保留，无法保存到本机。')}</div>}

      {list.length === 0 ? (
        <div className="cc-sound-empty">{query ? t('没有找到「{query}」相关音效', { query })
          : chip === SOUND_FILTERS.favorites ? t('还没有收藏音效，点击音效旁的星标即可收藏。')
            : chip === SOUND_FILTERS.recent ? t('添加音效后，会在这里显示最近使用。') : t('此分类下暂无音效')}</div>
      ) : (
        <div
          ref={virtualList.containerRef}
          className="cc-sound-list"
          role="listbox"
          aria-label={t('音效列表')}
          style={{ height: virtualList.totalHeight }}
        >
          {virtualList.rows.map((row) => {
            const sound = list[row.startIndex];
            if (!sound) return null;
            return (
              <div
                key={sound.id}
                style={{
                  position: 'absolute',
                  top: row.top,
                  left: 0,
                  width: '100%',
                  height: virtualList.rowHeight,
                }}
              >
                <SoundRow
                  sound={sound}
                  playing={playingId === sound.id}
                  progress={playingId === sound.id ? progress : 0}
                  onAudition={audition}
                  onAdd={addSound}
                  favorite={collections.favorites.includes(sound.id)}
                  onToggleFavorite={toggleFavorite}
                  onStopAudition={stopAudition}
                  onFocusChange={setFocusedId}
                  onDragChange={setDraggedId}
                />
              </div>
            );
          })}
        </div>
      )}

      <div className="cc-sound-hint">{t('点「试听」预听；点「添加」放到播放头；拖到音轨上可指定位置 · 共 {n} 个音效', { n: list.length })}</div>
    </div>
  );
});

interface SoundRowProps {
  sound: SoundEffect;
  playing: boolean;
  progress: number;
  onAudition: (sound: SoundEffect) => void;
  onAdd: (sound: SoundEffect) => void;
  favorite: boolean;
  onToggleFavorite: (sound: SoundEffect) => void;
  onStopAudition: () => void;
  onFocusChange: (id: string | null) => void;
  onDragChange: (id: string | null) => void;
}

const SoundRow = memo(function SoundRow({
  sound,
  playing,
  progress,
  onAudition,
  onAdd,
  favorite,
  onToggleFavorite,
  onStopAudition,
  onFocusChange,
  onDragChange,
}: SoundRowProps) {
  const t = useT();
  const displayName = tData(sound.name);
  const tone = SOUND_GROUP_TONE[sound.group] ?? SOUND_GROUP_TONE['ui-motion-feedback']!;
  const path = useMemo(
    () => peaksToPath(resamplePeaks(sound.peaks, WAVE_BINS), WAVE_W, WAVE_H),
    [sound.peaks],
  );
  const clipId = `cc-sfx-clip-${sound.id}`;
  return (
    <div
      role="option"
      aria-selected={playing}
      className={`cc-sound-row${playing ? ' active' : ''}`}
      title={t('{desc} · 可拖到时间线音轨', { desc: sound.desc })}
      draggable
      onDragStart={(event) => {
        onStopAudition();
        onDragChange(sound.id);
        setLibraryDrag(event, {
          kind: 'sound',
          id: sound.id,
          name: sound.name,
          src: soundEffectSrc(sound.id),
          seconds: sound.seconds,
        });
      }}
      onDragEnd={() => onDragChange(null)}
      onFocusCapture={() => onFocusChange(sound.id)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onFocusChange(null);
      }}
      onClick={() => onAudition(sound)}
      onDoubleClick={() => onAdd(sound)}
    >
      <button
        type="button"
        className="cc-sound-glyph"
        style={{ backgroundColor: tone.bg, color: tone.ink }}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onAudition(sound);
        }}
        aria-label={playing ? t('暂停 {name}', { name: displayName }) : t('试听 {name}', { name: displayName })}
      >
        <Icon name={playing ? 'pause' : 'play'} size={12} />
      </button>
      <div className="cc-sound-meta">
        <div className="cc-sound-name">{displayName}</div>
      </div>
      <div className="cc-sound-wave" aria-hidden>
        <svg viewBox={`0 0 ${WAVE_W} ${WAVE_H}`} preserveAspectRatio="none">
          <path d={path} className="cc-sound-wave-base" />
          <clipPath id={clipId}>
            <rect x={0} y={0} width={progress * WAVE_W} height={WAVE_H} />
          </clipPath>
          <path d={path} className="cc-sound-wave-prog" clipPath={`url(#${clipId})`} style={{ fill: tone.glyph }} />
        </svg>
      </div>
      <span className="cc-sound-dur">{formatSoundDuration(sound.seconds)}</span>
      <button
        type="button"
        className={`cc-sound-favorite${favorite ? ' selected' : ''}`}
        title={t(favorite ? '取消收藏：{name}' : '收藏：{name}', { name: displayName })}
        aria-label={t(favorite ? '取消收藏：{name}' : '收藏：{name}', { name: displayName })}
        aria-pressed={favorite}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); onToggleFavorite(sound); }}
      >
        <Icon name="star" size={18} />
      </button>
      <button
        type="button"
        className="cc-sound-add"
        title={t('添加到时间线播放头：{name}', { name: displayName })}
        aria-label={t('添加 {name}', { name: displayName })}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onAdd(sound);
        }}
      >
        <Icon name="plus" size={14} /><span>{t('添加')}</span>
      </button>
    </div>
  );
});
