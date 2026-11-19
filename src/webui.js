/**
 * 技能宿主设置页的前端（Coopanion 面板）。
 *
 * 服务端 webUi() 里声明了 panels：第一个是本体（id `base`），后面每个技能一个（id `skill-<技能 id>`）。
 * Coopanion 会把它们排成设置页顶上的分页，点一下切一页——所以这里每个面板只管渲染自己那一组配置。
 *
 * 面板 id 是动态的（技能可以随时装、删），所以 panels 用一个 Proxy，任何 id 都能取到同一个工厂，
 * 工厂再从 id 反推要读哪一组配置。
 *
 * 读写都走这一页自己声明的数据面（World 的 webUi().invoke）：
 *   ctx.invoke('group', [组 id])       → { title, description, fields:[{ key,title,type,description,value }] }
 *   ctx.invoke('save',  [字段全名, 值]) → 保存
 */

const GROUP_BASE = 'world:skillhost:base';

/** 本体页顶上的 OmniAgent 市场入口。 */
const MARKET_URL = 'https://kondius.cn/OmniAgent/market.html?type=skills';
const MARKET_LABEL = '去 OmniAgent 市场看技能';

function groupFor(panelId) {
  const id = String(panelId);
  if (id.startsWith('skill-')) return `world:skillhost:${id.slice(6)}`;
  return GROUP_BASE;
}

function makePanel(panelId) {
  return {
    async mount(ctx) {
      const ui = ctx.ui;
      const groupId = groupFor(panelId);
      let data;
      try {
        data = await ctx.invoke('group', [groupId]);
      } catch (err) {
        ctx.root.append(ui.msgline(String(err?.message ?? err), true));
        return;
      }
      if (!data || !Array.isArray(data.fields)) {
        ctx.root.append(ui.msgline(String(data?.error ?? '读不到这一页的配置'), true));
        return;
      }

      const sheet = ui.sheet({ title: data.title || '技能宿主', desc: data.description });
      ctx.root.append(sheet.el);

      // 本体页：市场入口 + 已装技能的管理（卸载）。都放在最上面。
      if (groupId === GROUP_BASE) {
        sheet.body.append(marketBlock(ctx));
        sheet.body.append(manageBlock(ctx));
      }

      // 技能页：把「启用」开关塞进标题行（h3），和名字排在同一行。
      const skillId = skillIdOf(groupId);
      const enKey = skillId ? `worlds.skillhost.skill.${skillId}` : '';
      const isEnable = (f) => Boolean(skillId)
        && (String(f.key) === enKey || (f.type === 'boolean' && /\.skill\.[^.]*$/.test(String(f.key))));
      const enField = skillId ? data.fields.find(isEnable) : null;
      const head = sheet.el.firstElementChild;
      if (head && enField) head.appendChild(enableBox(ctx, skillId, enField));
      // 服务端给的说明是 webUi() 时算的，开关状态和工具数会过时；这里只留不会变的一句。
      if (enField && sheet.desc) sheet.desc.textContent = `来自 ${skillId}，开关就在上面名字旁边。`;

      const rest = data.fields.filter((f) => !(enField && isEnable(f)));
      if (!rest.length) {
        sheet.body.append(ui.placeholder('这一组暂时没有可配置项。'));
      } else {
        for (const field of rest) renderField(ctx, sheet.body, field);
      }
    },
  };
}

/** `world:skillhost:<技能 id>` → 技能 id；本体那一页返回 null。 */
function skillIdOf(groupId) {
  const s = String(groupId);
  if (s === GROUP_BASE) return null;
  const cut = s.lastIndexOf(':');
  return cut >= 0 ? s.slice(cut + 1) : null;
}

