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

test('brief protects project lines when the global section overflows the budget', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const core = await T.MemoryCore.create({ logger: null });
    const project = await mkdir(join(tmpdir(), `proj-brief-test-${Date.now()}`), { recursive: true });
    await writeFile(join(project, '.git'), 'fake');

    const gLong =
      'K8S 集群的 ingress VIP 是 10.20.60.215，所有 ingress 对外服务统一走该 VIP，DNS A 记录应指向该地址，新建服务时不要再另配域名，网关超时统一设为六十秒。';
    for (let i = 0; i < 3; i++) {
      await core.remember({ content: `${gLong}（第 ${i + 1} 条补充说明用于撑长全局段落以便触发预算裁剪逻辑。）`, scope: 'global' }, 'tool', 's1');
    }
    const r1 = await core.remember({ content: '项目 A 的前端框架是 Vue3，构建走 vite。', scope: 'project', cwd: project }, 'tool', 's1');
    await core.remember({ content: '项目 B 的后端端口固定 8790，健康检查 /healthz。', scope: 'project', cwd: project }, 'tool', 's1');
    const slug = r1.slug;

    const assertNoDanglingHeader = (b) => {
      const lines = b.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('## ')) {
          assert.ok(lines[i + 1]?.startsWith('- ['), `dangling section header: ${lines[i]}`);
        }
      }
    };

    // Comfortable budget: both sections fully present.
    const full = await T.buildBrief(core, { projectSlug: slug, maxBytes: 4096, projectK: 12, globalK: 8 });
    assertNoDanglingHeader(full);
    assert.ok(full.includes('前端框架是 Vue3'));
    assert.ok(full.includes('后端端口固定 8790'));
    assert.ok(full.includes('## 全局记忆 (3)'));

    // Tight budget: GLOBAL lines are sacrificed first; every project line survives.
    const tight = await T.buildBrief(core, { projectSlug: slug, maxBytes: 1500, projectK: 12, globalK: 8 });
    assert.ok(Buffer.byteLength(tight, 'utf8') <= 1500, `framed ${Buffer.byteLength(tight, 'utf8')} <= 1500`);
    assertNoDanglingHeader(tight);
    assert.ok(tight.includes('前端框架是 Vue3'), 'project line protected at 1500B');
    assert.ok(tight.includes('后端端口固定 8790'), 'project line protected at 1500B');

    // Very tight: the whole global section is omitted rather than leaving a
    // bare header with a stale count.
    const veryTight = await T.buildBrief(core, { projectSlug: slug, maxBytes: 700, projectK: 12, globalK: 8 });
    assert.ok(Buffer.byteLength(veryTight, 'utf8') <= 700, `framed ${Buffer.byteLength(veryTight, 'utf8')} <= 700`);
    assertNoDanglingHeader(veryTight);
    assert.ok(!veryTight.includes('## 全局记忆'), 'global section omitted, not a dangling header');
    assert.ok(veryTight.includes('前端框架是 Vue3'), 'project line protected at 700B');
    assert.ok(veryTight.includes('后端端口固定 8790'), 'project line protected at 700B');
  });
});

test('brief renders one-line card titles once (no title==snippet duplication)', async () => {
  await withDshHome(async () => {
    const T = await import('../lib/testing.js');
    const core = await T.MemoryCore.create({ logger: null });
    await core.remember({ content: '数据库连接串走环境变量，不进代码库。', scope: 'global' }, 'tool', 's1');
    const brief = await T.buildBrief(core, { projectSlug: null, maxBytes: 4096, projectK: 0, globalK: 8 });
    const occurrences = brief.split('数据库连接串走环境变量，不进代码库。').length - 1;
    assert.equal(occurrences, 1, `title must appear exactly once, found ${occurrences}`);
    assert.ok(!brief.includes('— 数据库连接串'), 'no duplicated snippet after the em-dash');
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
