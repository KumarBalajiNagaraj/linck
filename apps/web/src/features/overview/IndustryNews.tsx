import { useEffect, useState } from 'react';
import { formatDate, formatDateTime, formatTime } from '@linck/domain';
import { AsOfStamp, Button, EmptyState, Note, PageHeader, Rail, StatusStamp } from '@linck/ui';
import { useLang, type Lang } from '../../i18n/lang.js';
import { useWords } from '../../i18n/words.js';
import {
  fetchIndustryNews,
  NewsUnavailable,
  refreshIndustryNews,
  safeLink,
  type DigestItem,
  type DigestStatus,
  type IndustryDigest,
  type IndustryNews as News,
  type NewsProblem,
} from './industryNews.js';
import { industryNewsWords, type IndustryNewsText } from './industryNewsWords.js';

/**
 * INDUSTRY NEWS (LIN-10) — what is happening in our customers' trade.
 *
 * Builders, developers and road contractors buy our M-Sand and aggregates, so
 * their news is ours: projects near Chennai, road tenders, cement and sand
 * prices, quarry rules, the monsoon. The server reads Google News and, when a
 * model is set up, has it pick up to six headlines and write one plain line
 * and one "why it matters" line about each, in English and Tamil. The screen
 * shows the line in the reader's language with the headline as printed under
 * it, so what the model wrote can always be checked against the paper.
 *
 * Lines a model wrote carry the dotted rail: machine-written, not checked by a
 * person. With no model the screen says so in one line and shows the top
 * headlines as printed. A digest over a week old says so, with Refresh; the
 * server allows one refresh an hour per company, and the button waits for it.
 *
 * "Show sample" draws a made-up digest, marked on every item as not real news,
 * whose links open an example page — so the screen can be seen without the API.
 */

type Text = IndustryNewsText;

function problemOf(err: unknown): NewsProblem {
  return err instanceof NewsUnavailable ? err.problem : { kind: 'unreachable' };
}

function problemText(problem: NewsProblem, t: Text): string {
  switch (problem.kind) {
    case 'sign-in':
      return t.problem.signIn;
    case 'not-allowed':
      return t.problem.notAllowed;
    case 'unreachable':
      return t.problem.unreachable;
    case 'status':
      return t.problem.status(problem.status);
    case 'too-soon':
      return t.problem.tooSoon(problem.nextRefreshAt ? formatTime(problem.nextRefreshAt) : null);
    case 'running':
      return t.problem.running;
    case 'no-news':
      return t.problem.noNews;
  }
}

const AI_LINE: Record<DigestStatus, (t: Text) => string> = {
  summarised: (t) => t.aiWrote,
  ai_off: (t) => t.aiOff,
  ai_failed: (t) => t.aiFailed,
};

/** The made-up digest behind "Show sample". Its links go to example.com, which holds no article. */
function sampleDigest(t: Text, now: Date): IndustryDigest {
  const { en, ta } = industryNewsWords;
  const daysAgo = [1, 2, 4, 6];
  return {
    id: 'sample',
    createdAt: now.toISOString(),
    status: 'summarised',
    model: null,
    headlinesRead: t.sample.items.length,
    items: t.sample.items.map((item, i) => ({
      title: item.title,
      source: t.sample.source,
      publishedAt: new Date(now.getTime() - (daysAgo[i] ?? 1) * 86_400_000).toISOString(),
      link: `https://example.com/linck-sample-news/${i + 1}`,
      summary: { en: en.sample.items[i]?.line ?? item.line, ta: ta.sample.items[i]?.line ?? item.line },
      why: { en: en.sample.items[i]?.why ?? item.why, ta: ta.sample.items[i]?.why ?? item.why },
    })),
  };
}