/** 标题行里的启用开关：框架的 `.switchbox` 样式会把它画成拨动开关；走 toggle（会重新加载），不走 save。 */
function enableBox(ctx, skillId, field) {
  const ui = ctx.ui;
  const box = ui.checkbox('', {
    checked: Boolean(field.value),
    title: String(field.description || ''),
    onChange: (v) => {
      ctx.invoke('toggle', [skillId, Boolean(v)]).then(
        () => ui.toast(v ? '已打开，正在重新加载' : '已关掉，正在重新加载'),
        (err) => ui.toast('改不了：' + String(err?.message ?? err), 'bad'),
      );
    },
  });
  // 框架的 .switchbox 样式在设置页里没吃到（画出来还是方勾、渐变也不显示），
  // 所以真 `input` 藏起来，自己用两层 span 画拨动开关；点 label 仍会切换 input。
  const input = box.input;
  const doc = box.el.ownerDocument;
  const track = doc.createElement('span');
  track.style.cssText = [
    'display:inline-block', 'box-sizing:border-box', 'position:relative',
    'width:34px', 'height:20px', 'border-radius:10px', 'flex:none',
    'transition:background-color .15s', 'background:var(--line-2, #cbd5e1)',
  ].join(';');
  const knob = doc.createElement('span');
  knob.style.cssText = [
    'display:block', 'position:absolute', 'top:2px', 'left:2px',
    'width:16px', 'height:16px', 'border-radius:50%', 'background:#fff',
    'box-shadow:0 1px 2px rgba(0,0,0,.3)', 'transition:transform .15s',
  ].join(';');
  track.append(knob);
  const paint = () => {
    const on = input ? Boolean(input.checked) : false;
    track.style.background = on ? 'var(--accent, #3b82f6)' : 'var(--line-2, #cbd5e1)';
    knob.style.transform = on ? 'translateX(14px)' : 'none';
  };
  if (input) {
    input.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;margin:0;pointer-events:none';
    input.addEventListener('change', paint);
  }
  // 标签里那个空 span 会撑出 gap，去掉。
  for (const span of box.el.querySelectorAll(':scope > span')) span.style.display = 'none';
  box.el.append(track);
  paint();
  const wrap = ui.h('div');
  wrap.style.display = 'inline-flex';
  wrap.style.alignItems = 'center';
  wrap.style.verticalAlign = 'middle';
  wrap.style.marginLeft = '10px';
  wrap.append(box.el);
  return wrap;
}

/** 本体页顶上的市场入口：一个跳转按钮，下面一行小字写解压到哪。 */
function marketBlock(ctx) {
  const ui = ctx.ui;
  const box = ui.h('div', 'cfgfld');
  const bar = ui.rowbar();
  // `.btn` 在设置页里吃不到框架样式，画出来只是一行带下划线的字；所以这里自己画成实体按钮：
  // 一圈边框，底下一条更深的边做出厚度，底面色也压暗一档。
  const link = ui.h('a', '', MARKET_LABEL);
  link.href = MARKET_URL;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const accent = 'var(--accent, #3b6cf6)';
  link.style.cssText = [
    'display:inline-flex',
    'align-items:center',
    'margin:2px 0 8px',
    'padding:8px 16px',
    'border-radius:10px',
    'border:1px solid color-mix(in srgb, ' + accent + ' 62%, #000)',
    'background:linear-gradient(180deg, ' + accent + ' 0%, color-mix(in srgb, ' + accent + ' 88%, #000) 100%)',
    'color:#fff',
    'font-size:13px',
    'font-weight:600',
    'line-height:1.2',
    'text-decoration:none',
    'box-shadow:0 1px 2px rgba(0,0,0,.28)',
    'cursor:pointer',
  ].join(';');
  bar.append(link);
  box.append(bar);

  const note = ui.h('div', 'cfgdesc');
  note.append('从市场下载的 ZIP 解压到：');
  const code = ui.h('code', '');
  code.style.fontFamily = 'ui-monospace, Consolas, monospace';
  code.textContent = '…';
  note.append(code);
  box.append(note);

  ctx.invoke('skillsDir', []).then(
    (res) => {
      const dir = String(res?.path ?? '');
      code.textContent = dir || '（数据目录里的 skills）';
      code.after(' ', ui.copyButton(dir));
    },
    () => { code.textContent = '（数据目录里的 skills）'; },
  );
  note.append('，解压后应能看到 skill.json 和 index.js。');
  return box;
}

