/**
 * 技能宿主（skill host）— 把 OmniAgent 的技能包直接当工具用。
 *
 * 一个 OmniAgent 技能长这样：
 *   <skill>/skill.json   声明（id / name / version / capabilities / permissions / settings / configSchema）
 *   <skill>/index.js     ES module，导出 setup(api) / activate() / deactivate() / available() …
 *                        在 setup 里通过 api.registerTool({ id, name, description, parameters, execute }) 注册工具
 *
 * 所以不用逐个手写：这个 World 自己实现那套 api（config / fetch / warn / registerTool），
 * 把技能加载起来，然后用三个通用工具转出去：
 *   skill_list    有哪些技能、哪些工具、哪些设置还空着
 *   skill_call    调某个技能里的某个工具
 *   skill_config  填 apiKey / baseUrl / 模型这些设置
 *
 * 技能设置存在 <dataDir>/configs/<skillId>.json，改完下一次调用就生效，不用重启。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ID = 'skillhost';

/* ------------------------------------------------------------------ 工具声明 */

const TOOLS = [
  {
    name: 'skill_list',
    description:
      '看看技能宿主里装了什么：每个技能来自哪个包、注册了哪些工具、哪些设置项还空着（比如 apiKey / baseUrl）。'
      + '不确定工具名或参数时先调它。',
    tags: ['tools'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        skill: { type: 'string', description: '只看某一个技能（技能 id，如 ai-image）。不填就列全部。' },
      },
      required: [],
    },
  },
  {
    name: 'skill_call',
    description:
      '调用技能里的一个工具。skill 填技能 id，tool 填工具 id（skill_list 里看到的那个），args 按该工具的参数填。'
      + '返回技能自己给的文字结果。',
    tags: ['tools'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        skill: { type: 'string', description: '技能 id，例如 ai-image。' },
        tool: { type: 'string', description: '工具 id，例如 gen 或 edit。' },
        args: { type: 'object', description: '该工具的参数对象。', additionalProperties: true },
        to: {
          type: 'string',
          description: '这个技能要发东西时发到哪：group:群号 或 private:QQ号。不填就用设置里的默认去处。',
        },
        senderId: {
          type: 'string',
          description: '群聊里提出这次要求的人的 QQ 号（技能要靠它认人和算额度）。私聊可以不给。',
        },
      },
      required: ['skill', 'tool'],
    },
  },
  {
    name: 'skill_config',
    description:
      '填或改某个技能的设置（apiKey、baseUrl、模型这类）。只传要改的键，会合并进这个技能自己的配置文件；'
      + '给 forget 就把整个技能的设置清掉。',
    tags: ['tools'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        skill: { type: 'string', description: '技能 id。' },
        patch: {
          type: 'object',
          description: '要写入的设置，例如 {"apiKey":"sk-...","baseUrl":"https://api.siliconflow.cn/v1"}。',
          additionalProperties: true,
        },
        forget: { type: 'boolean', description: 'true = 清空这个技能的设置。' },
      },
      required: ['skill'],
    },
  },
  {
    name: 'skill_toggle',
    description:
      '临时关掉或重新打开一个技能：关掉之后它不会被加载，工具也调不了，但不删文件、设置都留着。'
      + '设置页里每个技能也有一行同样的开关。',
    tags: ['tools'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        skill: { type: 'string', description: '技能 id，例如 ai-image。' },
        enabled: { type: 'boolean', description: 'true = 打开，false = 关掉。不填就当关掉。' },
      },
      required: ['skill'],
    },
  },
];

/* ------------------------------------------------------------------ 小工具 */

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    const text = readFileSync(path, 'utf8').trim();
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function clip(text, max = 400) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 技能 execute 的返回值统一成 { text }。 */
function normalize(result) {
  if (result === undefined || result === null) return { text: '（技能没返回内容）' };
  if (typeof result === 'string') return { text: result };
  if (typeof result === 'object') {
    if (typeof result.text === 'string') return result;
    try {
      return { text: JSON.stringify(result, null, 2) };
    } catch {
      return { text: String(result) };
    }
  }
  return { text: String(result) };
}

/* ------------------------------------------------------------------ 本体 */

export class SkillHostWorld {
  constructor({ cfg, dataDir, persist }) {
    this.id = ID;
    this.cfg = cfg ?? {};
    this.dir = dataDir;
    this.host = null;
    /** 技能 id → { meta, dir, module, tools: Map, error, loadedAt } */
    this.skills = new Map();
    this.loaded = false;
    const write = typeof persist === 'function' ? persist : () => {};
    this.persist = (patch) => {
      try {
        Object.assign(this.cfg, patch);
      } catch { /* 冻结也不影响 */ }
      try {
        write(patch);
      } catch (error) {
        this.host?.log?.warn?.(`skillhost: 配置写不进 ${String(error)}`);
      }
    };
  }

