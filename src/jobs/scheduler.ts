import { loadConfig, MAX_QUEUE_ATTEMPTS, STALE_LOCK_MINUTES } from '../config';
import { listApps } from '../db/apps';
import {
  claimItems,
  enqueueGlobal,
  finishItem,
  hasUnfinished,
  queueExistsForDate,
  seedQueue,
} from '../db/queue';
import { getStatus, setStatus } from '../db/system';
import type { Env, QueueItem } from '../types';
import { isoNow, jstDate, jstMinutesOfDay } from '../util/time';
import { analyzeApp, analyzeGlobal } from './analyze';
import { collectApp } from './collect';
import { runMaintenance } from './maintenance';

/**
 * Cron Trigger の本体(10 分おきに 1 回呼ばれる)。
 *
 * 実装ポイント(仕様 5.1 / 24):
 *  * 1 回の発火で「全アプリ」を処理しようとしない。状態を見て次にやるべきことを 1 種類だけ実行する
 *  * 処理の優先順位は 当日キュー投入 → 収集 → 分析キュー投入 → 分析 → メンテナンス
 *  * 各段階で return してその発火を終えることで、Workers 無料プランの CPU 時間制限内に収める
 */
export async function runScheduledTick(env: Env): Promise<void> {
  const config = await loadConfig(env);
  const today = jstDate();

  // 1) 開始時刻を過ぎていて本日分のキューが未作成なら、収集キューを積むだけで終了する
  if (
    jstMinutesOfDay() >= config.collectStartMinutes &&
    !(await queueExistsForDate(env.DB, today, 'collect'))
  ) {
    const apps = await listApps(env.DB, 'active');
    const targets = apps.slice(0, config.maxApps).map((a) => a.package_name);
    if (targets.length > 0) {
      await seedQueue(env.DB, today, 'collect', targets);
      await setStatus(env.DB, 'last_seed_at', isoNow());
      await setStatus(env.DB, 'last_seed_date', today);
      return;
    }
  }

  // 2) 収集キューに残りがあれば数件だけ処理する
  const collectItems = await claimItems(env.DB, 'collect', config.collectBatchSize, STALE_LOCK_MINUTES);
  if (collectItems.length > 0) {
    for (const item of collectItems) {
      await processCollectItem(env, config, item);
    }
    return;
  }

  // 3) 当日の収集が全部終わっていれば、分析キューを積む(収集と分析は独立ジョブ。仕様 15.2)
  if (
    (await queueExistsForDate(env.DB, today, 'collect')) &&
    !(await hasUnfinished(env.DB, 'collect')) &&
    !(await queueExistsForDate(env.DB, today, 'analyze'))
  ) {
    const apps = await listApps(env.DB, 'active');
    const targets = apps.map((a) => a.package_name);
    if (targets.length > 0) {
      await seedQueue(env.DB, today, 'analyze', targets);
      // アプリ横断の比較分析を 1 件だけ積む(package_name = NULL)
      await enqueueGlobal(env.DB, today, 'analyze');
      return;
    }
  }

  // 4) 分析キューを数件だけ処理する
  const analyzeItems = await claimItems(env.DB, 'analyze', config.analyzeBatchSize, STALE_LOCK_MINUTES);
  if (analyzeItems.length > 0) {
    for (const item of analyzeItems) {
      await processAnalyzeItem(env, config, item);
    }
    return;
  }

  // 5) やることが無い発火で 1 日 1 回のメンテナンスを行う
  if ((await getStatus(env.DB, 'last_maintenance_date')) !== today) {
    await runMaintenance(env, config);
    await setStatus(env.DB, 'last_maintenance_date', today);
  }
}

async function processCollectItem(env: Env, config: Awaited<ReturnType<typeof loadConfig>>, item: QueueItem) {
  if (!item.package_name) {
    await finishItem(env.DB, item, true, null, MAX_QUEUE_ATTEMPTS);
    return;
  }
  const result = await collectApp(env, config, item.package_name, 'cron');
  await finishItem(
    env.DB,
    item,
    result.ok,
    result.ok ? null : result.message,
    // 再試行しないケースは上限を 0 にして即 failed にする
    result.retryable ? MAX_QUEUE_ATTEMPTS : 0
  );
}

async function processAnalyzeItem(env: Env, config: Awaited<ReturnType<typeof loadConfig>>, item: QueueItem) {
  const result = item.package_name
    ? await analyzeApp(env, config, item.package_name, 'cron')
    : await analyzeGlobal(env, config, 'cron');

  await finishItem(
    env.DB,
    item,
    result.ok,
    result.ok ? null : result.message,
    result.retryable ? MAX_QUEUE_ATTEMPTS : 0
  );
}