/** 本体页：已装技能一览，每行一个「卸载」，点两次（确认）才真删。 */
function manageBlock(ctx) {
  const ui = ctx.ui;
  const line = (text) => {
    const el = ui.h('div', 'cfgdesc');
    el.textContent = text;
    return el;
  };
  const box = ui.h('div', 'cfgfld');
  const title = ui.h('div', '');
  title.style.cssText = 'font-weight:600;font-size:13px;margin:14px 0 4px';
  title.textContent = '已安装的技能';
  box.append(title);
  box.append(line('开关管加载，卸载会删掉文件夹。装好的技能这里会自己冒出来，上面的分页也会跟着刷新。'));

  const list = ui.h('div', '');
  box.append(list);

  // `.btn` 在这个页面吃不到样式，卸载按钮自己画：红框、淡红底，一眼看得出能按。
  const dangerBtn = (label, onClick) => {
    const b = ui.h('button', '');
    b.type = 'button';
    b.textContent = label;
    const bg = (a) => `color-mix(in srgb, #e5484d ${a}%, transparent)`;
    b.style.cssText = [
      'padding:4px 12px',
      'border-radius:8px',
      'font-size:12px',
      'font-weight:600',
      'line-height:1.4',
      'border:1px solid color-mix(in srgb, #e5484d 55%, transparent)',
      'background:' + bg(10),
      'color:#e5484d',
      'cursor:pointer',
    ].join(';');
    b.addEventListener('mouseenter', () => { b.style.background = bg(22); });
    b.addEventListener('mouseleave', () => { b.style.background = bg(10); });
    b.addEventListener('click', onClick);
    return b;
  };

  // 拨动开关：刚装的技能还没分页，至少能在这里直接开/关。
  const sw = (on, onChange) => {
    const track = ui.h('span', '');
    track.style.cssText = [
      'display:inline-block', 'box-sizing:border-box', 'position:relative', 'flex:none',
      'width:34px', 'height:20px', 'border-radius:10px', 'cursor:pointer',
      'transition:background-color .15s',
    ].join(';');
    const knob = ui.h('span', '');
    knob.style.cssText = [
      'display:block', 'position:absolute', 'top:2px', 'left:2px',
      'width:16px', 'height:16px', 'border-radius:50%', 'background:#fff',
      'box-shadow:0 1px 2px rgba(0,0,0,.3)', 'transition:transform .15s',
    ].join(';');
    track.append(knob);
    let state = Boolean(on);
    const paint = () => {
      track.style.background = state ? 'var(--accent, #3b82f6)' : 'var(--line-2, #cbd5e1)';
      knob.style.transform = state ? 'translateX(14px)' : 'none';
    };
    track.addEventListener('click', () => {
      state = !state;
      paint();
      onChange(state);
    });
    paint();
    return track;
  };

  const toggle = (item, on) => {
    ctx.invoke('toggle', [item.id, on]).then(
      () => ui.toast(on ? `已打开 ${item.name || item.id}` : `已关掉 ${item.name || item.id}`),
      (err) => { ui.toast('切换失败：' + String(err?.message ?? err), 'bad'); load(); },
    );
  };

  const uninstall = async (item) => {
    const label = item.name || item.id;
    const ok = await ui.confirm({
      title: `卸载「${label}」？`,
      body: '会把技能目录里这个文件夹整个删掉，它的设置也一起没了。要装回来得重新从市场下 ZIP 解压。',
      danger: true,
    });
    if (!ok) return;
    try {
      await ctx.invoke('uninstall', [item.id]);
      ui.toast(`已卸载 ${label}`);
      load();
    } catch (err) {
      ui.toast('卸载失败：' + String(err?.message ?? err), 'bad');
    }
  };

  const render = (items) => {
    list.textContent = '';
    if (!items.length) { list.append(line('技能目录里还没有技能。')); return; }
    items.forEach((item, i) => {
      const row = ui.h('div', '');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0'
        + (i ? ';border-top:1px solid color-mix(in srgb, currentColor 14%, transparent)' : '');
      const info = ui.h('div', '');
      info.style.cssText = 'flex:1;min-width:0';
      const name = ui.h('div', '');
      name.style.cssText = 'font-size:13px;font-weight:600';
      name.textContent = item.name || item.id;
      const meta = ui.h('div', 'cfgdesc');
      const bits = [];
      if (item.version) bits.push('v' + item.version);
      bits.push(item.enabled ? '已启用' : '已关掉');
      if (typeof item.tools === 'number') bits.push(item.tools + ' 个工具');
      meta.textContent = bits.join(' · ');
      meta.style.marginTop = '2px';
      info.append(name, meta);
      row.append(info, sw(item.enabled, (on) => toggle(item, on)), dangerBtn('卸载', () => { void uninstall(item); }));
      list.append(row);
    });
  };

  // 解压一个技能、卸载一个技能之后，这一页和上面那排分页都会跟实际对不上。
  // 每 4 秒问一次服务端；列表变了就重画，并且让宿主重取一次 manifest——分页自己就长出来了。
  let sig = null;
  const signature = (items) => items
    .map((it) => [it.id, it.version ? String(it.version) : '', it.enabled ? 1 : 0].join(':'))
    .join('|');

  const load = () => {
    ctx.invoke('skills', []).then(
      (res) => {
        const items = Array.isArray(res?.items) ? res.items : [];
        const next = signature(items);
        const first = sig === null;
        if (!first && next === sig) return;
        const changed = !first;
        sig = next;
        render(items);
        if (changed) {
          // 目录变了不代表技能已经加载进来：先让服务端重载一次，再让宿主重取 manifest。
          Promise.resolve(ctx.invoke('reload', []))
            .catch(() => {})
            .then(() => (typeof ctx.refresh === 'function' ? Promise.resolve(ctx.refresh()).catch(() => {}) : null))
            .then(() => ui.toast('技能有变动，分页已经跟着刷新了'));
        }
      },
      (err) => { list.textContent = ''; list.append(line('读不出技能列表：' + String(err?.message ?? err))); },
    );
  };
  load();
  if (typeof ctx.interval === 'function') ctx.interval(() => { load(); }, 4000);
  return box;
}

