import { EmptyState, PageHeader } from '@linck/ui';
import { useWords } from '../i18n/words.js';
import { shellWords } from '../shell/words.js';

/**
 * A screen this person may not open. It says so in plain words and tells them
 * who can fix it. The missing permission is kept on hover for the admin who
 * gets the call — a permission key means nothing to the person reading it.
 */
export function Forbidden({ permission, role }: { permission: string; role: string }) {
  const t = useWords(shellWords);
  return (
    <div title={`${role} · ${permission}`}>
      <PageHeader eyebrow={t.noAccessEyebrow} title={t.noAccess} />
      <EmptyState fact={t.askAdmin} />
    </div>
  );
}
