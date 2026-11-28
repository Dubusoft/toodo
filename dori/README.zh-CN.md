[English](README.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md)

<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

# omo-dori-mode-experimental

Dori 模式把一个编程智能体会话变成常驻的消息智能体。你在 Toodo 网页应用的 Toodo 聊天里和 Dori 对话。Dori 把每件事交给 hc 终端里单独启动的智能体会话，记住自己启动过的每个会话，只有在工作真正完成后才关闭它:PR 已合并、issue 已关闭、版本已发布。

它由一个技能(`skills/dori-mode/SKILL.md` 和 references)以及一个用 bun + TypeScript 写的小 CLI `dori` 组成。目前还是实验版本，会有不完善的地方。

## 安装

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Dubusoft/toodo/main/dori/install.sh)"
```

它会匿名把公开仓库 Dubusoft/toodo(Dori 位于其 `dori/` 目录)克隆到 `~/.dori/src`,把技能链接到 `~/.agents/skills/dori-mode`,用 `bun link` 把 `dori` 放进 PATH,然后启动 `dori setup`。如果你的智能体从别的目录加载技能，请设置 `SKILLS_DIR`。

`dori setup` 会询问新的 GitHub issue 是否自动开工，需要的话还会安装 systemd 用户单元，让 hc 核心和 supervisor 开机自启(`--advanced` 还会询问模型、目录和其他键);每个系统级步骤都会先询问。可以随时重新运行：当前值就是默认值，按回车保留。通过管道交给 bash 安装时没有终端可以提问，只会打印提示，请自己运行 `dori setup`。脚本用法:`dori setup --yes [--autostart]`。

然后打开智能体，说一句 "Dori mode" 就行。

## 依赖

- [bun](https://bun.sh) 1.3 或更新版本，以及 git
- hc(herdr-core):主控和各条 lane 运行的无界面终端运行时(`curl -fsSL https://releases.herdr.dev/core/install.sh | sh`)
- 能加载技能的编程智能体(按 [OmO](https://github.com/code-yeongyu/oh-my-openagent) 设计，启动命令可以在配置里改)
- 用来确认 PR 合并和 issue 关闭的 `gh`(GitHub CLI),以及确认已发布版本的 `npm`

主机监控在 macOS 上功能完整。在 Linux 上只看负载和磁盘，内存和 swap 显示为未知。

## 第一次运行

从零到完成第一件工作:

1. **运行 toodo-server。** 在主机上启动 toodo-server 并打开它的网页应用，里面的 Toodo 聊天就是和 Dori 对话的地方。
2. **安装 hc**,然后运行上面的一行安装命令。
3. **检查安装**:`dori doctor` 逐项显示 OK、WARN 或 FAIL,失败的项目会给出具体的修复方法。
4. **开启**:在 `dori-lead` 窗格里启动编程智能体，说一句 "Dori mode"。Dori 会问你怎么称呼它，在 Toodo 聊天里跟你打招呼，并提议做 onboarding。
5. **交给它一件工作**:在 Toodo 聊天里写，比如 "修一下 acme/app README 里的错别字并开个 PR"。它会在 hc 里开一条 lane,在任务帖子里汇报进度，PR 合并后关闭这条 lane。

包括监控和开机自启在内的完整设置说明见 [`references/setup.md`](skills/dori-mode/references/setup.md)。

## 给你的 Dori 起名

Dori 第一件事就是问你该怎么称呼它。直接叫 "Dori" 可以，用 Dori 结尾的名字也可以，比如 ShipDori 或 WorkDori,同时运行好几个时更好区分。定下的名字会用在消息落款和模式名上，下次只要说一句 "ShipDori mode" 就能重新开启。

## Dori 怎么说话

Dori 会跟着你的说话方式走。你写得简短、随意、用小写，它也这样回。无论用哪种语言，它都不用表情符号。一条回复有好几部分时，它会拆成几条短消息发，而不是一大段;每条准备好就立刻发，不故意停顿。唯一的例外是不断变化的进度：那始终是一条消息，原地修改。

## 配置

所有配置都在 `~/.dori/config.json` 里，每一项都可以省略。通常需要设置的是这些:

| 字段 | 含义 |
|---|---|
| `leadCwd` | lane 的起始目录，也是 lane 创建 worktree 的仓库 |
| `agentCommand` | 启动智能体的命令，写成含 `{model}` 和 `{prompt}` 的 argv 列表 |
| `hooks.threadReply` | 你的消息 CLI,写成含 `{thread}` 和 `{text}` 的 argv 列表，用来发布 lane 进度 |

其余项(时间、阈值、heavy 槽位数)用默认值就够了。完整表格见 [`references/scripts.md`](skills/dori-mode/references/scripts.md)。环境变量 `DORI_CONFIG`、`DORI_STATE_DIR`、`DORI_LEAD_PANE` 优先于配置文件。

主控的 pane 不在配置里设置：缺失时由 supervisor 打开 hc 终端 `dori-lead`,并记录在 `<stateDir>/herdr-panes.json`。旧配置里的 `leadPane` 只会被迁移一次，之后忽略。残留的 `leadRuntime` 键会被忽略,`dori setup --migrate` 会删除它以及本机 runner 的 `runner-config.json` 里的 `laneRuntime`。终端运行时只有 hc。

## 初次了解(Onboarding)

第一次设置时,Dori 在读取你的任何东西之前，会先征求同意：能不能了解一下你用哪些工具、在做什么、为什么做，以及你和你的公司是什么样的。只有你同意了，它才会一个一个地查看你的工具。每个工具它都会先说明要用哪个集成、会读取什么，再单独问你。比如:"有一个能读取 Gmail 和日历的 CLI,我想用它帮你留意日程和邮件，可以吗?"你拒绝的工具会被跳过，它也会记住你拒绝过。

整个过程只读不写。它边看边把了解到的内容写进记忆，最后简短地告诉你它了解了什么、还缺什么。完整流程见 [`references/onboarding.md`](skills/dori-mode/references/onboarding.md)。

## 怎么处理一个请求

每条消息怎么处理，由 Dori 自己决定。

- 提问、查状态、查资料，以及几次工具调用就能完成的小改动，直接处理，不开新会话。
- 最终要提交 PR 的代码工作、多步骤的工作、耗时长或可以并行的工作，开一条 lane。如果已经有一条空闲的 lane 负责这个仓库，就交给它，不再新开。
- 内存、磁盘或 pane 数量不够时(`dori can-launch` 显示 HOLD),不开新 lane。工作先排队，并告诉你原因。
- 新的工作开新的线程。后续的跟进回到原来的线程，如果那条 lane 已关闭，就重新打开记录下来的会话。简单的问题在哪里问的就在哪里答。

## 会话登记表

每条 lane 在 `~/.dori/state/lanes/` 下有一个 JSON 文件。它把消息线程对应到 hc pane,把 pane 对应到智能体自己的会话 id,并记录状态(`working`、`done-claimed`、`verified-done`、`not-done`、`closed`)以及每次变化的历史。

`dori sync` 会把登记表和实际在运行的 pane 对照，告诉你哪里对不上：消失的 pane、变了的会话 id、没有办法证明已完成的 lane。它不会删除任何东西。加上 `--write` 会把找到的会话 id 存下来。

## 5 分钟完成流程

lane 声明自己已完成:

```sh
dori claim-done fix-login --evidence "merged acme/app#412 (a1b2c3d)"
```

Dori 收到 `LANE_DONE_CLAIMED`,lane 会被告知 5 分钟后关闭。这期间你可以提出异议:

```sh
dori object-done fix-login --reason "缺少 changelog 条目"
```

理由会原样发给 lane,lane 修好后再次声明完成。如果没人反对，时间一到 `dori watch` 就会关闭这条 lane。关闭前它会重新实时读取每个 `Done =` 信号；如果 worktree 里还有没推到远端的提交或未提交的改动，它就不关闭，声明会带着原因退回 not-done。重启 watcher 不会让 5 分钟重新计时。

### 怎样才算完成

lane 的 `Done =` 行写的是 watcher 能自己检查的信号:
- PR 已合并
- issue 已关闭
- 包的版本已发布
- 对于不以 PR 结束的工作(本地设置、QA、运行中的服务):退出码为 0 的命令、哈希或 JSON 字段符合预期的文件、返回预期状态码和内容的 URL

```
Done = command ["bun","test"] stdout~" 0 fail"; file qa/report.json json:.passed=true; url http://localhost:3000/health body~"ready"
```

关闭 lane 时,watcher 会自己重新运行这些检查，不经过 shell,也从不凭 lane 自己的说法就算数。无法解析的信号在启动 lane 时就会被拒绝。完整语法见 [`references/sessions.md`](skills/dori-mode/references/sessions.md)。

## 命令

| 命令 | 作用 |
|---|---|
| `dori launch <key> ...` | 在 brief 里写入 lane footer,打开标签页，启动智能体，检查启动错误 |
| `dori adopt <key> --pane ID ...` | 登记一条已经在运行的 lane |
| `dori sync [--write]` | 对照登记表和实际 pane,列出不一致 |
| `dori claim-done` / `object-done` / `close` | 完成流程 |
| `dori pause` / `resume` | 所有者说"等一下"时:不再提醒、暂停目标、停止正在运行的回合;以及恢复 |
| `dori watch` | 自动关闭的 watcher,作为常驻监控运行 |
| `dori freshness [--loop MIN]` | 提醒变安静的 lane,提醒后仍无动静就上报给 lead,再把它最后一条汇报发到线程里 |
| `dori dead-panes [--loop MIN]` | 报告已停止的智能体 pane |
| `dori guard [--loop MIN]` | 负载、内存、磁盘和 pane 数量告警，也按 runner 机器 (基于 runner 采样，`dori status` 中显示) |
| `dori heavy <label> -- <cmd>` | 只在有空闲槽位且负载低时运行构建、测试或模拟器 (每台机器一个) |

发给 pane 的文字总是作为一个参数传入，从不经过 shell 字符串，并把每次发送报告为已送达或未确认。

## 实用工具

CLI 还带有 Dori 需要的消息相关功能，也可以作为 `scripts/src/messenger/` 下带类型的模块直接引用。

| 命令 | 作用 |
|---|---|
| `dori send --to REF\|alerts --text X [--file PATH ...]` | 在 Toodo 聊天里发消息(`--to alerts` 是默认房间)。含有 `$(` 的文字会被拒绝 |
| `dori typing REF [--off]` | 在 Toodo 聊天的频道或帖子里显示或关闭"正在输入" |
| `dori transcribe <file>` | 用 `hooks.transcribe` 的命令把语音消息转成文字 |
| `dori can-launch` | 看看还有没有余量再开一条 lane |

没有对应命令、但模块里提供的功能:
- `typingWhile`:工作进行时一直显示"正在输入"

## 测试

CI 只做类型检查,测试在本地运行:

```sh
cd skills/dori-mode/scripts
bun install
bun test           # 用假的 hc、git、gh 验证行为
bunx tsc --noEmit  # 类型检查
```

测试不会碰真实的 pane、仓库或 GitHub。

## 许可证

Dori 模式是 Toodo 的一部分,与 Toodo 采用相同的
[GNU Affero General Public License v3.0 only](../LICENSE)(`AGPL-3.0-only`)许可证。贡献须遵守
Toodo 的[贡献者许可协议](../CLA.md),详见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。已归档的
[Dubusoft/dori-mode](https://github.com/Dubusoft/dori-mode) 仓库中发布的代码仍采用 MIT 许可证。

## 从 OmOMeow 迁移

如果你之前用 gist 设置过 OmOMeow 模式，机器人照常能用。改下面四处，它就成了 Dori。

1. **起一个 Dori 名字。** 就叫 "Dori",或者用 Dori 结尾的名字，比如 ShipDori、WorkDori。对智能体说:"从现在起你叫 ShipDori,这是 ShipDori mode。"之后开启模式的说法就从 "OmOMeow mode" 换成 "ShipDori mode"。
2. **把对话搬到 Toodo 聊天。** Dori 只在 Toodo 聊天里对话。原来的机器人和服务器保持原样,Dori 不再读取它们。
3. **安装这个仓库。** 运行上面的一行安装命令，再对智能体说 "ShipDori mode",它就会用这个技能和 `dori` CLI,不再用以前粘贴的提示词。
4. **做一次初次了解。** 如果 OmOMeow 时期没做过，说一句"做一下 onboarding"就行。

原有的线程、话题和记忆都会保留。