function renderField(ctx, host, field) {
  const ui = ctx.ui;
  let timer = null;

  const save = (next) => {
    ctx.invoke('save', [field.key, next]).then(
      () => ui.toast('已保存'),
      (err) => ui.toast('保存失败：' + String(err?.message ?? err), 'bad'),
    );
  };
  const later = (next, now = false) => {
    if (timer) { timer.dispose?.(); timer = null; }
    if (now) { save(next); return; }
    timer = ui.timeout(() => { timer = null; save(next); }, 350);
  };

  const value = field.value;
  let control;
  if (field.type === 'boolean') {
    control = ui.checkbox('', { checked: Boolean(value), onChange: (v) => later(v, true) }).el;
  } else if (field.type === 'number' || field.type === 'integer') {
    const input = ui.input({ type: 'number', value: value == null ? '' : String(value), onChange: (v) => later(Number(v)) });
    control = input;
  } else {
    const key = String(field.key);
    const long = /Token|extraBody|blockedTerms|description|prompt/i.test(key);
    control = long
      ? ui.textarea({ value: value == null ? '' : String(value), rows: 3, onChange: (v) => later(v) })
      : ui.input({ value: value == null ? '' : String(value), onChange: (v) => later(v) });
  }

  const box = ui.h('div', 'cfgfld');
  box.append(ui.field(String(field.title || field.key), control));
  if (field.description) box.append(ui.h('div', 'cfgdesc', String(field.description)));
  host.append(box);
}

const cache = new Map();
function panelFor(id) {
  const key = String(id);
  if (!cache.has(key)) cache.set(key, makePanel(key));
  return cache.get(key);
}

const panels = new Proxy(
  {},
  {
    has: (_t, key) => typeof key === 'string',
    get: (_t, key) => (typeof key === 'string' ? panelFor(key) : undefined),
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
  },
);

export default { panels };
