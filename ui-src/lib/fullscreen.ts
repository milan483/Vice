import {IS_NATIVE, nativeLog} from './env';

type NativeFullscreenAPI = {
  set_player_fullscreen: (enabled: boolean) => Promise<boolean>;
  get_player_fullscreen: () => Promise<boolean>;
};

let active = false;
let revision = 0;
let nativeRequests: Promise<void> = Promise.resolve();
const listeners = new Set<(enabled: boolean) => void>();
let stopWatching: (() => void) | undefined;

function publish(enabled: boolean): void {
  if (active === enabled) return;
  active = enabled;
  for (const listener of listeners) listener(enabled);
}

function bridge(): Partial<NativeFullscreenAPI> | undefined {
  return (window as unknown as {pywebview?: {api?: Partial<NativeFullscreenAPI>}}).pywebview?.api;
}

function hasFullscreenAPI(
  api: Partial<NativeFullscreenAPI> | undefined,
): api is NativeFullscreenAPI {
  return (
    typeof api?.set_player_fullscreen === 'function' &&
    typeof api?.get_player_fullscreen === 'function'
  );
}

async function readyBridge(): Promise<NativeFullscreenAPI> {
  const api = bridge();
  if (hasFullscreenAPI(api)) return api;
  await new Promise<void>((resolve, reject) => {
    const ready = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(() => {
      window.removeEventListener('pywebviewready', ready);
      reject(new Error('The native fullscreen bridge is unavailable'));
    }, 5000);
    window.addEventListener('pywebviewready', ready, {once: true});
  });
  const connected = bridge();
  if (!hasFullscreenAPI(connected)) {
    throw new Error('The native fullscreen bridge is unavailable');
  }
  return connected;
}

export function getPlayerFullscreen(): boolean {
  return IS_NATIVE ? active : document.fullscreenElement !== null;
}

/** Native pywebview has no DOM fullscreenchange event, so read the actual
 * window state while a player is mounted, including window-manager exits. */
export function subscribePlayerFullscreen(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener);
  if (!stopWatching) {
    if (IS_NATIVE) {
      let stopped = false;
      let timer: number | undefined;
      const poll = async () => {
        const startedAt = revision;
        try {
          const api = await readyBridge();
          const enabled = await api.get_player_fullscreen();
          if (!stopped && startedAt === revision) publish(enabled);
        } catch (error) {
          if (!stopped) nativeLog(`Fullscreen state: ${String(error)}`);
        } finally {
          if (!stopped) timer = window.setTimeout(poll, 300);
        }
      };
      void poll();
      stopWatching = () => {
        stopped = true;
        clearTimeout(timer);
      };
    } else {
      const changed = () => publish(document.fullscreenElement !== null);
      document.addEventListener('fullscreenchange', changed);
      changed();
      stopWatching = () => document.removeEventListener('fullscreenchange', changed);
    }
  }
  listener(getPlayerFullscreen());
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stopWatching?.();
      stopWatching = undefined;
    }
  };
}

/** Resolves only after the platform accepts the requested state. Failures are
 * reported to the caller so the viewer can retain its controls and show them. */
export function requestPlayerFullscreen(element: HTMLElement, enabled: boolean): Promise<void> {
  if (IS_NATIVE) {
    ++revision;
    const request = nativeRequests
      .then(async () => {
        const api = await readyBridge();
        const actual = await api.set_player_fullscreen(enabled);
        if (actual !== enabled) throw new Error('The native window rejected fullscreen');
        publish(actual);
      })
      .finally(() => {
        ++revision;
      });
    nativeRequests = request.catch(() => {});
    return request;
  }
  // Invoke requestFullscreen directly in the click/key handler to preserve the
  // browser's transient user activation; never put this behind a promise queue.
  try {
    if (enabled) {
      if (document.fullscreenElement === element) return Promise.resolve();
      if (!element.requestFullscreen) throw new Error('Fullscreen is unavailable in this browser');
      return element.requestFullscreen().then(() => publish(document.fullscreenElement !== null));
    }
    if (!document.fullscreenElement) {
      publish(false);
      return Promise.resolve();
    }
    return document.exitFullscreen().then(() => publish(document.fullscreenElement !== null));
  } catch (error) {
    return Promise.reject(error);
  }
}