  /* ---------------------------------------------------------- 路径 */

  /** 技能放在哪：设置里的 skillsDir，没设就用 <dataDir>/skills。 */
  skillsDir() {
    const custom = typeof this.cfg?.skillsDir === 'string' ? this.cfg.skillsDir.trim() : '';
    return custom || join(this.dir, 'skills');
  }

  configPath(skillId) {
    return join(this.dir, 'configs', `${skillId}.json`);
  }

  /* ---------------------------------------------------------- 开关 */

  /** 某个技能被关掉了吗：设置里 `skill.<id>` = false 就是关。 */
  isSkillEnabled(skillId) {
    const v = this.cfg?.[`skill.${skillId}`];
    if (v === undefined || v === null) return true;
    if (typeof v === 'string') return !/^(false|0|off|no)$/i.test(v.trim());
    return Boolean(v);
  }

  /** 开关状态的指纹：改了开关也要重新加载。 */
  enableSig() {
    return Object.keys(this.cfg ?? {})
      .filter((k) => k.startsWith('skill.'))
      .sort()
      .map((k) => `${k}=${String(this.cfg[k])}`)
      .join(',');
  }

  setSkillEnabled(skillId, enabled) {
    const key = `skill.${skillId}`;
    this.persist({ [key]: Boolean(enabled) });
    return Boolean(enabled);
  }

  /**
   * 设置页里改的值落在 world 配置里（`skillSetting.<技能 id>.<字段>`），
   * 这样「技能宿主」那一页也能直接改技能设置，不用另开网页。
   */
  cfgOverrides(skillId) {
    const prefix = `skillSetting.${skillId}.`;
    const out = {};
    for (const [key, value] of Object.entries(this.cfg ?? {})) {
      if (!key.startsWith(prefix)) continue;
      const field = key.slice(prefix.length);
      if (!field || field.includes('.')) continue;
      // null = 在设置页里清空了，等于没填，回落给技能自己的文件
      if (value === null || value === undefined) continue;
      out[field] = value;
    }
    return out;
  }

  readConfig(skillId) {
    return { ...readJson(this.configPath(skillId), {}), ...this.cfgOverrides(skillId) };
  }

  /** 技能的设置 = skill.json 里的默认值 + 我这边填的。 */
  settingsOf(entry) {
    const defaults = entry?.meta?.settings && typeof entry.meta.settings === 'object' ? entry.meta.settings : {};
    return { ...defaults, ...this.readConfig(entry?.id ?? '') };
  }

  /* ---------------------------------------------------------- 加载 */

  async start(host) {
    this.host = host ?? null;
    try {
      mkdirSync(this.skillsDir(), { recursive: true });
      mkdirSync(join(this.dir, 'configs'), { recursive: true });
    } catch (error) {
      this.host?.log?.warn?.(`skillhost: 建目录失败 ${String(error)}`);
    }
    await this.reload();
  }

  async stop() {
    for (const entry of this.skills.values()) {
      try {
        entry.module?.deactivate?.();
      } catch { /* 停不了就算了 */ }
    }
    this.skills.clear();
    this.host = null;
  }

