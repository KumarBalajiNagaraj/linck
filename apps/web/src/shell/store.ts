import type { Density } from '@linck/tokens';
import { create } from 'zustand';
import { personaByKey, type Persona } from '../auth/personas.js';
import type { AppSessionState, SignedIn } from '../auth/session.js';
import { MODULES } from './nav-manifest.js';

/**
 * The small amount of genuinely global client state.
 *
 * Everything else is either server state or URL state. The rule enforced in
 * review: if it can be represented in the URL, it must be, so any ERP screen
 * state is shareable and bookmarkable.
 *
 * `siteScope` lives here because it is written into every query key — that is
 * what makes switching plant unable to leave a stale cross-site row on screen.
 *
 * `enabledModules` is tenant configuration, not user preference: it arrives on
 * `GET /me/session` from `core.organization_modules` and nothing in the UI may
 * write it in production. It is defaulted to every module so the mock-data
 * screens keep working untouched; the demo control in AppShell is its only
 * other writer.
 *
 * In live mode `applySession` is the one writer of `persona`, `siteScope`'s
 * starting value, `enabledModules` and `signedIn`, and the two demo writers
 * stop working: the server says who this is and what the tenant has.
 */

interface AppState {
  persona: Persona;
  siteScope: string | null;
  /** Modules this TENANT has switched on. Not a permission — see nav-manifest. */
  enabledModules: string[];
  density: Density;
  theme: 'light' | 'dark';
  navCollapsed: boolean;
  /** Live mode: who the API says is signed in. Null in the demo, where `persona` is a choice. */
  signedIn: SignedIn | null;
  applySession: (session: AppSessionState) => void;
  setPersona: (key: string) => void;
  setSiteScope: (siteId: string | null) => void;
  setEnabledModules: (modules: string[]) => void;
  setDensity: (density: Density) => void;
  toggleTheme: () => void;
  toggleNav: () => void;
}

const initial = personaByKey('executive');

export const useApp = create<AppState>((set, get) => ({
  persona: initial,
  siteScope: initial.defaultSiteId,
  enabledModules: [...MODULES],
  density: 'default',
  theme: 'light',
  navCollapsed: false,
  signedIn: null,
  applySession: ({ persona, siteScope, enabledModules, signedIn }) =>
    set({ persona, siteScope, enabledModules, signedIn }),
  setPersona: (key) => {
    if (get().signedIn) return;
    const persona = personaByKey(key);
    set({ persona, siteScope: persona.defaultSiteId });
  },
  setSiteScope: (siteId) => set({ siteScope: siteId }),
  setEnabledModules: (modules) => {
    if (get().signedIn) return;
    set({ enabledModules: modules });
  },
  setDensity: (density) => set({ density }),
  toggleTheme: () =>
    set((s) => {
      const theme = s.theme === 'light' ? 'dark' : 'light';
      document.documentElement.classList.toggle('dark', theme === 'dark');
      return { theme };
    }),
  toggleNav: () => set((s) => ({ navCollapsed: !s.navCollapsed })),
}));
