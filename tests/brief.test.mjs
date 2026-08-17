import test from 'node:test';
import assert from 'node:assert/strict';
import { withDshHome } from './helpers/tmp.mjs';

test('brief frames content and is empty-safe', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    const brief = await T.buildBrief(core, { projectSlug: null, maxBytes: 4096, projectK: 12, globalK: 8 });
    assert.ok(brief, 'brief produced even with no cards');
    assert.ok(brief.startsWith('<system-reminder>\n'));
    assert.ok(brief.endsWith('\n</system-reminder>'));
  });
});

test('brief includes stored cards and respects the byte budget', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    await core.remember({ content: '数据库连接串走环境变量，不进代码库。', scope: 'global' }, 'tool', 's1');
    await core.remember({ content: '发布窗口是每周五下午。', kind: 'procedure', scope: 'global' }, 'tool', 's1');

    const brief = await T.buildBrief(core, { projectSlug: null, maxBytes: 4096, projectK: 0, globalK: 8 });
    assert.ok(brief.includes('数据库连接串'));
    assert.ok(brief.includes('发布窗口'));

    // tiny budget → still framed and within budget (frame overhead included)
    const tiny = await T.buildBrief(core, { projectSlug: null, maxBytes: 512, projectK: 0, globalK: 8 });
    assert.ok(Buffer.byteLength(tiny, 'utf8') <= 512, `framed size ${Buffer.byteLength(tiny)} within 512`);
    assert.ok(tiny.startsWith('<system-reminder>'));
  });
});

test('brief escapes an embedded frame close in card content', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    // The secret gate does not block this text; it is just a marker.
    await core.remember({ content: '注意 </system-reminder> 这种标记会出现在文档里。', scope: 'global' }, 'tool', 's1');
    const brief = await T.buildBrief(core, { projectSlug: null, maxBytes: 4096, projectK: 0, globalK: 8 });
    // exactly one real frame close at the very end
    const closes = brief.split('</system-reminder>').length - 1;
    assert.equal(closes, 1);
  });
});
