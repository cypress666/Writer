# Inkforge

**面向长篇连载的小说创作工作台。** 把「设定」从正文里抽出来做成可核对的事实源，让每一章在写的时候就对着它校验，而不是等写完三百万字才发现人物崩了。

Electron + Vue 3 + TypeScript，单机运行，数据全在本机 SQLite 文件里。中文 / 英文双语界面。

---

## 为什么不是又一个编辑器

Word 和 Typora 只管文字，不管「设定是否自洽」；AI 写作工具大多直接吐正文，出来的东西你不敢定稿。中间缺一层：**把作者脑子里那套事实显式建模，并且能对每一章做确定性校验**。

Inkforge 的做法：

- **单一事实源**：角色状态、伏笔、世界规则、时间线、资源集中管理。状态按「生效章」取值，补写中间章不会读到后文状态
- **三层检查，责任分明**：本地确定性门禁可以阻断定稿；事实源审计报错时按阻断处理；AI 审稿只产观察，**永远不参与阻断**
- **AI 是增强不是主体**：生成走逐段裁决，不直接覆盖正文；旧稿反推产出候选清单，勾选后才写入
- **百万字可用**：抽样策略、分段装配、章节级事实切片，避免把整本书塞进上下文

## 功能一览

| 模块 | 能做什么 |
| --- | --- |
| 书架 / 工作台 | 多作品管理，卷章树，拖拽重排（同卷内），全文搜索书名与总纲 |
| 编辑器 | 正文写作、章纲声明（目标字数 / Strand / 钩子类型 / 出场角色 / 情绪标签）、草稿与定稿、导出单章 MD |
| AI 起草 | 装配事实切片生成新稿，段落级差分，逐段裁决后写入，可中途取消 |
| 检查报告 | 门禁（字数、伏笔证据词、钩子轮换、重复用语、AI 痕迹）+ 事实源审计 + LLM 审稿 |
| 事实源 | 角色 / 伏笔 / 规则·时间线·资源 / 大纲·分卷·定稿收据 / 状态快照 / AI 反推 |
| 题材规则集 | 玄幻 / 仙侠 / 悬疑 / 都市 / 恐怖 / 通用，按题材升降门禁与审计的严格度 |
| 全书检索 | BM25 + 向量混合检索，无 Embedding 模型时自动退化为纯 BM25 |
| 导入 | TXT / Markdown / Obsidian 仓库 / 粘贴，识别「第 N 章」「Chapter N」「# 标题」，只追加不覆盖 |
| 导出 | TXT（可直接投稿）/ 可读 Markdown / 含事实源表格的归档版 |
| 数据 | 手动备份书库、打开数据目录、快照回退（只回退事实，不动正文） |
| 界面 | 中英文切换，原生菜单同步重建 |

## 快速开始

```bash
pnpm install
pnpm dev        # 开发模式
pnpm start      # 构建后启动，接近发布形态
```

Windows 上也可以双击 `一键启动 Inkforge.vbs`（无控制台窗口）或 `一键启动（显示日志）.bat`。

**第一次打开建议按这个顺序试**：新建作品 → 导入一部旧稿（TXT / Obsidian 仓库都行）→ 事实源 → AI 反推 → 逐章检查 → 定稿 → 导出。完整操作流程、报告读法、疑难排查见 **[docs/USAGE.md](docs/USAGE.md)**（应用内菜单「帮助 → 使用说明」也会打开它）。

## 架构

```
electron/            主进程：窗口、原生菜单、IPC 注册、preload
  main.ts            应用生命周期与全部 IPC handler
  menu.ts            中英双语原生菜单（不设菜单会回落成英文默认菜单）
  preload.ts         contextBridge 暴露 window.api

src/
  shared/            IPC 契约与领域类型（主进程 / 渲染层共用）
  domain/            领域模型；genres.ts 是题材规则集与严格度升降级
  db/                node:sqlite 存储层（better-sqlite3 风格适配器）、仓储、快照
  gates/             本地确定性门禁：字数 / 伏笔 / Strand / 节奏 / 重复用语 / AI 痕迹
  audit/             事实源审计：人物一致性、逻辑、地点、能力越界…
  assembly/          上下文装配：事实切片 + 章纲 + 线索任务
  ai/                供应商适配（OpenAI 兼容 / Anthropic / Ollama）、密钥加密存储、差分
  retrieval/         全文检索与向量召回
  import/            稿件解析与拆章（含 Obsidian 仓库）
  projection/        Markdown 投影与可读导出
  renderer/          Vue 3 界面；i18n/ 为中文原文做 key 的轻量词表
```

**关键设计取舍**

- **门禁只做确定性判定**。任何需要「判断」的事情都归 AI 审稿，且不阻断。这条边界不是洁癖——它保证了「今天能定稿的稿子，换个模型明天还是能定稿」
- **`node:sqlite` 而不是 better-sqlite3**。Electron 内置 Node 22 自带 SQLite，省掉原生模块编译与 ABI 对齐；`sqlite.ts` 提供了 better-sqlite3 风格的薄适配层，日后要换实现只改一个文件
- **i18n 用中文原文当 key**。省掉给六百条文案起 key 名的成本，漏译自动回落中文；`tests/i18n.test.ts` 扫描所有 `t('…')`，缺译即测试失败
- **语言默认中文**，不按 `navigator.language` 自动判断——这是给中文作者的工具，不该在英文系统上突然变成英文

## 测试

```bash
pnpm gate       # tsc + vue-tsc + vitest（138 项）
pnpm build
pnpm smoke      # 主进程能否启动、IPC 是否连通
pnpm ui-audit   # CDP 驱动真实界面：点按钮、走 IPC、验渲染
```

`tests/layering.test.ts` 守着分层依赖方向，`tests/snapshot-boundary.test.ts` 守着「快照只回退事实不动正文」这条边界，`tests/ollama-provider.test.ts` 锁死「必须走 `/api/chat` 且带 `num_ctx`」——这几条都是踩过坑之后补的护栏，不是形式主义。

## 数据位置

`%APPDATA%\inkforge-core\workbench\`

```
inkforge.db      全部作品、章节、事实源
ai-config.json   模型配置（密钥经系统加密后单独存放，此处只有引用 id）
backups/         手动备份
```

整目录拷走即可迁移；密钥跟系统绑定，换机器需重填 API Key。

## 状态

个人项目，核心闭环已跑通：建书 / 导入 / 反推 / 写作 / 检查 / 定稿 / 导出 / 备份。免安装 EXE 打包与新手示例作品还在路上。

## License

MIT