export function IndustryNews() {
  const t = useWords(industryNewsWords);
  const lang = useLang((s) => s.lang);
  const [news, setNews] = useState<News | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** Kept as what went wrong, so it is worded in whichever language is showing. */
  const [problem, setProblem] = useState<NewsProblem | null>(null);
  const [sample, setSample] = useState(false);
  const [, wake] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchIndustryNews()
      .then((got) => {
        if (alive) setNews(got);
      })
      .catch((err: unknown) => {
        if (alive) setProblem(problemOf(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Refresh comes back on its own once the hour is up.
  const nextRefreshAt = news?.nextRefreshAt ?? null;
  useEffect(() => {
    const wait = nextRefreshAt ? Date.parse(nextRefreshAt) - Date.now() : 0;
    if (!(wait > 0)) return undefined;
    const id = window.setTimeout(() => wake((n) => n + 1), Math.min(wait + 500, 2 ** 31 - 1));
    return () => window.clearTimeout(id);
  }, [nextRefreshAt]);
  const waiting = nextRefreshAt !== null && Date.parse(nextRefreshAt) > Date.now();

  const refresh = async () => {
    setSample(false);
    setProblem(null);
    setRefreshing(true);
    try {
      setNews(await refreshIndustryNews());
    } catch (err) {
      const why = problemOf(err);
      setProblem(why);
      // Too soon means someone refreshed this hour: show what they got.
      if (why.kind === 'too-soon') setNews(await fetchIndustryNews().catch(() => news));
    } finally {
      setRefreshing(false);
    }
  };

  const digest = sample ? sampleDigest(t, new Date()) : (news?.digest ?? null);
  const stale = !sample && news?.digest != null && news.stale;
  const busy = loading || refreshing;

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        meta={
          digest && !sample ? (
            <AsOfStamp
              asOf={formatDateTime(digest.createdAt)}
              source={digest.model ? `${t.source} · ${digest.model}` : t.source}
              freshness={stale ? 'stale' : 'materialised'}
            />
          ) : undefined
        }
        actions={
          <>
            <Button
              variant={stale || (!digest && !busy) ? 'primary' : 'secondary'}
              onClick={() => void refresh()}
              disabled={busy || waiting}
            >
              {t.refresh}
            </Button>
            <Button onClick={() => setSample((shown) => !shown)} disabled={refreshing}>
              {sample ? t.hideSample : t.showSample}
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-2 px-6 pt-4">
        <Note>{t.intro}</Note>
        {busy ? <Line live>{refreshing ? t.refreshing : t.loading}</Line> : null}
        {problem && !sample ? <Line tone="critical">{problemText(problem, t)}</Line> : null}
        {sample ? (
          <Line tone="strong">{t.sample.banner}</Line>
        ) : digest && !busy ? (
          <Line tone={digest.status === 'ai_failed' ? 'attention' : 'plain'}>{AI_LINE[digest.status](t)}</Line>
        ) : null}
        {stale && !busy ? <Line tone="attention">{t.stale}</Line> : null}
        {!sample && waiting && !busy && !problem && nextRefreshAt ? (
          <Line tone="quiet">{t.nextRefresh(formatTime(nextRefreshAt))}</Line>
        ) : null}
      </div>

      {digest && digest.items.length > 0 ? (
        <ul className="mt-5" style={{ borderTop: '1px solid var(--border-subtle)' }} aria-busy={refreshing}>
          {digest.items.map((item, i) => (
            <NewsItem key={`${item.link}-${i}`} item={item} sample={sample} titleLang={sample ? lang : 'en'} />
          ))}
        </ul>
      ) : busy ? null : (
        <div className="px-0 pt-2">
          {digest ? (
            <EmptyState fact={t.noneThisTime} />
          ) : problem ? (
            <EmptyState fact={t.nothingToShow} action={{ label: t.showSample, onClick: () => setSample(true) }} />
          ) : (
            <EmptyState fact={t.nothingYet} because={t.nothingYetHow} />
          )}
        </div>
      )}
      <div className="h-10" />
    </>
  );
}

function Line({
  tone = 'plain',
  live = false,
  children,
}: {
  tone?: 'plain' | 'strong' | 'quiet' | 'attention' | 'critical';
  live?: boolean;
  children: React.ReactNode;
}) {
  const color =
    tone === 'critical'
      ? 'var(--status-critical)'
      : tone === 'attention'
        ? 'var(--status-attention)'
        : tone === 'strong'
          ? 'var(--text-primary)'
          : tone === 'quiet'
            ? 'var(--text-tertiary)'
            : 'var(--text-secondary)';
  const marked = tone === 'critical' || tone === 'attention';
  return (
    <p
      className={`relative text-[14px] leading-snug ${marked ? 'pl-3' : ''} ${tone === 'strong' ? 'font-medium' : ''}`}
      style={{ color }}
      aria-live={live ? 'polite' : undefined}
    >
      {tone === 'critical' || tone === 'attention' ? <Rail status={tone} /> : null}
      {children}
    </p>
  );
}

function NewsItem({ item, sample, titleLang }: { item: DigestItem; sample: boolean; titleLang: Lang }) {
  const t = useWords(industryNewsWords);
  const lang = useLang((s) => s.lang);
  const line = item.summary?.[lang] ?? null;
  const why = item.why?.[lang] ?? null;
  const link = safeLink(item.link);
  return (
    <li className="relative px-6 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      {/* Dotted: a machine wrote these lines and no person has checked them. */}
      {line ? <Rail provenance="proposed" /> : null}
      <div className="flex max-w-[760px] flex-col gap-1.5">
        {sample ? (
          <span>
            <StatusStamp status="dormant" provisional label={t.sample.stamp} />
          </span>
        ) : null}
        <p className="text-[16px] leading-snug" style={{ color: 'var(--text-primary)' }} lang={line ? lang : titleLang}>
          {line ?? item.title}
        </p>
        {why ? (
          <p className="text-[14px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
              {t.why}
            </span>{' '}
            {why}
          </p>
        ) : null}
        {line ? (
          <p className="font-serif text-[13px] italic leading-snug" style={{ color: 'var(--text-tertiary)' }} lang={titleLang}>
            {item.title}
          </p>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            {[item.source, formatDate(item.publishedAt)].filter(Boolean).join(' · ')}
          </span>
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-11 shrink-0 items-center gap-1.5 px-3.5 text-[14px] font-medium [@media(hover:hover)]:h-[38px]"
              style={{ color: 'var(--brand)', borderRadius: 'var(--r-1)', boxShadow: 'inset 0 0 0 1px var(--brand)' }}
            >
              {t.read}
              <span aria-hidden="true">↗</span>
              <span className="sr-only">{t.newTab}</span>
            </a>
          ) : null}
        </div>
      </div>
    </li>
  );
}
