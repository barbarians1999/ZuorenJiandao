import { useEffect } from 'react';
import { computeTooltipPosition } from './tooltipPosition';

type PopoverHostElement = HTMLDivElement & {
  showPopover?: () => void;
  hidePopover?: () => void;
};

function isPopoverOpen(el: Element): boolean {
  try {
    return el.matches(':popover-open');
  } catch {
    return false;
  }
}

function shouldSuppressTooltip(trigger: HTMLElement): boolean {
  if (!trigger.isConnected) return true;
  if (!trigger.getAttribute('data-tip')?.trim()) return true;
  if (trigger.closest('.cc-utilities-popover')) return true;
  if (trigger.getAttribute('aria-expanded') === 'true') return true;
  if (trigger.tagName === 'SUMMARY' && trigger.closest('details')?.hasAttribute('open')) return true;

  const popoverAnchor = trigger.closest('.cc-popover-anchor');
  if (popoverAnchor) {
    try {
      if (popoverAnchor.querySelector(':popover-open')) return true;
    } catch {
      // Ignore selector errors on older runtimes without :popover-open support.
    }
  }

  const rect = trigger.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0;
}

function pointInRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function findDisabledTipUnderPoint(
  container: Element,
  clientX: number,
  clientY: number,
  depth = 0,
): HTMLElement | null {
  if (depth > 2) return null;
  const children = container.children;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i]!;
    if (child.matches('.cc-tip[data-tip]:disabled')) {
      if (pointInRect(clientX, clientY, child.getBoundingClientRect())) {
        return child as HTMLElement;
      }
    } else if (child.tagName === 'SPAN' && child.children.length <= 4) {
      const nested = findDisabledTipUnderPoint(child, clientX, clientY, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function resolveTipTrigger(
  target: EventTarget | null,
  clientX: number,
  clientY: number,
): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const direct = target.closest<HTMLElement>('.cc-tip[data-tip]');
  if (direct) return direct;
  return findDisabledTipUnderPoint(target, clientX, clientY);
}

function getMountHost(): HTMLElement {
  if (document.fullscreenElement instanceof HTMLElement) {
    return document.fullscreenElement;
  }
  return document.body;
}

/**
 * Global Top-Layer tooltip host for `.cc-tip[data-tip]` triggers.
 * Uses `popover="hint"` (with fixed-position fallback) so tooltips never get clipped
 * by `overflow: hidden`, `container-type`, or lower panel stacking contexts.
 */
export function TooltipHost() {
  useEffect(() => {
    const el = document.createElement('div') as PopoverHostElement;
    el.className = 'cc-tooltip-layer';
    el.setAttribute('role', 'tooltip');
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('popover', 'hint');
    el.dataset.open = 'false';

    getMountHost().appendChild(el);
    document.documentElement.dataset.ccTooltipHost = 'ready';

    let activeTrigger: HTMLElement | null = null;
    let triggerObserver: MutationObserver | null = null;

    const disconnectObserver = () => {
      if (triggerObserver) {
        triggerObserver.disconnect();
        triggerObserver = null;
      }
    };

    const hideTooltip = () => {
      disconnectObserver();
      activeTrigger = null;
      el.dataset.open = 'false';
      el.style.visibility = '';
      if (typeof el.hidePopover === 'function' && isPopoverOpen(el)) {
        try {
          el.hidePopover();
        } catch {
          // Ignore errors when popover is already closed or detached.
        }
      }
    };

    const positionAndReveal = (trigger: HTMLElement) => {
      if (shouldSuppressTooltip(trigger)) {
        hideTooltip();
        return;
      }

      const host = getMountHost();
      if (el.parentElement !== host) {
        host.appendChild(el);
      }

      const copy = trigger.getAttribute('data-tip')!.trim();
      el.textContent = copy;
      el.dataset.scope = trigger.closest('.cc-editor-shell') ? 'editor' : 'default';
      el.style.visibility = 'hidden';
      el.style.left = '0px';
      el.style.top = '0px';
      el.dataset.open = 'true';

      if (typeof el.showPopover === 'function' && !isPopoverOpen(el)) {
        try {
          el.showPopover();
        } catch {
          // Fallback to fixed positioning + max z-index when showPopover fails.
        }
      }

      const tipRect = el.getBoundingClientRect();
      const anchorRect = trigger.getBoundingClientRect();
      const { left, top, placement } = computeTooltipPosition({
        anchor: anchorRect,
        tooltip: { width: tipRect.width, height: tipRect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        preferredPlacement: trigger.classList.contains('cc-tip-up') ? 'top' : 'bottom',
        preferredAlign: trigger.classList.contains('cc-tip-r') ? 'end' : 'start',
      });

      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.dataset.placement = placement;
      el.style.visibility = 'visible';
    };

    const showTooltip = (trigger: HTMLElement) => {
      if (activeTrigger === trigger && el.dataset.open === 'true') {
        return;
      }
      if (shouldSuppressTooltip(trigger)) {
        hideTooltip();
        return;
      }

      if (activeTrigger !== trigger) {
        disconnectObserver();
        activeTrigger = trigger;
        triggerObserver = new MutationObserver(() => {
          if (!activeTrigger) return;
          positionAndReveal(activeTrigger);
        });
        triggerObserver.observe(trigger, {
          attributes: true,
          attributeFilter: ['data-tip', 'aria-expanded', 'disabled', 'class'],
        });
      }

      positionAndReveal(trigger);
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const trigger = resolveTipTrigger(event.target, event.clientX, event.clientY);
      if (trigger) {
        showTooltip(trigger);
      } else if (activeTrigger) {
        hideTooltip();
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || !(event.target instanceof Element)) return;
      if (activeTrigger && activeTrigger.contains(event.target)) {
        return;
      }
      const trigger = resolveTipTrigger(event.target, event.clientX, event.clientY);
      if (trigger) {
        showTooltip(trigger);
      } else if (activeTrigger) {
        hideTooltip();
      }
    };

    const onPointerOut = (event: PointerEvent) => {
      if (!activeTrigger) return;
      const related = event.relatedTarget;
      if (related instanceof Node && activeTrigger.contains(related)) {
        return;
      }
      const nextTrigger = resolveTipTrigger(related, event.clientX, event.clientY);
      if (nextTrigger) {
        showTooltip(nextTrigger);
      } else {
        hideTooltip();
      }
    };

    const onPointerDown = () => {
      hideTooltip();
    };

    const onFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      const trigger = event.target.closest<HTMLElement>('.cc-tip[data-tip]');
      if (!trigger) return;
      let focusVisible = false;
      try {
        focusVisible = trigger.matches(':focus-visible');
      } catch {
        focusVisible = true;
      }
      if (focusVisible) {
        showTooltip(trigger);
      }
    };

    const onFocusOut = (event: FocusEvent) => {
      if (!activeTrigger) return;
      if (event.relatedTarget instanceof Node && activeTrigger.contains(event.relatedTarget)) {
        return;
      }
      hideTooltip();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && activeTrigger) {
        hideTooltip();
      }
    };

    const onScroll = () => {
      if (activeTrigger) hideTooltip();
    };

    const onResize = () => {
      if (!activeTrigger) return;
      if (activeTrigger.isConnected) {
        positionAndReveal(activeTrigger);
      } else {
        hideTooltip();
      }
    };

    const onHide = () => {
      hideTooltip();
    };

    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerout', onPointerOut);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerleave', onHide);
    document.addEventListener('fullscreenchange', onHide);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onHide);

    return () => {
      document.removeEventListener('pointerover', onPointerOver);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerout', onPointerOut);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerleave', onHide);
      document.removeEventListener('fullscreenchange', onHide);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onHide);
      hideTooltip();
      el.remove();
      delete document.documentElement.dataset.ccTooltipHost;
    };
  }, []);

  return null;
}
