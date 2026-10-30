import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiMessage } from '@kuxi/shared';
import { askAi, extractSql } from './useAi';

/**
 * AI 调用层回归测试。
 *
 * 重点验证多轮对话的消息拼装顺序：system → 历史（按时间正序）→ 当前问题。
 * 顺序错了模型就会把"上一问"当成当前问题；历史丢了就变成单轮，追问失效。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 挂一个假的 window.kuxi.aiChat，记录收到的消息数组 */
function stubAi(content = '```sql\nSELECT 1\n```') {
  const aiChat = vi.fn(async (_messages: AiMessage[]) => ({
    status: 'ok' as const,
    result: { content, model: 'test-model', tookMs: 1 },
  }));
  vi.stubGlobal('kuxi', { aiChat });
  return aiChat;
}

describe('askAi 消息拼装', () => {
  it('无历史时只有 system + user', async () => {
    const aiChat = stubAi();
    await askAi('你是 DBA', '有哪些表');

    expect(aiChat).toHaveBeenCalledTimes(1);
    const messages = (aiChat.mock.calls[0] as unknown as [AiMessage[]])[0];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0].content).toBe('你是 DBA');
    expect(messages[1].content).toBe('有哪些表');
  });

  it('带历史时顺序为 system → 历史 → 当前问题', async () => {
    const aiChat = stubAi();
    const history: AiMessage[] = [
      { role: 'user', content: '查所有订单' },
      { role: 'assistant', content: 'SELECT * FROM orders LIMIT 100' },
    ];
    await askAi('你是 DBA', '再加按城市分组', history);

    const messages = (aiChat.mock.calls[0] as unknown as [AiMessage[]])[0];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[1].content).toBe('查所有订单');
    expect(messages[2].content).toBe('SELECT * FROM orders LIMIT 100');
    expect(messages[3].content).toBe('再加按城市分组');
  });

  it('模型出错时抛出错误信息', async () => {
    vi.stubGlobal('kuxi', {
      aiChat: vi.fn(async () => ({ status: 'error' as const, message: '额度不足' })),
    });
    await expect(askAi('sys', 'q')).rejects.toThrow('额度不足');
  });
});

describe('extractSql', () => {
  it('优先取 ```sql 围栏内容', () => {
    expect(extractSql('说明如下\n```sql\nSELECT id FROM t\n```\n完毕')).toBe('SELECT id FROM t');
  });

  it('无围栏时从首个 SQL 行截取', () => {
    expect(extractSql('先看看\nSELECT * FROM t')).toBe('SELECT * FROM t');
  });
});
