import { runScheduledTick } from './jobs/scheduler';
import type { Env } from './types';
import { createRouter } from './web/router';

/**
 * Worker のエントリポイント。
 *  * fetch     : Basic 認証付きの Web UI(仕様 12 / 21)
 *  * scheduled : Cron Trigger からの定期処理(仕様 15)
 */
const router = createRouter();

export default {
  fetch: router.fetch,

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // 実装ポイント: tick 内で例外が出ても Cron 自体は落とさない。
    // 失敗はキューの attempts と実行履歴に残り、次の発火で再試行される(仕様 17.2)。
    ctx.waitUntil(
      runScheduledTick(env).catch((e) => {
        console.error('scheduled tick failed', e);
      })
    );
  },
};
