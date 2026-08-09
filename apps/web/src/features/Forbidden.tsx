import { EmptyState, PageHeader } from '@linck/ui';

/**
 * A permission the user nearly has renders as an explanation, not a blank.
 * Invisible permissions generate support calls; naming the role that grants
 * the screen turns a dead end into a one-line request to their team admin.
 */
export function Forbidden({ permission, role }: { permission: string; role: string }) {
  return (
    <>
      <PageHeader eyebrow="Access" title="You cannot open this screen" />
      <EmptyState
        fact={`${role} does not hold ${permission}.`}
        because="Your team admin can grant it for the sites you work on. Until then the screen stays closed rather than showing you an empty one."
      />
    </>
  );
}