  /** 目录里有哪些含 skill.json 的子目录（排序后的名字串，用来判断变没变）。 */
  dirSig() {
    const base = this.skillsDir();
    try {
      return readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(base, d.name, 'skill.json')))
        .map((d) => d.name)
        .sort()
        .join('|');
    } catch {
      return '';
    }
  }

  /** 用户随时可以往目录里丢新技能或删掉旧的：目录一变就重新扫，不用重启。 */
  async syncIfChanged() {
    const sig = this.dirSig() + '#' + this.enableSig();
    if (this.loaded && this.sig === sig) return;
    await this.reload();
  }

  /** 扫一遍 skills 目录，重新加载所有技能。 */
  async reload() {
    this.skills.clear();
    const base = this.skillsDir();
    let names = [];
    try {
      names = readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch (error) {
      this.host?.log?.warn?.(`skillhost: 读不了技能目录 ${base}: ${String(error)}`);
      return;
    }
    for (const name of names) {
      const dir = join(base, name);
      if (!existsSync(join(dir, 'skill.json'))) continue;
      const meta = readJson(join(dir, 'skill.json'), null);
      if (!meta) continue;
      const skillId = String(meta.id || basename(dir));
      // 关掉的技能：只留一条记录给列表看，不 import 它的代码。
      if (!this.isSkillEnabled(skillId)) {
        this.skills.set(skillId, { id: skillId, meta, dir, tools: new Map(), disabled: true });
        continue;
      }
      try {
        await this.loadSkill(dir);
      } catch (error) {
        this.host?.log?.warn?.(`skillhost: 加载 ${name} 失败 ${String(error)}`);
      }
    }
    this.loaded = true;
    this.sig = this.dirSig() + '#' + this.enableSig();
    this.host?.log?.info?.(`skillhost: 装了 ${this.skills.size} 个技能`, {
      skills: [...this.skills.keys()],
    });
  }

  async loadSkill(dir) {
    const meta = readJson(join(dir, 'skill.json'), null);
    if (!meta) throw new Error('skill.json 读不出来');
    const skillId = String(meta.id || basename(dir));
    const entryFile = typeof meta.entry === 'string' && meta.entry ? meta.entry : 'index.js';
    const entryPath = join(dir, entryFile);
    if (!existsSync(entryPath)) throw new Error(`找不到入口 ${entryFile}`);

    // 带时间戳绕过 import 缓存，重新加载时拿到的是新模块。
    const url = `${pathToFileURL(entryPath).href}?v=${Date.now()}`;
    const module = await import(url);

    const registered = [];
    const api = this.makeApi(skillId, meta, registered);

    if (typeof module.setup === 'function') module.setup(api);
    if (typeof module.activate === 'function') module.activate();

    const tools = new Map();
    for (const decl of registered) {
      if (!decl || typeof decl !== 'object') continue;
      const key = String(decl.id || decl.name || '');
      if (!key) continue;
      tools.set(key, decl);
    }

    this.skills.set(skillId, {
      id: skillId,
      dir,
      meta,
      module,
      api,
      tools,
      error: '',
      loadedAt: Date.now(),
    });
  }

  /** 交给技能的那个 api。技能要什么就给什么，拿不到的就给个安全的空实现。 */
  makeApi(skillId, meta, registered) {
    const self = this;
    const warn = (message) => {
      try {
        self.host?.log?.warn?.(`skill ${skillId}: ${clip(message, 200)}`);
      } catch { /* 别因为日志炸掉 */ }
    };
    // 技能里是 `log = api.log` 然后直接 `log('…')`：所以 api.log 本身得能调用，顺便带上 info/warn/error。
    const logFn = (message) => warn(message);
    logFn.info = warn;
    logFn.warn = warn;
    logFn.error = warn;
    logFn.debug = () => {};
    return {
      /** index.js 里是 `config = api.config` 然后 `config()` —— 必须是个函数。 */
      config: () => ({ ...(meta?.settings && typeof meta.settings === 'object' ? meta.settings : {}), ...self.readConfig(skillId) }),
      fetch: (input, init) => globalThis.fetch(input, init),
      warn,
      log: logFn,
      registerTool: (decl) => { if (decl && typeof decl === 'object') registered.push(decl); },
      /** 少数技能会问宿主要这些东西；给个安全的空壳。 */
      registerPromptSection: () => {},
      registerCommand: () => {},
      storage: {
        read: (key) => readJson(join(self.dir, 'configs', `${skillId}.${key}.json`), null),
        write: (key, value) => writeJson(join(self.dir, 'configs', `${skillId}.${key}.json`), value),
      },
      meta: { id: skillId, name: meta?.name ?? skillId, version: meta?.version ?? '' },
    };
  }

  /* ---------------------------------------------------------- 调用 */

  /**
   * 技能的 execute(ctx, args) 要一个 ctx：给最小的、够用的会话壳。
   *
   * 发图走 OneBot 的 HTTP 接口（和 imggen 那边同一个协议端），地址在设置里的 onebotHttp，
   * 默认 http://127.0.0.1:3000。to 是 group:群号 或 private:QQ号，没给就用 defaultTo。
   */
  makeCtx(entry, to, senderId) {
    const self = this;
    const chatKey = String(to || this.cfg?.defaultTo || '').trim();
    // 技能要「本轮是谁提的要求」：私聊就用对方 QQ，群里靠调用方传 senderId。
    const asker = String(senderId || '').trim()
      || (/^private:(\d+)$/.exec(chatKey)?.[1] ?? '')
      || String(this.cfg?.defaultSender || '').trim();
    const log = (message) => {
      try { self.host?.log?.warn?.(`skill ${entry.id}: ${clip(message, 200)}`); } catch { /* 日志别炸 */ }
    };
    const sendImage = async (target, image, options) => {
      const chat = String(target || chatKey || '').trim();
      const m = /^(group|private):(\d+)$/.exec(chat);
      if (!m) {
        return { ok: false, error: `没有可发的地方：to 要写成 group:群号 或 private:QQ号（现在是「${chat}」）` };
      }
      const seg = { type: 'image', data: {} };
      if (image?.dataUrl) {
        seg.data.file = String(image.dataUrl).replace(/^data:[^;,]+;base64,/, 'base64://');
      } else if (image?.file) {
        seg.data.file = String(image.file).replace(/\\/g, '/');
      } else {
        return { ok: false, error: '这张图既没有路径也没有数据' };
      }
      if (options?.note) seg.data.summary = clip(options.note, 40);
      const action = m[1] === 'group' ? 'send_group_msg' : 'send_private_msg';
      const body = m[1] === 'group'
        ? { group_id: Number(m[2]), message: [seg] }
        : { user_id: Number(m[2]), message: [seg] };
      try {
        const res = await self.onebot(action, body);
        if (res?.status === 'ok' || res?.retcode === 0 || res?.data?.message_id) {
          return { ok: true, messageId: res?.data?.message_id, target: chat };
        }
        return { ok: false, error: `协议端没确认：${clip(JSON.stringify(res ?? {}), 200)}` };
      } catch (error) {
        return { ok: false, error: `发不出去：${String(error?.message ?? error)}` };
      }
    };
    /** 发一条文字：技能补作品信息、说明时用。 */
    const sendText = async (target, text) => {
      const chat = String(target || chatKey || '').trim();
      const m = /^(group|private):(\d+)$/.exec(chat);
      if (!m) {
        return { ok: false, error: `没有可发的地方：to 要写成 group:群号 或 private:QQ号（现在是「${chat}」）` };
      }
      const seg = { type: 'text', data: { text: clip(String(text ?? ''), 2000) } };
      const action = m[1] === 'group' ? 'send_group_msg' : 'send_private_msg';
      const body = m[1] === 'group'
        ? { group_id: Number(m[2]), message: [seg] }
        : { user_id: Number(m[2]), message: [seg] };
      try {
        const res = await self.onebot(action, body);
        if (res?.status === 'ok' || res?.retcode === 0 || res?.data?.message_id) {
          return { ok: true, messageId: res?.data?.message_id, target: chat };
        }
        return { ok: false, error: `协议端没确认：${clip(JSON.stringify(res ?? {}), 200)}` };
      } catch (error) {
        return { ok: false, error: `发不出去：${String(error?.message ?? error)}` };
      }
    };
    /** 一次发几条文字：技能里是 `sendTextBatch(chatKey, ['…','…'])`。 */
    const sendTextBatch = async (target, texts) => {
      const list = Array.isArray(texts) ? texts : [texts];
      const results = [];
      for (const item of list) {
        if (!String(item ?? '').trim()) continue;
        results.push(await sendText(target, item));
      }
      return { ok: results.every((r) => r.ok), sent: results.length, results };
    };
    return {
      // 技能会看「本轮有没有发过文字」来拦住直接生图；宿主这边由调用方先说话，
      // 所以这里放一条占位记录，不假装是一次真实的发送。
      session: {
        status: 'active',
        id: `skillhost:${entry.id}`,
        chatKey,
        trigger: asker
          ? [{ id: 1, mid: '1', senderId: asker, self: false, text: '' }]
          : [],
        sent: [{ type: 'text', text: '（宿主占位：调用前已由 Coo 自己回复过）' }],
      },
      selfId: String(this.cfg?.selfId || ''),
      chatKey,
      messages: [],
      config: this.readConfig(entry.id),
      log: Object.assign((message) => log(message), { info: log, warn: log, error: log, debug: () => {} }),
      emit: () => {},
      sender: { sendImage, sendText, sendTextBatch },
      requestMessageId: undefined,
    };
  }

  /** 打 OneBot 的 HTTP 接口。 */
  async onebot(action, body) {
    const base = String(this.cfg?.onebotHttp || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const token = String(this.cfg?.onebotToken || '').trim();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await globalThis.fetch(`${base}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { status: 'error', raw: clip(text, 200) };
    }
  }

  async callTool(skillId, toolKey, args, envelope = {}) {
    await this.syncIfChanged();
    const entry = this.skills.get(skillId) ?? [...this.skills.values()].find((s) => s.meta?.name === skillId);
    if (!entry) {
      const ids = [...this.skills.keys()].join('、') || '（一个都没有）';
      return { text: `没有这个技能：${skillId}。装着的：${ids}`, failed: true };
    }
    if (entry.disabled) {
      return {
        text: `技能 ${entry.id} 现在被关掉了，没加载。要用就先把它的开关打开（设置页里那行，或者 skill_toggle）。`,
        failed: true,
      };
    }
    const decl = entry.tools.get(toolKey) ?? [...entry.tools.values()].find((t) => t.name === toolKey);
    if (!decl) {
      const keys = [...entry.tools.keys()].join('、') || '（没注册任何工具）';
      return { text: `技能 ${entry.id} 里没有工具 ${toolKey}。它有：${keys}`, failed: true };
    }
    if (typeof decl.execute !== 'function') {
      return { text: `工具 ${toolKey} 没有 execute，调不了。`, failed: true };
    }
    try {
      const result = await decl.execute(
        this.makeCtx(
          entry,
          typeof envelope.to === 'string' ? envelope.to : '',
          typeof envelope.senderId === 'string' ? envelope.senderId : '',
        ),
        args && typeof args === 'object' ? args : {},
      );
      return normalize(result);
    } catch (error) {
      const message = error instanceof Error ? `${error.message}` : String(error);
      this.host?.log?.warn?.(`skillhost: ${entry.id}.${toolKey} 出错 ${clip(message, 200)}`);
      return { text: `技能 ${entry.id}.${toolKey} 报错：${clip(message, 400)}`, failed: true };
    }
  }

  /* ---------------------------------------------------------- 三个工具 */

  async listSkills(args = {}) {
    await this.syncIfChanged();
    const want = typeof args.skill === 'string' ? args.skill.trim() : '';
    const lines = [];
    for (const entry of this.skills.values()) {
      if (want && entry.id !== want) continue;
      const meta = entry.meta ?? {};
      const tools = [...entry.tools.values()].map((t) => `${t.id || t.name}（${clip(t.name || '', 20)}）`);
      const settings = this.settingsOf(entry);
      const schema = meta.configSchema && typeof meta.configSchema === 'object' ? meta.configSchema : {};
      const missing = [];
      for (const key of Object.keys(schema)) {
        const decl = schema[key] ?? {};
        const required = /必填/.test(String(decl.label ?? '')) || decl.required;
        const value = settings[key];
        if (required && (value === undefined || value === null || value === '')) missing.push(key);
      }
      lines.push(
        `· ${entry.id}  ${meta.name ?? ''}${meta.version ? ` v${meta.version}` : ''}`
        + (entry.disabled ? '  【已停用，没加载】' : '')
        + `\n  工具：${tools.join('、') || (entry.disabled ? '（停用中）' : '（没注册）')}`
        + (entry.disabled ? '' : (missing.length ? `\n  还缺设置：${missing.join('、')}` : '\n  设置齐了')),
      );
    }
    if (!lines.length) {
      return { text: `技能目录 ${this.skillsDir()} 里还没有技能。把一个技能文件夹（含 skill.json 和 index.js）放进去就行。` };
    }
    return { text: lines.join('\n') };
  }

  configSkill(args = {}) {
    const skillId = String(args.skill ?? '').trim();
    if (!skillId) return { text: '要说是哪个技能。', failed: true };
    const entry = this.skills.get(skillId);
    const meta = entry?.meta ?? null;
    if (args.forget) {
      writeJson(this.configPath(skillId), {});
      // 设置页里的覆盖值也一起清掉，否则清完还是一条都没变
      const cleared = {};
      for (const key of Object.keys(this.cfgOverrides(skillId))) cleared[`skillSetting.${skillId}.${key}`] = null;
      if (Object.keys(cleared).length) this.persist(cleared);
      return { text: `清空了 ${skillId} 的设置。` };
    }
    const patch = args.patch && typeof args.patch === 'object' ? args.patch : null;
    if (!patch || !Object.keys(patch).length) {
      const known = Object.keys(meta?.configSchema ?? {}).join('、') || '（这个技能没写 configSchema）';
      const now = this.readConfig(skillId);
      return { text: `${skillId} 现在填了的：${Object.keys(now).join('、') || '（空）'}\n能填的：${known}` };
    }
    const next = { ...this.readConfig(skillId), ...patch };
    writeJson(this.configPath(skillId), next);
    // 设置页里同名字段也是覆盖值：一起写进 world 配置，两边不会各说各话。
    const overrides = {};
    for (const [key, value] of Object.entries(patch)) overrides[`skillSetting.${skillId}.${key}`] = value;
    this.persist(overrides);
    const shown = Object.keys(patch).map((k) => (/key|secret|token/i.test(k) ? `${k}（已写）` : `${k}=${clip(patch[k], 60)}`));
    return { text: `写进 ${skillId} 的设置：${shown.join('，')}` };
  }

  tools() {
    const byName = new Map(TOOLS.map((decl) => [decl.name, decl]));
    const make = (name, handler) => ({ ...byName.get(name), handler });
    return [
      make('skill_list', (args) => this.listSkills(args)),
      make('skill_call', (args) => this.callTool(
        String(args?.skill ?? '').trim(),
        String(args?.tool ?? '').trim(),
        args?.args,
        args ?? {},
      )),
      make('skill_config', (args) => this.configSkill(args)),
      make('skill_toggle', (args) => this.toggleSkill(args)),
    ];
  }

  /** 关掉 / 打开一个技能。关掉的技能不加载，重新打开后下一次调用就会加载。 */
  async toggleSkill(args = {}) {
    await this.syncIfChanged();
    const want = String(args?.skill ?? '').trim();
    if (!want) return { text: '要关哪个技能？给个技能 id（skill_list 里有）。', failed: true };
    const entry = this.skills.get(want) ?? [...this.skills.values()].find((s) => s.meta?.name === want);
    if (!entry) {
      const ids = [...this.skills.keys()].join('、') || '（一个都没有）';
      return { text: `没有这个技能：${want}。装着的：${ids}`, failed: true };
    }
    const enabled = args?.enabled === undefined ? false : Boolean(args.enabled);
    this.setSkillEnabled(entry.id, enabled);
    await this.reload();
    return {
      text: enabled
        ? `打开了 ${entry.id}，已经重新加载。`
        : `关掉了 ${entry.id}：不再加载，工具也调不了；设置和文件都留着，随时能打开。`,
    };
  }

  envPromptVars() {
    return {};
  }

  /* ---------------------------------------------------------- 设置页 */

  /**
   * 设置页里那块面板：几个灯、每个技能一枚徽章、一份能直接改的设置表单。
   * 技能目录是现扫的，不依赖技能有没有被加载过；工具数量要加载过才知道。
   */
  webUi(language = 'zh') {
    const en = String(language).toLowerCase().startsWith('en');
    const dir = this.skillsDir();

    const rows = [];
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'skill.json')))
        .map((d) => {
          // 分页按「装的先后」排：用目录的创建时间，时间一样再按名字。
          let born = 0;
          try {
            const st = statSync(join(dir, d.name));
            born = st.birthtimeMs || st.mtimeMs || 0;
          } catch { born = 0; }
          return { id: d.name, born };
        })
        .sort((a, b) => (a.born - b.born) || a.id.localeCompare(b.id))
        .map((e) => e.id);
    } catch {
      entries = [];
    }

    const missing = [];
    for (const id of entries) {
      const meta = readJson(join(dir, id, 'skill.json'), {}) || {};
      const loaded = this.skills.get(id);
      const schema = meta.configSchema && typeof meta.configSchema === 'object' ? meta.configSchema : {};
      const now = this.readConfig(id);
      for (const key of Object.keys(schema)) {
        const decl = schema[key] ?? {};
        const required = /必填/.test(String(decl.label ?? '')) || decl.required;
        const value = now[key];
        if (required && (value === undefined || value === null || value === '')) missing.push(`${id}.${key}`);
      }
      rows.push({
        id,
        name: String(meta.name || id),
        version: String(meta.version || ''),
        tools: loaded ? loaded.tools?.size ?? 0 : null,
        enabled: this.isSkillEnabled(id),
      });
    }

    const FIELD_META = {
      skillsDir: [en ? 'Skills folder' : '技能目录', en ? 'Empty = <data>/skills.' : '留空就用数据目录里的 skills。'],
      onebotHttp: ['OneBot HTTP', en ? 'Protocol side address.' : '协议端地址，默认 http://127.0.0.1:3000。'],
      onebotToken: ['OneBot Token', en ? 'Only if the protocol side needs one.' : '协议端要鉴权时才填，留空表示不用。'],
      defaultTo: ['默认发送目标', en ? 'group:<id> or private:<qq>' : 'group:群号 或 private:QQ号，技能没指定去处时用它。'],
      selfId: ['自己的 QQ', en ? 'To tell own messages apart.' : '群里判断哪条是自己发的，填机器人自己的 QQ。'],
    };
    const defaults = WORLDDEF.defaults();
    // 字段不进 contribution.config：那样 Coopanion 会在分页条末尾自动多出一个「配置」页，
    // 跟本页第一个分页重复。清单在内存里备好，invoke('group') 直接交给面板画。
    const baseFields = [];
    for (const [key, value] of Object.entries(defaults)) {
      if (typeof value !== 'string') continue;
      const [title, description] = FIELD_META[key] ?? [key, ''];
      baseFields.push({
        key: 'worlds.' + ID + '.' + key,
        title,
        type: 'string',
        description,
        default: key === 'skillsDir' ? dir : value,
      });
    }

    // 每个技能一页：第一行是它的开关，往下是它自己的设置。
    // 这里只备好每页的字段清单，交给 invoke('group') 用；不再生成 contribution.config。
    const skillTabs = rows.map((r) => {
      const meta = readJson(join(dir, r.id, 'skill.json'), {}) || {};
      const schema = meta.configSchema && typeof meta.configSchema === 'object' ? meta.configSchema : {};
      const effective = this.settingsOf({ id: r.id, meta });
      const fields = [{
        key: `worlds.${ID}.skill.${r.id}`,
        type: 'boolean',
        title: en ? 'Enabled' : '启用',
        description: en
          ? `Off = not loaded (its tools go away). Files and settings stay. id: ${r.id}`
          : `关掉就暂时不加载这个技能，它的工具也调不了；文件和设置都留着。id：${r.id}`,
        default: r.enabled,
      }];
      for (const [key, decl] of Object.entries(schema)) {
        const current = effective[key];
        const type = decl?.type === 'boolean' || typeof current === 'boolean'
          ? 'boolean'
          : (decl?.type === 'number' || typeof current === 'number' ? 'number' : 'string');
        fields.push({
          key: `worlds.${ID}.skillSetting.${r.id}.${key}`,
          type,
          title: String(decl?.label || key),
          description: String(decl?.description || (en ? `Setting of ${r.id}` : `技能 ${r.id} 的设置`)),
          default: current === undefined || current === null
            ? (type === 'number' ? 0 : (type === 'boolean' ? false : ''))
            : current,
        });
      }
      const toolCount = typeof r.tools === 'number' ? r.tools : null;
      return {
        id: `world:${ID}:${r.id}`,
        title: r.name + (r.version ? ' v' + r.version : ''),
        description: (en ? `From ${r.id}` : `来自 ${r.id}`)
          + (toolCount === null ? '' : (en ? `, ${toolCount} tools.` : `，${toolCount} 个工具。`))
          + (r.enabled ? '' : (en ? ' Currently off.' : ' 现在是关的。')),
        fields,
      };
    });

    const badges = rows.map((r) => ({
      label: r.name + (r.version ? ' v' + r.version : '') + (r.enabled ? '' : (en ? ' (off)' : '（停用）')),
      value: typeof r.tools === 'number' ? r.tools : 0,
      tone: 'plain',
    }));

    const contribution = {
      label: en ? 'Skill host' : '技能宿主',
      lamps: [
        {
          label: en ? 'Skills' : '技能',
          state: rows.length ? 'online' : 'offline',
          hint: rows.length
            ? rows.map((r) => r.name).join('、')
            : (en ? 'Nothing in ' + dir : `${dir} 里还没有技能`),
        },
        {
          label: en ? 'Settings' : '设置',
          state: missing.length ? 'offline' : 'online',
          hint: missing.length
            ? (en ? 'Missing ' : '还缺 ') + missing.join('、')
            : (en ? 'All set' : '该填的都填了'),
        },
        {
          label: en ? 'Protocol side' : '协议端',
          state: 'online',
          hint: String(this.cfg?.onebotHttp || 'http://127.0.0.1:3000'),
        },
      ],
      badges,
      links: [{ label: en ? 'Open skills folder' : '打开技能目录', href: pathToFileURL(dir).href }],
      // 每个面板就是设置页顶上的一个分页：第一个是本体，后面每个技能一页（按装的先后）。
      panels: [
        { id: 'base', title: en ? 'Skill host' : '技能宿主' },
        ...rows.map((r) => ({
          // 面板 id 只准小写字母、数字和连字符（框架会丢掉不合法的），所以技能 id 里的怪字符换成连字符。
          id: 'skill-' + String(r.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
          title: r.name + (r.version ? ' v' + r.version : ''),
        })),
      ],
    };

    // 本体那一页的标题/说明/字段：面板自己渲染，不走 contribution.config。
    const baseGroup = {
      id: 'world:' + ID + ':base',
      title: en ? 'Skill host' : '技能宿主',
      description: (rows.length
        ? (en
          ? `${rows.length} skill${rows.length > 1 ? 's' : ''}, one tab each: `
          : `装了 ${rows.length} 个技能，各占一个分页：`)
        + rows.map((r, i) => `${i + 1}. ${r.name}${r.version ? ' v' + r.version : ''}`
          + (typeof r.tools === 'number' ? (en ? ` (${r.tools} tools)` : `（${r.tools} 个工具）`) : '')
          + (r.enabled ? '' : (en ? ' (off)' : '（停用）')))
          .join(en ? ', ' : '、')
        + (missing.length ? (en ? `. Missing: ${missing.join(', ')}` : `。还缺设置：${missing.join('、')}`) : '')
        + (en ? '. ' : '。')
        : (en ? 'No skills yet. ' : '还没有技能。'))
        + (en
          ? 'This tab is the host itself; each skill has its own tab.'
          : '这一页是本体：技能放在哪、发去哪；每个技能自己的开关和设置在它自己的分页里。'),
      fields: baseFields,
    };

    // 面板的数据面：WebUI 只把 HTTP 请求翻成一次 (panel, method, args) 调用，
    // 不声明 invoke 的话，整页只会显示「没有面板数据面」，mount 都不会跑。
    const shortKey = (key) => {
      const s = String(key ?? '');
      const prefix = `worlds.${ID}.`;
      return s.startsWith(prefix) ? s.slice(prefix.length) : s;
    };
    const groupOf = (id) => ((!id || id === baseGroup.id) ? baseGroup : skillTabs.find((g) => g.id === id));

    contribution.invoke = async (panel, method, args) => {
      const list = Array.isArray(args) ? args : [];
      if (method === 'group') {
        const g = groupOf(list[0]);
        if (!g) throw new Error('没有这一组配置：' + String(list[0]));
        const fields = (g.fields ?? []).map((f) => {
          const raw = this.cfg?.[shortKey(f.key)];
          return {
            key: f.key,
            title: f.title ?? f.key,
            type: f.type ?? 'string',
            description: f.description ?? '',
            value: raw === undefined || raw === null ? f.default : raw,
          };
        });
        return { title: g.title ?? '', description: g.description ?? '', fields };
      }
      if (method === 'skillsDir') {
        // 面板上要显示「解压到哪个文件夹」，直接问技能宿主自己，别在页面上猜。
        return { path: this.skillsDir() };
      }
      if (method === 'reload') {
        // 面板按 4 秒轮询目录，发现新技能/卸载过就喊一声：重载一遍，工具才会真的出现。
        await this.reload?.();
        return { ok: true };
      }
      if (method === 'skills') {
        return {
          title: en ? 'Skills' : '技能',
          desc: en
            ? 'Switch a skill on or off next to its name. Off = not loaded; files and settings stay.'
            : '开关就在名字旁边。关掉只是不加载，文件和设置都留着。',
          items: rows.map((r) => ({
            id: r.id,
            name: r.name,
            version: r.version,
            tools: typeof r.tools === 'number' ? r.tools : null,
            enabled: this.isSkillEnabled(r.id),
          })),
        };
      }
      if (method === 'toggle') {
        const id = String(list[0] ?? '');
        if (!rows.some((r) => r.id === id)) throw new Error('没有这个技能：' + id);
        const on = Boolean(list[1]);
        this.setSkillEnabled(id, on);
        try { await this.reload?.(); } catch { /* 重载失败不影响开关本身 */ }
        return { ok: true, id, enabled: on };
      }
      if (method === 'uninstall') {
        // 面板上的「卸载」：删掉技能目录里的这个文件夹。名字只当目录名用，不许带路径。
        const id = String(list[0] ?? '').trim();
        if (!id || /[\\/]/.test(id) || id === '.' || id === '..') throw new Error('技能名不合法：' + id);
        if (!rows.some((r) => r.id === id)) throw new Error('没有这个技能：' + id);
        const root = this.skillsDir();
        const target = join(root, id);
        if (!existsSync(join(target, 'skill.json'))) {
          throw new Error('这个文件夹里没有 skill.json，不当成技能删。');
        }
        rmSync(target, { recursive: true, force: true });
        try { await this.reload?.(); } catch { /* 重载失败不影响删除本身 */ }
        return { ok: true, id, removed: target };
      }
      if (method === 'save') {
        const key = shortKey(list[0]);
        if (!key) throw new Error('缺字段名');
        this.persist({ [key]: list[1] });
        return { ok: true, key, value: list[1] };
      }
      throw new Error('不认识的方法：' + String(method));
    };

    return contribution;
  }
}

/* ------------------------------------------------------------------ 交给加载器 */

const WORLDDEF = {
  id: ID,
  label: '技能宿主',
  defaults: () => ({
    skillsDir: '',
    onebotHttp: 'http://127.0.0.1:3000',
    onebotToken: '',
    defaultTo: '',
    selfId: '',
  }),
  create: (ctx) => new SkillHostWorld({
    cfg: ctx?.cfg ?? {},
    dataDir: join(ctx?.dataDir ?? '.', ID),
    persist: (patch) => ctx?.persist?.(patch),
  }),
  describe: {
    tools: TOOLS.map((decl) => ({
      name: decl.name,
      tags: decl.tags,
      parameters: decl.parameters,
      description: decl.description,
    })),
    events: [],
  },
};

export default WORLDDEF;
export { WORLDDEF };
