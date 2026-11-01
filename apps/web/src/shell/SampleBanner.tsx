import { useWords } from '../i18n/words.js';
import { connectionOf } from './connected.js';
import { shellWords } from './words.js';

/**
 * The top of a live screen that is not on the API yet: it says, plainly, that
 * what follows is sample data. The hatch is the design's mark for "asserted
 * but not yet true" (packages/tokens LAW 3), which is exactly what a sample
 * figure on a real company's screen is.
 */
export function SampleBanner({ route }: { route: string }) {
  const t = useWords(shellWords).sample;
  const connection = connectionOf(route);
  if (connection === 'api') return null;
  const [lead, rest] = connection === 'bills' ? [t.exceptBills, t.restNotConnected] : [t.lead, t.notConnected];
  return (
    <div
      role="note"
      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-6 py-2.5 text-[14px] leading-snug"
      style={{
        backgroundImage: 'var(--hatch-pattern)',
        borderBottom: '1px dashed var(--provisional-rule)',
        color: 'var(--text-primary)',
      }}
    >
      <strong className="font-medium">{lead}</strong>
      <span style={{ color: 'var(--text-secondary)' }}>{rest}</span>
    </div>
  );
}
