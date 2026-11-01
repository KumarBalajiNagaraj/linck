import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { router } from '../router.js';
import { queryClient } from '../shell/queryClient.js';
import { useAuth } from './auth.js';
import { Opening, SignIn } from './SignIn.js';

/**
 * Live mode's root: the router mounts only once `GET /me/session` has said who
 * is signed in. Until then the person sees the app asking; without a session,
 * the sign-in screen. Never the shell with nobody in it.
 *
 * The screens on the API read it through one TanStack Query cache
 * (shell/queryClient.ts). The demo has no server state, and no cache.
 */
export function LiveApp() {
  const auth = useAuth();
  switch (auth.status) {
    case 'signed-in':
      return (
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      );
    case 'checking':
      return <Opening />;
    case 'unreachable':
      return <SignIn key="unreachable" problem="unreachable" />;
    case 'signed-out':
      return <SignIn key={auth.problem ?? 'none'} problem={auth.problem} />;
  }
}
