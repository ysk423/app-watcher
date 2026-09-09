import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { GeminiQuotaError, generateText } from '../ai/gemini';
import { buildQaPrompt, SYSTEM_INSTRUCTION } from '../ai/prompts';
import { loadConfig, SETTING_KEYS } from '../config';
import {
  countByStatus,
  deleteAppCompletely,
  getApp,
  insertApp,
  listApps,
  setAppStatus,
} from '../db/apps';
import { countFailedAnalysesSince, listAnalysesForApp, listGlobalAnalyses } from '../db/analyses';
import { countErrorsSince, listErrorJobsForApp, listJobs, logJob } from '../db/jobs';
import { countQueue } from '../db/queue';
import { countReviews, listReviews } from '../db/reviews';
import {
  computeDiff,
  getLastTwoSnapshots,
  getRecentVersionChanges,
  getSnapshots,
  getWhatsNewHistory,
} from '../db/snapshots';
import { getDatabaseSizeBytes, getGeminiCallCount, getStatus, setSetting } from '../db/system';
import { analyzeApp } from '../jobs/analyze';
import { collectApp } from '../jobs/collect';
import type { Env } from '../types';
import { isoDaysAgo, isoNow, jstDate, nextRunAtJst } from '../util/time';
import { Layout } from './layout';
import { AppDetailPage } from './pages/app-detail';
import { AppListPage } from './pages/app-list';
import { DashboardPage } from './pages/dashboard';
import { DeleteConfirmPage, JobsPage, NewAppPage, QaPage, SettingsPage } from './pages/misc';

/**
 * Web UI のルーティング(仕様 12 / 27)。
 * 実装ポイント: 認証はミドルウェアとして 1 か所にまとめ、
 * ルート側にはログイン・セッション処理を持ち込まない(仕様 21.2)。
 */
