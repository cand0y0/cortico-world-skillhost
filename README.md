# 技能宿主（cortico-world-skillhost）

> 把 OmniAgent 的技能包丢进一个目录，填好 Key，它自己变成我能调用的工具。
> Drop an OmniAgent skill folder into one directory, fill in its key, and the skill's tools become mine.

Coopanion / Cortico 的 World 扩展（`cortico.kind = "world"`，api 6）。

## 它解决什么

Coopanion 的技能（skill）本来是按包分发的：一个文件夹，里面 `skill.json` 声明工具，`index.js`
用 `api.registerTool()` 把工具注册给宿主。这种包只有**会话助手**那边认。

这个 World 把同一套约定再实现一遍：在 World 里扫目录、加载技能的 `index.js`、喂给它一套
`config / fetch / warn / registerTool / storage` 的 api，然后把注册出来的工具转成四个通用工具。
于是同一个技能包，不写一行 World 代码，也能被我当成工具调用。

## 安装

**从市场**：Coopanion 设置 → World 扩展 → 按名字搜「技能宿主」/ `cortico-world-skillhost`。

**手动**（开发时）：

```bash
# 放进 Coopanion 的扩展目录
mkdir -p "<Coopanion>/data/extensions/node_modules/cortico-world-skillhost"
xcopy /E /I /Y . "<Coopanion>\data\extensions\node_modules\cortico-world-skillhost"
```

然后在 `data/extensions/package.json` 的 `dependencies` 里加
`"cortico-world-skillhost": "0.1.0"`，在 `world-owners.json` 里加 `"skillhost": "cortico-world-skillhost"`，
整只重启 Coopanion（World 和工具是启动时装配的，光在页面上关掉再打开不够）。

## 技能放哪

默认是 `<数据目录>/skillhost/skills/<技能 id>/`，也可以在设置里改「技能目录」。一个技能的形状：

```
skills/
  ai-image/
    skill.json     id / name / version / apiVersion / capabilities / settings / configSchema
    index.js       ES module：export setup(api) / activate() / deactivate() / available()
    lib/…          技能自己的模块
```

目录一变就自动重扫（比对目录与开关的指纹），**新技能丢进去不用重启**。

技能包从哪来：OmniAgent 市场 <https://kondius.cn/OmniAgent/market.html?type=skills>，
下载的 ZIP 解开就是一个技能文件夹。设置页顶部有直达按钮。

## 工具

| 工具 | 干什么 |
| --- | --- |
| `skill_list` | 列出已装的技能、各自的工具、哪些设置项还空着。不确定工具名/参数时先调它。 |
| `skill_call` | `{skill, tool, args, to?, senderId?}` 调技能里的某个工具。`to` 是 `group:群号` / `private:QQ号`，不填用默认发送目标；群里发起时填 `senderId`，技能靠它认人、算额度。 |
| `skill_config` | `{skill, patch, forget?}` 写这个技能的设置（apiKey / baseUrl / 模型…），合并写入 `<数据目录>/configs/<技能 id>.json`，下一次调用就生效。`forget: true` 清空。 |
| `skill_toggle` | `{skill, enabled}` 临时停用/恢复一个技能。停用只是不加载它的 `index.js`，文件与设置都留着。 |

## 设置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `skillsDir` | 空 = `<数据目录>/skillhost/skills` | 技能目录 |
| `onebotHttp` | `http://127.0.0.1:3000` | 技能要发消息时走的 OneBot HTTP，和 QQ 扩展同一个协议端 |
| `onebotToken` | 空 | 协议端要鉴权时填 |
| `defaultTo` | 空 | 技能没指定去处时的默认目标 |
| `selfId` | 空 | 机器人自己的 QQ，群里用来区分哪条是自己发的 |
| `skill.<技能 id>` | `true` | 单个技能的开关，设置页每个技能一页，标题行右边就是它 |

设置页（World 扩展 → 技能宿主）分页：第一页是本体（市场入口、已装技能管理、上面五项设置），
之后每个技能一页，只有它自己的设置 + 启用开关 + 卸载。

## 设置页概览

- 顶部灯：技能数量与名字、缺哪些必填项、协议端地址。
- 徽章：每个技能一枚，`名字 v版本`，值是加载后的工具数（没加载过是 0）。
- 已装技能行：名字、`v版本 · 已启用/已关掉 · N 个工具`、启用开关、卸载。

## 安全与已知限制

- **技能是代码**。加载技能等于在 Coopanion 进程里执行它的 `index.js`，能读到你的设置（含 Key）、能发网络请求。
  只装你信任来源的技能，别装来路不明的 ZIP。
- 技能拿到的 `ctx` 是安全空壳的补齐版：`session` / `trigger` / `sent` / `selfId` / `sender.sendImage()` 都接上了，
  但别指望技能能拿到完整的聊天历史或记忆——缺的会抛错，错误原样回给调用方，不会把 World 弄崩。
- 发图依赖 OneBot 协议端（`onebotHttp`）。协议端没起来时，图能生成但发不出去，回执会直说。
- `describe.json` 是手写的清单，改了 `src/index.js` 里的 `TOOLS` 要同步改它。

## 开发

纯 JS，无构建，无依赖。Node ≥ 22。

```bash
node --check src/index.js            # 语法
node ../../test-skillhost.mjs        # 离线自测（在 Coopanion 的 node 上跑）
```

自测会先把一个技能复制进 `testdata/skills`，再依次跑 `skill_list` / `skill_config` /
`skill_call`（用假 Key，收到 401 就说明配置、ctx、fetch 全接上了）。

## 许可

MIT
