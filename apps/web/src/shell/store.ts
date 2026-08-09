import type { Density } from '@linck/tokens';
import { create } from 'zustand';
import { personaByKey, type Persona } from '../auth/personas.js';
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
 * screens keep working untouched; the demo control in AppShell is the only
 * writer today.
 */

interface AppState {
  persona: Persona;
  siteScope: string | null;
  /** Modules this TENANT has switched on. Not a permission — see nav-manifest. */
  enabledModules: string[];
  density: Density;
  theme: 'light' | 'dark';
  navCollapsed: boolean;
  setPersona: (key: string) => void;
  setSiteScope: (siteId: string | null) => void;
  setEnabledModules: (modules: string[]) => void;
  setDensity: (density: Density) => void;
  toggleTheme: () => void;
  toggleNav: () => void;
}

const initial = personaByKey('executive');

export const useApp = create<AppState>((set) => ({
  persona: initial,
  siteScope: initial.defaultSiteId,
  enabledModules: [...MODULES],
  density: 'default',
  theme: 'light',
  navCollapsed: false,
  setPersona: (key) => {
    const persona = personaByKey(key);
    set({ persona, siteScope: persona.defaultSiteId });
  },
  setSiteScope: (siteId) => set({ siteScope: siteId }),
  setEnabledModules: (modules) => set({ enabledModules: modules }),
  setDensity: (density) => set({ density }),
  toggleTheme: () =>
    set((s) => {
      const theme = s.theme === 'light' ? 'dark' : 'light';
      document.documentElement.classList.toggle('dark', theme === 'dark');
      return { theme };
    }),
  toggleNav: () => set((s) => ({ navCollapsed: !s.navCollapsed })),
}));