export function createRouter() {
  const app = new Hono<{ Bindings: Env }>();

  // Basic 認証。認証情報は secrets から読み、コードには持たない(仕様 21.3)
  app.use('*', async (c, next) => {
    const username = c.env.BASIC_AUTH_USER;
    const password = c.env.BASIC_AUTH_PASS;
    if (!username || !password) {
      return c.text(
        'BASIC_AUTH_USER / BASIC_AUTH_PASS が未設定です。wrangler secret put で登録してください。',
        500
      );
    }
    return basicAuth({ username, password })(c, next);
  });

  // ---- ダッシュボード(仕様 27.1) ----
  app.get('/', async (c) => {
    const config = await loadConfig(c.env);
    const today = jstDate();
    const since24h = isoDaysAgo(1);

    const [counts, lastCollectAt, lastAnalyzeAt, collectErrors, analyzeErrors, storageBytes, todayQueue, geminiCalls, recentChanges] =
      await Promise.all([
        countByStatus(c.env.DB),
        getStatus(c.env.DB, 'last_collect_at'),
        getStatus(c.env.DB, 'last_analyze_at'),
        countErrorsSince(c.env.DB, 'collect', since24h),
        countFailedAnalysesSince(c.env.DB, since24h),
        getDatabaseSizeBytes(c.env.DB),
        countQueue(c.env.DB, 'collect', today),
        getGeminiCallCount(c.env.DB),
        getRecentVersionChanges(c.env.DB, 10),
      ]);

    return c.html(
      <Layout title="ダッシュボード" message={c.req.query('msg')} error={c.req.query('error')}>
        <DashboardPage
          data={{
            activeCount: counts.active,
            pausedCount: counts.paused,
            maxApps: config.maxApps,
            lastCollectAt,
            lastAnalyzeAt,
            nextRunAt: nextRunAtJst(config.collectStartMinutes),
            collectErrors,
            analyzeErrors,
            storageBytes,
            storageLimitBytes: config.d1StorageLimitBytes,
            todayQueue,
            geminiCalls,
            geminiLimit: config.geminiDailyLimit,
            recentChanges,
          }}
        />
      </Layout>
    );
  });

  // ---- アプリ一覧(仕様 27.2) ----
  app.get('/apps', async (c) => {
    const config = await loadConfig(c.env);
    const [apps, counts] = await Promise.all([listApps(c.env.DB), countByStatus(c.env.DB)]);
    return c.html(
      <Layout title="アプリ一覧" message={c.req.query('msg')} error={c.req.query('error')}>
        <AppListPage apps={apps} activeCount={counts.active} maxApps={config.maxApps} />
      </Layout>
    );
  });

  // ---- アプリ登録(仕様 27.4)。:pkg より先に定義する ----
  app.get('/apps/new', async (c) => {
    const config = await loadConfig(c.env);
    const counts = await countByStatus(c.env.DB);
    return c.html(
      <Layout title="アプリ登録" error={c.req.query('error')}>
        <NewAppPage activeCount={counts.active} maxApps={config.maxApps} />
      </Layout>
    );
  });

  app.post('/apps', async (c) => {
    const config = await loadConfig(c.env);
    const body = await c.req.parseBody();
    const packageName = normalizePackageName(String(body.package_name ?? ''));
    const collectNow = body.collect_now === '1';

    if (!packageName) {
      return c.redirect('/apps/new?error=' + encodeURIComponent('パッケージ名の形式が正しくありません'));
    }

    const counts = await countByStatus(c.env.DB);
    if (counts.active >= config.maxApps) {
      return c.redirect(
        '/apps/new?error=' + encodeURIComponent(`監視中アプリが上限(${config.maxApps} 件)に達しています`)
      );
    }

    const created = await insertApp(c.env.DB, packageName);
    if (!created) {
      return c.redirect('/apps/new?error=' + encodeURIComponent('そのパッケージ名は既に登録されています'));
    }

    let message = `${packageName} を登録しました`;
    if (collectNow) {
      // 登録直後の 1 アプリだけの取得なので、HTTP リクエスト内で完結させる(仕様 14.1)
      const result = await collectApp(c.env, config, packageName, 'manual');
      message += result.ok ? ` / 初回取得に成功しました(${result.message})` : ` / 初回取得に失敗: ${result.message}`;
    }
    return c.redirect(`/apps/${encodeURIComponent(packageName)}?msg=${encodeURIComponent(message)}`);
  });

  // ---- アプリ詳細(仕様 27.3) ----
  app.get('/apps/:pkg', async (c) => {
    const config = await loadConfig(c.env);
    const packageName = c.req.param('pkg');
    const appRow = await getApp(c.env.DB, packageName);
    if (!appRow) return c.notFound();

    const [lastTwo, snapshots, whatsNew, reviews, reviewTotal, analyses, errorJobs] = await Promise.all([
      getLastTwoSnapshots(c.env.DB, packageName),
      getSnapshots(c.env.DB, packageName, 30),
      getWhatsNewHistory(c.env.DB, packageName, 10),
      listReviews(c.env.DB, packageName, 30),
      countReviews(c.env.DB, packageName),
      listAnalysesForApp(c.env.DB, packageName, 5),
      listErrorJobsForApp(c.env.DB, packageName, 10),
    ]);

    return c.html(
      <Layout
        title={appRow.title ?? appRow.package_name}
        message={c.req.query('msg')}
        error={c.req.query('error')}
      >
        <AppDetailPage
          data={{
            app: appRow,
            latest: lastTwo.current,
            diffs: computeDiff(lastTwo.current, lastTwo.previous),
            previousDate: lastTwo.previous?.collected_date ?? null,
            snapshots,
            whatsNew,
            reviews,
            reviewTotal,
            analyses,
            errorJobs,
            reviewRetentionDays: config.reviewRetentionDays,
          }}
        />
      </Layout>
    );
  });

  // ---- 手動実行(仕様 14) ----
  app.post('/apps/:pkg/collect', async (c) => {
    const config = await loadConfig(c.env);
    const packageName = c.req.param('pkg');
    if (!(await getApp(c.env.DB, packageName))) return c.notFound();

    const result = await collectApp(c.env, config, packageName, 'manual');
    return redirectToApp(c, packageName, result.ok, result.message);
  });

  app.post('/apps/:pkg/analyze', async (c) => {
    const config = await loadConfig(c.env);
    const packageName = c.req.param('pkg');
    if (!(await getApp(c.env.DB, packageName))) return c.notFound();

    const result = await analyzeApp(c.env, config, packageName, 'manual');
    return redirectToApp(c, packageName, result.ok, result.message);
  });

  // ---- 監視の停止 / 再開(仕様 13.1) ----
  app.post('/apps/:pkg/pause', async (c) => {
    const packageName = c.req.param('pkg');
    if (!(await getApp(c.env.DB, packageName))) return c.notFound();
    await setAppStatus(c.env.DB, packageName, 'paused');
    return redirectToApp(c, packageName, true, '監視を停止しました(履歴は保持されます)');
  });

  app.post('/apps/:pkg/resume', async (c) => {
    const packageName = c.req.param('pkg');
    if (!(await getApp(c.env.DB, packageName))) return c.notFound();
    await setAppStatus(c.env.DB, packageName, 'active');
    return redirectToApp(c, packageName, true, '監視を再開しました');
  });

  // ---- 永久削除(仕様 13.2)。GET で確認画面を挟む ----
  app.get('/apps/:pkg/delete', async (c) => {
    const packageName = c.req.param('pkg');
    const appRow = await getApp(c.env.DB, packageName);
    if (!appRow) return c.notFound();
    return c.html(
      <Layout title="永久削除の確認">
        <DeleteConfirmPage app={appRow} />
      </Layout>
    );
  });

  app.post('/apps/:pkg/delete', async (c) => {
    const packageName = c.req.param('pkg');
    if (!(await getApp(c.env.DB, packageName))) return c.notFound();
    await deleteAppCompletely(c.env.DB, packageName);
    return c.redirect('/apps?msg=' + encodeURIComponent(`${packageName} を永久削除しました`));
  });

  // ---- AI Q&A(仕様 11 / 27.6) ----
  app.get('/qa', (c) =>
    c.html(
      <Layout title="AI Q&A">
        <QaPage />
      </Layout>
    )
  );

  app.post('/qa', async (c) => {
    const config = await loadConfig(c.env);
    const body = await c.req.parseBody();
    const question = String(body.question ?? '').trim();
    const startedAt = isoNow();

    if (!question) {
      return c.html(
        <Layout title="AI Q&A">
          <QaPage error="質問を入力してください" />
        </Layout>
      );
    }

    try {
      const prompt = await buildQaPrompt(c.env.DB, question);
      const answer = await generateText(c.env, config, prompt, {
        systemInstruction: SYSTEM_INSTRUCTION,
      });
      await logJob(c.env.DB, { kind: 'qa', trigger: 'manual', status: 'success', message: question.slice(0, 200), startedAt });
      return c.html(
        <Layout title="AI Q&A">
          <QaPage question={question} answer={answer} />
        </Layout>
      );
    } catch (e) {
      const error = e as Error;
      const quota = error instanceof GeminiQuotaError;
      await logJob(c.env.DB, {
        kind: 'qa',
        trigger: 'manual',
        status: quota ? 'skipped' : 'error',
        message: error.message,
        startedAt,
      });
      return c.html(
        <Layout title="AI Q&A">
          <QaPage question={question} error={error.message} />
        </Layout>
      );
    }
  });

  // ---- 実行履歴(仕様 16 / 20) ----
  app.get('/jobs', async (c) => {
    const [jobs, globalAnalyses] = await Promise.all([
      listJobs(c.env.DB, 100),
      listGlobalAnalyses(c.env.DB, 3),
    ]);
    return c.html(
      <Layout title="実行履歴">
        <JobsPage jobs={jobs} globalAnalyses={globalAnalyses} />
      </Layout>
    );
  });

  // ---- 設定(仕様 27.5) ----
  app.get('/settings', async (c) => {
    const config = await loadConfig(c.env);
    return c.html(
      <Layout title="設定" message={c.req.query('msg')} error={c.req.query('error')}>
        <SettingsPage config={config} geminiConfigured={Boolean(c.env.GEMINI_API_KEY)} />
      </Layout>
    );
  });

  app.post('/settings', async (c) => {
    const body = await c.req.parseBody();

    const updates: [string, string | undefined][] = [
      [SETTING_KEYS.geminiModel, asTrimmed(body.gemini_model)],
      [SETTING_KEYS.collectStartJst, asTrimmed(body.collect_start_jst)],
      [SETTING_KEYS.collectBatchSize, asPositiveInt(body.collect_batch_size)],
      [SETTING_KEYS.analyzeBatchSize, asPositiveInt(body.analyze_batch_size)],
      [SETTING_KEYS.reviewRetentionDays, asPositiveInt(body.review_retention_days)],
      [SETTING_KEYS.logRetentionDays, asPositiveInt(body.log_retention_days)],
      [SETTING_KEYS.geminiDailyLimit, asNonNegativeInt(body.gemini_daily_limit)],
    ];

    for (const [key, value] of updates) {
      if (value != null && value !== '') await setSetting(c.env.DB, key, value);
    }

    return c.redirect('/settings?msg=' + encodeURIComponent('設定を保存しました'));
  });

  return app;
}

