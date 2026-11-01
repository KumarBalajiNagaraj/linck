import { RouterProvider } from '@tanstack/react-router';
import { router } from '../router.js';
import { useAuth } from './auth.js';
import { Opening, SignIn } from './SignIn.js';

/**
 * Live mode's root: the router mounts only once `GET /me/session` has said who
 * is signed in. Until then the person sees the app asking; without a session,
 * the sign-in screen. Never the shell with nobody in it.
 */
export function LiveApp() {
  const auth = useAuth();
  switch (auth.status) {
    case 'signed-in':
      return <RouterProvider router={router} />;
    case 'checking':
      return <Opening />;
    case 'unreachable':
      return <SignIn key="unreachable" problem="unreachable" />;
    case 'signed-out':
      return <SignIn key={auth.problem ?? 'none'} problem={auth.problem} />;
  }
}