function redirectToApp(
  c: { redirect: (url: string) => Response },
  packageName: string,
  ok: boolean,
  message: string
) {
  const key = ok ? 'msg' : 'error';
  return c.redirect(`/apps/${encodeURIComponent(packageName)}?${key}=${encodeURIComponent(message)}`);
}

/**
 * 入力されたパッケージ名を正規化する。
 * Google Play の URL がそのまま貼られた場合は id パラメータを取り出す。
 */
export function normalizePackageName(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const fromUrl = /[?&]id=([^&\s]+)/.exec(trimmed);
  const candidate = fromUrl ? decodeURIComponent(fromUrl[1]) : trimmed;

  // 英数字・アンダースコアのセグメントがドットで 2 つ以上つながる形のみ許可する
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(candidate)) return null;
  return candidate;
}

function asTrimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function asPositiveInt(value: unknown): string | undefined {
  const trimmed = asTrimmed(value);
  if (trimmed == null) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? String(Math.floor(n)) : undefined;
}

// Gemini 呼び出し上限だけは 0(=AI 分析を止める)を有効な入力として受け付ける
function asNonNegativeInt(value: unknown): string | undefined {
  const trimmed = asTrimmed(value);
  if (trimmed == null) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? String(Math.floor(n)) : undefined;
}
